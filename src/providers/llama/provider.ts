import type { ModelProvider, StreamOptions } from "../../model/provider.js";
import {
  combineSystemPrompts,
  type Message,
  type Model,
  type ModelRequest,
  type ProviderId,
  type StreamEvent,
} from "../../model/types.js";
import { serializeToolCallArguments } from "../../tools/arguments.js";
import { readSseData } from "./sse.js";
import { continuationInstruction } from "../continuation.js";

export interface LlamaProviderOptions {
  serverUrl: string;
  modelId: string;
  modelName?: string;
  contextWindow: number;
  maxOutputTokens: number;
}

interface ToolCallDelta {
  readonly index: number;
  readonly id?: string;
  readonly name?: string;
  readonly argumentsPart?: string;
}

interface ParsedChunk {
  readonly content?: string;
  readonly finishReason?: string;
  readonly toolCallDeltas: readonly ToolCallDelta[];
}

interface PendingToolCall {
  id?: string;
  name?: string;
  argumentsText: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseChatChunk(data: string): ParsedChunk {
  const value: unknown = JSON.parse(data);

  if (!isRecord(value)) {
    throw new Error("Invalid llama.cpp stream chunk.");
  }

  const choices = value.choices;

  if (!Array.isArray(choices) || choices.length === 0) {
    return {
      toolCallDeltas: [],
    };
  }

  const choice: unknown = choices[0];

  if (!isRecord(choice)) {
    throw new Error("Invalid llama.cpp stream choice.");
  }

  const delta = choice.delta;

  const content =
    isRecord(delta) && typeof delta.content === "string"
      ? delta.content
      : undefined;

  const finishReason =
    typeof choice.finish_reason === "string" ? choice.finish_reason : undefined;

  const toolCallDeltas: ToolCallDelta[] = [];

  if (isRecord(delta) && delta.tool_calls !== undefined) {
    if (!Array.isArray(delta.tool_calls)) {
      throw new Error("Invalid llama.cpp tool call list.");
    }

    for (const item of delta.tool_calls) {
      if (
        !isRecord(item) ||
        typeof item.index !== "number" ||
        !Number.isInteger(item.index) ||
        item.index < 0
      ) {
        throw new Error("Invalid llama.cpp tool call delta.");
      }

      const fn = item.function;

      const id = typeof item.id === "string" ? item.id : undefined;

      const name =
        isRecord(fn) && typeof fn.name === "string" ? fn.name : undefined;

      let argumentsPart: string | undefined;

      if (isRecord(fn) && fn.arguments !== undefined) {
        argumentsPart =
          typeof fn.arguments === "string"
            ? fn.arguments
            : JSON.stringify(fn.arguments);
      }

      toolCallDeltas.push({
        index: item.index,
        id,
        name,
        argumentsPart,
      });
    }
  }

  return {
    content,
    finishReason,
    toolCallDeltas,
  };
}

function toLlamaMessage(message: Message): Record<string, unknown> {
  if (message.role === "user") {
    return {
      role: "user",
      content: message.content,
    };
  }

  if (message.role === "assistant") {
    return {
      role: "assistant",
      content: message.content,
      tool_calls: message.toolCalls.map((call) => ({
        id: call.id,
        type: "function",
        function: {
          name: call.name,
          arguments: serializeToolCallArguments(call),
        },
      })),
    };
  }

  return {
    role: "tool",
    tool_call_id: message.toolCallId,
    content: message.isError
      ? `Tool execution failed:\n${message.content}`
      : message.content,
  };
}

function toLlamaMessages(request: ModelRequest): Record<string, unknown>[] {
  const instruction = continuationInstruction(request);
  const systemPrompt = combineSystemPrompts(
    request.model.systemPrompt,
    request.systemPrompt,
  );
  return [
    ...(systemPrompt
      ? [
          {
            role: "system",
            content: systemPrompt,
          },
        ]
      : []),
    ...request.messages.map(toLlamaMessage),
    ...(instruction === undefined
      ? []
      : [{ role: "user", content: instruction }]),
  ];
}

export class LlamaProvider implements ModelProvider {
  readonly id: ProviderId = "llama";
  readonly name = "llama.cpp";

  private readonly serverUrl: string;
  private readonly model: Model;

