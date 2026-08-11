import type { ModelProvider, StreamOptions } from "../model/provider.js";
import type {
  Message,
  Model,
  ModelRequest,
  StreamEvent,
} from "../model/types.js";
import type { ToolDefinition } from "../tools/types.js";
import { serializeToolCallArguments } from "../tools/arguments.js";
import { readSseData } from "./sse.js";
import { continuationInstruction } from "./continuation.js";

export interface OpenAICompatibleProviderOptions {
  readonly baseUrl: string;
  readonly apiKey?: string;
  readonly fetch?: typeof fetch;
  readonly model: Model;
  readonly name?: string;
}

interface PendingToolCall {
  id?: string;
  name?: string;
  argumentsText: string;
}

export class OpenAICompatibleProvider implements ModelProvider {
  readonly id = "openai-compatible" as const;
  readonly name: string;

  private readonly endpoint: string;
  private readonly request: typeof fetch;
  private readonly model: Model;
  private readonly apiKey: string | undefined;

  constructor(options: OpenAICompatibleProviderOptions) {
    if (options.model.provider !== this.id) {
      throw new Error(
        `OpenAI-compatible model provider must be "${this.id}".`,
      );
    }

    this.endpoint =
      `${options.baseUrl.replace(/\/+$/, "")}/chat/completions`;
    this.request = options.fetch ?? globalThis.fetch;
    this.model = options.model;
    this.apiKey = options.apiKey;
    this.name = options.name ?? "OpenAI-compatible";
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
    yield { type: "start" };

    try {
      if (options?.signal?.aborted) {
        throw new Error("Request aborted.");
      }
      if (request.model.provider !== this.id) {
        throw new Error(
          `OpenAICompatibleProvider cannot run provider ` +
            `"${request.model.provider}".`,
        );
      }

      const headers: Record<string, string> = {
        "content-type": "application/json",
      };
      const instruction = continuationInstruction(request);
      if (this.apiKey !== undefined) {
        headers.authorization = `Bearer ${this.apiKey}`;
      }

      const response = await this.request(this.endpoint, {
        method: "POST",
        headers,
        body: JSON.stringify({
          model: request.model.id,
          stream: true,
          messages: [
            ...(request.systemPrompt === undefined
              ? []
              : [{ role: "system", content: request.systemPrompt }]),
            ...request.messages.map(serializeMessage),
            ...(instruction === undefined
              ? []
              : [{ role: "user", content: instruction }]),
          ],
          tools: request.tools.map(serializeTool),
          max_tokens:
            request.maxOutputTokens ?? request.model.maxOutputTokens,
        }),
        signal: options?.signal,
      });

      if (!response.ok) {
        throw new Error(
          `OpenAI-compatible provider request failed (${response.status})`,
        );
      }
      if (response.body === null) {
        throw new Error(
          "OpenAI-compatible provider returned an empty response body.",
        );
      }

      const pending = new Map<number, PendingToolCall>();
      for await (const data of readSseData(response.body)) {
        if (data === "[DONE]") {
          throw new Error(
            "OpenAI-compatible stream ended without a finish reason.",
          );
        }

        let parsed: unknown;
        try {
          parsed = JSON.parse(data) as unknown;
        } catch {
          throw malformed("event data must be valid JSON");
        }

        const root = requireRecord(parsed, "chunk");
        const choices = requireArray(root.choices, "choices");
        for (const rawChoice of choices) {
          const choice = requireRecord(rawChoice, "choice");
          const delta = optionalRecord(choice.delta, "choice.delta");

          if (delta?.content !== undefined && delta.content !== null) {
            if (typeof delta.content !== "string") {
              throw malformed("choice.delta.content must be a string");
            }
            yield { type: "text-delta", delta: delta.content };
          }

          const calls = optionalArray(
            delta?.tool_calls,
            "choice.delta.tool_calls",
          );
          for (const rawCall of calls) {
            const call = requireRecord(rawCall, "tool call");
            if (
              !Number.isInteger(call.index) ||
              (call.index as number) < 0
            ) {
              throw malformed("tool call index must be non-negative");
            }
            const index = call.index as number;
            const current = pending.get(index) ?? { argumentsText: "" };
            if (call.id !== undefined) {
              current.id = requireString(call.id, "tool call id");
            }
            const fn = optionalRecord(call.function, "tool call function");
            if (fn?.name !== undefined) {
              current.name = requireString(fn.name, "tool call name");
            }
            if (fn?.arguments !== undefined) {
              current.argumentsText += requireString(
                fn.arguments,
                "tool call arguments",
              );
            }
            pending.set(index, current);
          }

          if (choice.finish_reason !== undefined && choice.finish_reason !== null) {
            const reason = requireString(
              choice.finish_reason,
              "finish reason",
            );
            if (reason === "tool_calls") {
              yield* completeToolCalls(pending);
              yield { type: "done", reason: "tool-call" };
            } else {
              yield {
                type: "done",
                reason: reason === "length" ? "length" : "stop",
                ...(reason === "length" && pending.size > 0
                  ? { incompleteToolCall: true }
                  : {}),
              };
            }
            return;
          }
        }
      }

      throw new Error(
        "OpenAI-compatible stream ended without a terminal event.",
      );
    } catch (error: unknown) {
      yield {
        type: "error",
        reason: options?.signal?.aborted ? "aborted" : "error",
        error: error instanceof Error ? error : new Error(String(error)),
      };
    }
  }
}

function serializeMessage(message: Message): Record<string, unknown> {
  if (message.role === "user") {
    return { role: "user", content: message.content };
  }
  if (message.role === "tool") {
    return {
      role: "tool",
      tool_call_id: message.toolCallId,
      content: message.content,
    };
  }
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

function serializeTool(tool: ToolDefinition): Record<string, unknown> {
  return {
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.inputSchema,
    },
  };
}

function* completeToolCalls(
  pending: ReadonlyMap<number, PendingToolCall>,
): Iterable<StreamEvent> {
  if (pending.size === 0) {
    throw malformed("tool_calls finish reason had no tool calls");
  }

  for (const [, call] of [...pending.entries()].sort(
    ([left], [right]) => left - right,
  )) {
    if (call.id === undefined || call.name === undefined) {
      throw malformed("tool call is missing id or name");
    }
    let argumentsValue: unknown;
    try {
      argumentsValue = JSON.parse(call.argumentsText || "{}") as unknown;
    } catch {
      throw malformed(`tool "${call.name}" returned invalid arguments`);
    }
    yield {
      type: "tool-call",
      toolCall: {
        id: call.id,
        name: call.name,
        arguments: argumentsValue,
      },
    };
  }
}

function malformed(detail: string): Error {
  return new Error(
    `OpenAI-compatible provider returned a malformed chunk: ${detail}`,
  );
}

function requireRecord(
  value: unknown,
  path: string,
): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw malformed(`${path} must be an object`);
  }
  return value as Record<string, unknown>;
}

function optionalRecord(
  value: unknown,
  path: string,
): Record<string, unknown> | undefined {
  if (value === undefined || value === null) return undefined;
  return requireRecord(value, path);
}

function requireArray(value: unknown, path: string): readonly unknown[] {
  if (!Array.isArray(value)) throw malformed(`${path} must be an array`);
  return value;
}

function optionalArray(value: unknown, path: string): readonly unknown[] {
  if (value === undefined || value === null) return [];
  return requireArray(value, path);
}

function requireString(value: unknown, path: string): string {
  if (typeof value !== "string") {
    throw malformed(`${path} must be a string`);
  }
  return value;
}
