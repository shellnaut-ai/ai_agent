import type { ModelProvider, StreamOptions } from "../../model/provider.js";
import {
  ContextOverflowError,
  isContextOverflowMessage,
  ModelHttpError,
} from "../../model/errors.js";
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
  readonly errorMessage?: string;
  readonly toolCallDeltas: readonly ToolCallDelta[];
}

interface PendingToolCall {
  id?: string;
  name?: string;
  argumentsText: string;
}

const MAX_LLAMA_ERROR_BODY_BYTES = 4_096;
const MAX_LLAMA_ERROR_DETAIL_CHARS = 280;
const LLAMA_CONTEXT_OVERFLOW_MESSAGE =
  "llama.cpp context window exceeded.";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readErrorMessage(value: Record<string, unknown>): string | undefined {
  let rawMessage: string | undefined;

  if (typeof value.error === "string") {
    rawMessage = value.error;
  } else if (isRecord(value.error) && typeof value.error.message === "string") {
    rawMessage = value.error.message;
  } else if (typeof value.message === "string") {
    rawMessage = value.message;
  }

  if (rawMessage === undefined) {
    return undefined;
  }

  return sanitizeErrorMessage(rawMessage);
}

function sanitizeErrorMessage(message: string): string {
  const normalized = message
    .replace(/[\u0000-\u001f\u007f-\u009f]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim()
    .replace(/\bBearer\s+[^\s,;]+/giu, "Bearer [REDACTED]")
    .replace(
      /\beyJ[A-Za-z0-9_-]*\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/gu,
      "[REDACTED]",
    )
    .replace(/\bsk-[A-Za-z0-9_-]{4,}\b/giu, "[REDACTED]")
    .replace(
      /\b(access[_-]?token|refresh[_-]?token|api[_-]?key|client[_-]?secret|cookie|set-cookie|session(?:[_-]?id)?)\s*[:=]\s*(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,;]+)/giu,
      "$1=[REDACTED]",
    );

  return normalized.length <= MAX_LLAMA_ERROR_DETAIL_CHARS
    ? normalized
    : normalized.slice(0, MAX_LLAMA_ERROR_DETAIL_CHARS - 3) + "...";
}

function createLlamaServerError(
  message: string | undefined,
  options?: {
    readonly status?: number;
    readonly operation?: "request" | "input token count request";
  },
): Error {
  if (message !== undefined && isContextOverflowMessage(message)) {
    return new ContextOverflowError(LLAMA_CONTEXT_OVERFLOW_MESSAGE);
  }

  const operation = options?.operation ?? "stream";
  const prefix = options?.status === undefined
    ? `llama.cpp ${operation} error`
    : `llama.cpp ${operation} failed (${options.status})`;
  const safeMessage = prefix +
    (message === undefined || message.length === 0 ? "" : `: ${message}`);

  return options?.status === undefined
    ? new Error(safeMessage)
    : new ModelHttpError(options.status, safeMessage);
}

async function readHttpErrorMessage(
  response: Response,
): Promise<string | undefined> {
  const body = await readBoundedHttpErrorBody(response);
  if (body === undefined) return undefined;

  let value: unknown;
  try {
    value = JSON.parse(body) as unknown;
  } catch {
    return undefined;
  }

  return isRecord(value) ? readErrorMessage(value) : undefined;
}

async function readBoundedHttpErrorBody(
  response: Response,
): Promise<string | undefined> {
  const declaredLength = response.headers.get("content-length");
  if (declaredLength !== null) {
    const bytes = Number(declaredLength);
    if (Number.isFinite(bytes) && bytes > MAX_LLAMA_ERROR_BODY_BYTES) {
      await response.body?.cancel().catch(() => undefined);
      return undefined;
    }
  }

  if (response.body === null) return undefined;
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value === undefined || value.byteLength === 0) continue;

      totalBytes += value.byteLength;
      if (totalBytes > MAX_LLAMA_ERROR_BODY_BYTES) {
        await reader.cancel().catch(() => undefined);
        return undefined;
      }
      chunks.push(value);
    }
  } catch {
    await reader.cancel().catch(() => undefined);
    return undefined;
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }

  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return undefined;
  }
}

function parseChatChunk(data: string): ParsedChunk {
  let value: unknown;

  try {
    value = JSON.parse(data) as unknown;
  } catch {
    throw new Error("Invalid llama.cpp stream chunk.");
  }

  if (!isRecord(value)) {
    throw new Error("Invalid llama.cpp stream chunk.");
  }

  const errorMessage = readErrorMessage(value);
  if (errorMessage !== undefined) {
    return {
      errorMessage,
      toolCallDeltas: [],
    };
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

function toLlamaRequestBody(
  request: ModelRequest,
  stream: boolean,
): Record<string, unknown> {
  return {
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
    max_tokens: request.maxOutputTokens ?? request.model.maxOutputTokens,
    ...(stream ? { stream: true } : {}),
  };
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

  async countInputTokens(
    request: ModelRequest,
    options?: StreamOptions,
  ): Promise<number> {
    if (options?.signal?.aborted) {
      throw new Error("Request aborted.");
    }

    const response = await fetch(
      this.serverUrl + "/v1/chat/completions/input_tokens",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(toLlamaRequestBody(request, false)),
        signal: options?.signal,
      },
    );

    if (!response.ok) {
      throw createLlamaServerError(
        await readHttpErrorMessage(response),
        {
          status: response.status,
          operation: "input token count request",
        },
      );
    }

    let value: unknown;
    try {
      value = await response.json() as unknown;
    } catch {
      throw new Error("llama.cpp returned an invalid input token count.");
    }
    if (
      !isRecord(value) ||
      typeof value.input_tokens !== "number" ||
      !Number.isInteger(value.input_tokens) ||
      value.input_tokens < 0
    ) {
      throw new Error("llama.cpp returned an invalid input token count.");
    }

    return value.input_tokens;
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
        body: JSON.stringify(toLlamaRequestBody(request, true)),
        signal: options?.signal,
      });

      if (!response.ok) {
        throw createLlamaServerError(
          await readHttpErrorMessage(response),
          { status: response.status, operation: "request" },
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

        if (chunk.errorMessage !== undefined) {
          throw createLlamaServerError(chunk.errorMessage);
        }

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
