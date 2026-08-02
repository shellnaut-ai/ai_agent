import type {
  FinishReason,
  Message,
  ModelProvider,
  ModelRequest,
  ModelStreamEvent,
  ProviderCallOptions,
  ToolDefinition,
} from "../core/contracts.js";
import { readSseData } from "./sse.js";

export interface OpenAICompatibleProviderOptions {
  readonly baseUrl: string;
  readonly apiKey?: string;
  /** 실제 fetch 대신 테스트 double을 넣을 수 있어 자격증명 없이 adapter를 검증한다. */
  readonly fetch: typeof fetch;
}

/**
 * OpenAI Chat Completions 호환 요청/스트림을 프로젝트의 공통 계약으로 번역한다.
 *
 * 이 클래스 밖으로 choices/delta/function 같은 공급자 전용 구조가 새지 않게 하는 것이
 * 핵심이다. 나중에 Anthropic adapter를 추가해도 Agent Loop는 ModelStreamEvent만 본다.
 */
export class OpenAICompatibleProvider implements ModelProvider {
  private readonly endpoint: string;

  constructor(private readonly options: OpenAICompatibleProviderOptions) {
    this.endpoint = `${options.baseUrl.replace(/\/+$/, "")}/chat/completions`;
  }

  async *stream(
    request: ModelRequest,
    _options?: ProviderCallOptions,
  ): AsyncIterable<ModelStreamEvent> {
    // 인증이 없는 로컬 호환 서버도 지원하므로 apiKey가 있을 때만 헤더를 넣는다.
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (this.options.apiKey !== undefined) headers.authorization = `Bearer ${this.options.apiKey}`;

    const response = await this.options.fetch(new Request(this.endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify({
        model: request.model,
        stream: true,
        messages: request.messages.map(serializeMessage),
        tools: request.tools.map(serializeTool),
      }),
    }));

    if (!response.ok) {
      const detail = await response.text();
      const suffix = detail === "" ? "" : `: ${detail}`;
      throw new Error(
        `OpenAI-compatible provider request failed: ${response.status} ${response.statusText}${suffix}`,
      );
    }
    if (response.body === null) throw new Error("OpenAI-compatible provider returned an empty response body");

    // HTTP transport와 내부 stream event의 경계를 여기서 끊는다.
    for await (const data of readSseData(response.body)) {
      if (data === "[DONE]") return;
      let chunk: unknown;
      try {
        chunk = JSON.parse(data) as unknown;
      } catch {
        throw new Error("OpenAI-compatible provider returned invalid SSE JSON");
      }
      yield* normalizeChunk(chunk);
    }
  }
}

function serializeMessage(message: Message): Record<string, unknown> {
  // 공통 Message의 discriminated union을 외부 API role 형식으로 한 곳에서만 변환한다.
  if (message.role === "user") return { role: "user", content: message.content };
  if (message.role === "tool") {
    return { role: "tool", tool_call_id: message.toolCallId, content: message.content };
  }
  return {
    role: "assistant",
    content: message.content,
    tool_calls: message.toolCalls.map((call) => ({
      id: call.id,
      type: "function",
      function: { name: call.name, arguments: call.argumentsJson },
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

function* normalizeChunk(chunk: unknown): Iterable<ModelStreamEvent> {
  // JSON.parse 성공은 타입 안전을 뜻하지 않으므로 모든 필드를 unknown에서 좁힌다.
  const root = requireRecord(chunk, "chunk");
  const choices = optionalArray(root.choices, "choices");

  for (const rawChoice of choices) {
    const choice = requireRecord(rawChoice, "choice");
    const delta = optionalRecord(choice.delta, "choice.delta");

    // tool-call 전용 chunk의 content:null은 정상이다. null은 text "null"로 바꾸지 않는다.
    if (delta !== undefined && delta.content !== undefined && delta.content !== null) {
      if (typeof delta.content !== "string") {
        throw malformed("choice.delta.content must be a string or null");
      }
      yield { type: "text_delta", delta: delta.content };
    }

    const toolCalls = optionalArray(delta?.tool_calls, "choice.delta.tool_calls");
    for (const rawToolCall of toolCalls) {
      const toolCall = requireRecord(rawToolCall, "choice.delta.tool_calls[]");
      if (!Number.isInteger(toolCall.index) || (toolCall.index as number) < 0) {
        throw malformed("choice.delta.tool_calls[].index must be a non-negative integer");
      }
      const id = optionalString(toolCall.id, "choice.delta.tool_calls[].id");
      const fn = optionalRecord(toolCall.function, "choice.delta.tool_calls[].function");
      const name = optionalString(fn?.name, "choice.delta.tool_calls[].function.name");
      const argumentsDelta = optionalString(
        fn?.arguments,
        "choice.delta.tool_calls[].function.arguments",
      );
      yield {
        type: "tool_call_delta",
        index: toolCall.index as number,
        ...(id === undefined ? {} : { id }),
        ...(name === undefined ? {} : { name }),
        ...(argumentsDelta === undefined ? {} : { argumentsDelta }),
      };
    }

    if (choice.finish_reason !== undefined && choice.finish_reason !== null) {
      if (typeof choice.finish_reason !== "string") {
        throw malformed("choice.finish_reason must be a string or null");
      }
      yield { type: "finish", reason: normalizeFinishReason(choice.finish_reason) };
    }
  }
}

function malformed(detail: string): Error {
  // 모든 구조 오류가 같은 provider boundary 문맥을 갖게 해 상위 계층의 진단을 단순화한다.
  return new Error(`OpenAI-compatible provider returned a malformed chunk: ${detail}`);
}

/** unknown 값이 배열이 아닌 일반 JSON object인지 확인하는 가장 작은 runtime guard다. */
function requireRecord(value: unknown, path: string): Record<string, unknown> {
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

function optionalArray(value: unknown, path: string): readonly unknown[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw malformed(`${path} must be an array`);
  return value;
}

function optionalString(value: unknown, path: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") throw malformed(`${path} must be a string`);
  return value;
}

function normalizeFinishReason(reason: string): FinishReason {
  if (reason === "length" || reason === "stop" || reason === "tool_calls") return reason;
  return "other";
}