  constructor(options: LlamaProviderOptions) {
    this.serverUrl = options.serverUrl.replace(/\/+$/, "");

    this.model = {
      id: options.modelId,
      name: options.modelName ?? options.modelId,
      provider: this.id,
      contextWindow: options.contextWindow,
      maxOutputTokens: options.maxOutputTokens,
    };
  }

  async listModels(options?: {
    signal?: AbortSignal;
  }): Promise<readonly Model[]> {
    if (options?.signal?.aborted) {
      throw new Error("Model listing aborted.");
    }

    return [this.model];
  }

  async *stream(
    request: ModelRequest,
    options?: StreamOptions,
  ): AsyncIterable<StreamEvent> {
    if (options?.signal?.aborted) {
      yield {
        type: "error",
        reason: "aborted",
        error: new Error("Request aborted."),
      };

      return;
    }

    yield {
      type: "start",
    };

    try {
      const response = await fetch(`${this.serverUrl}/v1/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: request.model.id,
          messages: toLlamaMessages(request),
          tools: request.tools.map((definition) => ({
            type: "function",
            function: {
              name: definition.name,
              description: definition.description,
              parameters: definition.inputSchema,
            },
          })),
          parallel_tool_calls: false,
          max_tokens:
            request.maxOutputTokens ?? request.model.maxOutputTokens,
          stream: true,
        }),
        signal: options?.signal,
      });

      if (!response.ok) {
        const responseBody = await response.text();

        throw new Error(
          `llama.cpp returned HTTP ${response.status}: ${responseBody}`,
        );
      }

      if (!response.body) {
        throw new Error("llama.cpp returned an empty response body.");
      }

      let finishReason: string | undefined;
      const pendingToolCalls = new Map<number, PendingToolCall>();

      for await (const data of readSseData(response.body)) {
        if (data === "[DONE]") {
          if (finishReason === "length" && pendingToolCalls.size > 0) {
            yield {
              type: "done",
              reason: "length",
              incompleteToolCall: true,
            };
            return;
          }

          if (finishReason === "tool_calls" && pendingToolCalls.size === 0) {
            throw new Error(
              "llama.cpp finished with tool_calls but returned no calls.",
            );
          }

          const orderedCalls = [...pendingToolCalls.entries()].sort(
            ([leftIndex], [rightIndex]) => leftIndex - rightIndex,
          );

          for (const [, pending] of orderedCalls) {
            if (!pending.id || !pending.name) {
              throw new Error("llama.cpp returned an incomplete tool call.");
            }

            let argumentsValue: unknown;

            try {
              argumentsValue = JSON.parse(pending.argumentsText || "{}");
            } catch {
              throw new Error(
                `llama.cpp returned invalid arguments for tool ` +
                  `"${pending.name}".`,
              );
            }

            yield {
              type: "tool-call",
              toolCall: {
                id: pending.id,
                name: pending.name,
                arguments: argumentsValue,
              },
            };
          }

          yield {
            type: "done",
            reason:
              pendingToolCalls.size > 0
                ? "tool-call"
                : finishReason === "length"
                  ? "length"
                  : "stop",
          };

          return;
        }

        const chunk = parseChatChunk(data);

        if (chunk.content) {
          yield {
            type: "text-delta",
            delta: chunk.content,
          };
        }

        for (const toolCallDelta of chunk.toolCallDeltas) {
          const pending = pendingToolCalls.get(toolCallDelta.index) ?? {
            argumentsText: "",
          };

          if (toolCallDelta.id !== undefined) {
            pending.id = toolCallDelta.id;
          }

          if (toolCallDelta.name !== undefined) {
            pending.name = toolCallDelta.name;
          }

          if (toolCallDelta.argumentsPart !== undefined) {
            pending.argumentsText += toolCallDelta.argumentsPart;
          }

          pendingToolCalls.set(toolCallDelta.index, pending);
        }

        if (chunk.finishReason !== undefined) {
          finishReason = chunk.finishReason;
        }
      }

      throw new Error("llama.cpp stream ended without [DONE].");
    } catch (error: unknown) {
      const aborted = options?.signal?.aborted === true;

      yield {
        type: "error",
        reason: aborted ? "aborted" : "error",
        error: error instanceof Error ? error : new Error(String(error)),
      };
    }
  }
}
