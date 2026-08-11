import type { OAuthCredential } from "../auth/oauth-contracts.js";
import type { ModelProvider, StreamOptions } from "../model/provider.js";
import type {
  JsonValue,
  Message,
  Model,
  ModelRequest,
  ProviderMessageState,
  StreamEvent,
} from "../model/types.js";
import type { ToolDefinition } from "../tools/types.js";
import { serializeToolCallArguments } from "../tools/arguments.js";
import { readSseData } from "./sse.js";
import { continuationInstruction } from "./continuation.js";

export interface CredentialResolver {
  resolve(signal?: AbortSignal): Promise<OAuthCredential>;
}

export interface OpenAICodexProviderOptions {
  readonly model: Model;
  readonly resolver: CredentialResolver;
  readonly fetch?: typeof fetch;
  readonly baseUrl?: string;
  readonly instructions?: string;
  readonly originator?: string;
}

/**
 * ChatGPT Codex Responses 프로토콜을 기존 ModelProvider 계약으로 번역한다.
 *
 * ChatGPT 전용 URL, header, input item, response event는 이 파일에서 끝난다. Agent는
 * OAuth token도 Responses item도 모르고 기존 Message와 ModelStreamEvent만 사용한다.
 */
export class OpenAICodexProvider implements ModelProvider {
  readonly id = "openai-codex" as const;
  readonly name: string;

  readonly #model: Model;
  readonly #resolver: CredentialResolver;
  readonly #fetch: typeof fetch;
  readonly #endpoint: string;
  readonly #instructions: string | undefined;
  readonly #originator: string;

  constructor(options: OpenAICodexProviderOptions) {
    if (options.model.provider !== this.id) {
      throw new Error(`OpenAI Codex model provider must be "${this.id}".`);
    }
    this.#model = options.model;
    this.name = options.model.name;
    this.#resolver = options.resolver;
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#endpoint = codexResponsesEndpoint(
      options.baseUrl ?? "https://chatgpt.com/backend-api",
    );
    this.#instructions = options.instructions;
    this.#originator = options.originator ?? "pi";
  }

  async listModels(options?: {
    signal?: AbortSignal;
  }): Promise<readonly Model[]> {
    if (options?.signal?.aborted) throw new Error("Model listing aborted.");
    return [this.#model];
  }

  async *stream(
    request: ModelRequest,
    options?: StreamOptions,
  ): AsyncIterable<StreamEvent> {
    yield { type: "start" };

    try {
      if (request.model.provider !== this.id) {
        throw new Error(
          `OpenAICodexProvider cannot run provider ` +
            `"${request.model.provider}".`,
        );
      }

      const instructions = [this.#instructions, request.systemPrompt]
        .filter((value): value is string => value !== undefined)
        .join("\n\n");
      const continuation = continuationInstruction(request);
      const body = JSON.stringify({
        model: request.model.id,
        ...(instructions === ""
          ? {}
          : { instructions }),
        max_output_tokens:
          request.maxOutputTokens ?? request.model.maxOutputTokens,
        input: [
          ...serializeMessages(request.messages),
          ...(continuation === undefined
            ? []
            : [{
                type: "message",
                role: "user",
                content: [{ type: "input_text", text: continuation }],
              }]),
        ],
        tools: request.tools.map(serializeTool),
        tool_choice: "auto",
        parallel_tool_calls: true,
        stream: true,
        store: false,
        include: ["reasoning.encrypted_content"],
      });
      // 로컬 replay 직렬화 검증이 끝난 뒤에만 credential과 network를 사용한다.
      const credential = await this.#resolver.resolve(options?.signal);
      const response = await this.#fetch(this.#endpoint, {
        method: "POST",
        headers: {
          authorization: `Bearer ${credential.accessToken}`,
          "chatgpt-account-id": credential.accountId,
          originator: this.#originator,
          accept: "text/event-stream",
          "content-type": "application/json",
          "openai-beta": "responses=experimental",
          "user-agent": "pi-clone/0.0.0",
        },
        body,
        ...(options?.signal === undefined ? {} : { signal: options.signal }),
      });

      if (!response.ok) {
        // 서버 body 전체는 출력하지 않는다. 단, 구조와 문장이 정확히 일치하는 알려진
        // unsupported-model 오류만 우리가 만든 안전한 안내 문장으로 바꾼다.
        const suffix = await safeHttpErrorSuffix(response, request.model.id);
        throw new Error(
          `OpenAI Codex provider request failed (${response.status})${suffix}`,
        );
      }
      if (response.body === null) {
        throw new Error(
          "OpenAI Codex provider returned an empty response body",
        );
      }

      let sawToolCall = false;
      const reasoningItems = new Map<string, Record<string, JsonValue>>();
      const toolItems = new Map<string, string>();
      const pendingCalls = new Map<number, PendingToolCall>();
      const seenCallIds = new Set<string>();
      for await (const data of readSseData(response.body)) {
        if (data === "[DONE]") break;
        const event = parseEvent(data);
        const type = requireString(event.type, "type");

        if (type === "response.output_text.delta") {
          const delta = requireString(event.delta, "delta");
          yield { type: "text-delta", delta };
          continue;
        }

      if (type === "response.output_item.added") {
        const item = requireRecord(event.item, "item");
        if (item.type !== "function_call") continue;
        const index = requireIndex(event.output_index, "output_index");
        const argumentsValue = optionalString(item.arguments, "item.arguments");
        const callId = requireString(item.call_id, "item.call_id");
        const functionItemId = optionalString(item.id, "item.id");
        if (pendingCalls.has(index) || seenCallIds.has(callId)) {
          throw malformed(`duplicate function call ID "${callId}"`);
        }
        seenCallIds.add(callId);
        if (functionItemId !== undefined) {
          setFunctionItemId(toolItems, callId, functionItemId);
        }
        sawToolCall = true;
        pendingCalls.set(index, {
          id: callId,
          name: requireString(item.name, "item.name"),
          argumentsText: argumentsValue ?? "",
        });
        continue;
      }

      if (type === "response.function_call_arguments.delta") {
        sawToolCall = true;
        const index = requireIndex(event.output_index, "output_index");
        const pending = pendingCalls.get(index);
        if (pending === undefined) {
          throw malformed("function argument delta has no function call");
        }
        pending.argumentsText += requireString(event.delta, "delta");
        continue;
      }

      if (type === "response.function_call_arguments.done") {
        sawToolCall = true;
        const index = requireIndex(event.output_index, "output_index");
        const pending = pendingCalls.get(index);
        if (pending === undefined) {
          throw malformed("final function arguments have no function call");
        }
        setCanonicalArguments(
          pending,
          requireString(event.arguments, "arguments"),
        );
        continue;
      }

      if (type === "response.output_item.done") {
        const item = requireRecord(event.item, "item");
        if (item.type === "reasoning") {
          const replay = parseReasoningItem(item);
          reasoningItems.set(requireString(replay.id, "item.id"), replay);
        } else if (item.type === "function_call") {
          sawToolCall = true;
          recordFinalFunctionItem(
            requireIndex(event.output_index, "output_index"),
            item,
            pendingCalls,
            toolItems,
            seenCallIds,
          );
        }
        continue;
      }

      if (
        type === "response.completed"
        || type === "response.done"
        || type === "response.incomplete"
      ) {
        if (type === "response.incomplete") {
          const incompleteReason = readIncompleteReason(event);

          if (incompleteReason !== "max_output_tokens") {
            throw new Error(
              `OpenAI Codex provider response was incomplete: ` +
                `${incompleteReason ?? "unknown"}.`,
            );
          }

          collectTerminalReasoning(event, reasoningItems);
          const providerState = createProviderState(reasoningItems, toolItems);
          yield {
            type: "done",
            reason: "length",
            providerState,
            ...(sawToolCall || pendingCalls.size > 0
              ? { incompleteToolCall: true }
              : {}),
          };
          return;
        }

        collectTerminalOutput(
          event,
          reasoningItems,
          pendingCalls,
          toolItems,
          seenCallIds,
        );
        // store:false에서는 다음 요청이 이전 output item을 다시 보내야 한다.
        // provider wire metadata를 assistant message와 함께 영속화할 수 있게 전달한다.
        const providerState = createProviderState(reasoningItems, toolItems);
        const hasToolCalls = sawToolCall || pendingCalls.size > 0;
        if (hasToolCalls) yield* completeToolCalls(pendingCalls);
        yield {
          type: "done",
          reason: hasToolCalls ? "tool-call" : "stop",
          providerState,
        };
        return;
      }

      if (type === "error" || type === "response.failed") {
        throw new Error("OpenAI Codex provider stream failed");
      }
      // reasoning delta와 기타 lifecycle event는 현재 화면용 공통 계약에 대응 항목이 없다.
      }
      throw new Error("OpenAI Codex provider stream ended before a terminal event");
    } catch (error: unknown) {
      yield {
        type: "error",
        reason: options?.signal?.aborted ? "aborted" : "error",
        error: error instanceof Error ? error : new Error(String(error)),
      };
    }
  }
}

interface PendingToolCall {
  readonly id: string;
  readonly name: string;
  argumentsText: string;
  finalArgumentsText?: string;
}

function* completeToolCalls(
  calls: ReadonlyMap<number, PendingToolCall>,
): Iterable<StreamEvent> {
  const completedCalls = [...calls.entries()]
    .sort(([left], [right]) => left - right)
    .map(([, call]): StreamEvent => {
      let argumentsValue: unknown;
      try {
        argumentsValue = JSON.parse(
          (call.finalArgumentsText ?? call.argumentsText) || "{}",
        ) as unknown;
      } catch {
        throw malformed(`function call "${call.name}" has invalid arguments`);
      }
      return {
        type: "tool-call",
        toolCall: {
          id: call.id,
          name: call.name,
          arguments: argumentsValue,
        },
      };
    });

  for (const event of completedCalls) {
    yield event;
  }
}

function setCanonicalArguments(
  call: PendingToolCall,
  argumentsText: string,
): void {
  if (
    call.finalArgumentsText !== undefined &&
    call.finalArgumentsText !== argumentsText
  ) {
    throw malformed(`function call "${call.name}" has conflicting final arguments`);
  }

  call.finalArgumentsText = argumentsText;
}

function setFunctionItemId(
  toolItems: Map<string, string>,
  callId: string,
  functionItemId: string,
): void {
  const existing = toolItems.get(callId);

  if (existing !== undefined && existing !== functionItemId) {
    throw malformed(`function call "${callId}" has conflicting item IDs`);
  }

  toolItems.set(callId, functionItemId);
}

function recordFinalFunctionItem(
  index: number,
  item: Record<string, unknown>,
  pendingCalls: Map<number, PendingToolCall>,
  toolItems: Map<string, string>,
  seenCallIds: Set<string>,
): void {
  const callId = requireString(item.call_id, "item.call_id");
  const name = requireString(item.name, "item.name");
  const argumentsText = requireString(item.arguments, "item.arguments");
  const functionItemId = optionalString(item.id, "item.id");
  const pending = pendingCalls.get(index);

  if (pending === undefined) {
    if (seenCallIds.has(callId)) {
      throw malformed(`duplicate function call ID "${callId}"`);
    }

    seenCallIds.add(callId);
    pendingCalls.set(index, {
      id: callId,
      name,
      argumentsText: "",
      finalArgumentsText: argumentsText,
    });
  } else {
    if (pending.id !== callId || pending.name !== name) {
      throw malformed(`final function item at index ${index} does not match its call`);
    }

    setCanonicalArguments(pending, argumentsText);
  }

  if (functionItemId !== undefined) {
    setFunctionItemId(toolItems, callId, functionItemId);
  }
}

function createProviderState(
  reasoningItems: ReadonlyMap<string, Record<string, JsonValue>>,
  toolItems: ReadonlyMap<string, string>,
): ProviderMessageState {
  return {
    provider: "openai-codex",
    value: {
      reasoningItems: [...reasoningItems.values()],
      functionItemIds: Object.fromEntries(toolItems),
    },
  };
}

async function safeHttpErrorSuffix(
  response: Response,
  requestedModel: string,
): Promise<string> {
  if (response.status !== 400) return "";

  let parsed: unknown;
  try {
    parsed = JSON.parse(await response.text()) as unknown;
  } catch {
    return "";
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return "";
  const error = (parsed as Record<string, unknown>).error;
  if (typeof error !== "object" || error === null || Array.isArray(error)) return "";
  const fields = error as Record<string, unknown>;
  const expected = `The '${requestedModel}' model is not supported when using Codex with a ChatGPT account.`;
  if (fields.type !== "invalid_request_error" || fields.message !== expected) return "";

  // 외부 message를 그대로 이어 붙이지 않고 로컬 model 값으로 새 문장을 만든다.
  return `: model "${requestedModel}" is not supported for this ChatGPT account`;
}

function codexResponsesEndpoint(baseUrl: string): string {
  const normalized = baseUrl.replace(/\/+$/, "");
  if (normalized.endsWith("/codex/responses")) return normalized;
  return `${normalized}/codex/responses`;
}

function serializeMessages(
  messages: readonly Message[],
): Record<string, unknown>[] {
  const input: Record<string, unknown>[] = [];
  for (const message of messages) {
    if (message.role === "user") {
      input.push({
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: message.content }],
      });
      continue;
    }
    if (message.role === "tool") {
      input.push({
        type: "function_call_output",
        call_id: message.toolCallId,
        output: message.content,
      });
      continue;
    }

    const replay = readCodexReplay(message);
    // Responses output 순서와 마찬가지로 reasoning을 가시적인 assistant output보다 먼저 둔다.
    input.push(...(replay?.reasoningItems ?? []));
    if (message.content !== "") {
      input.push({
        type: "message",
        role: "assistant",
        content: [{
          type: "output_text",
          text: message.content,
          annotations: [],
        }],
      });
    }
    for (const call of message.toolCalls) {
      const functionItemId = replay !== undefined
        && Object.prototype.hasOwnProperty.call(replay.functionItemIds, call.id)
        ? replay.functionItemIds[call.id]
        : undefined;
      input.push({
        type: "function_call",
        ...(functionItemId === undefined
          ? {}
          : { id: functionItemId }),
        call_id: call.id,
        name: call.name,
        arguments: serializeToolCallArguments(call),
      });
    }
  }
  return input;
}

interface CodexReplay {
  readonly reasoningItems: readonly Record<string, JsonValue>[];
  readonly functionItemIds: Readonly<Record<string, string>>;
}

function readCodexReplay(
  message: Extract<Message, { role: "assistant" }>,
): CodexReplay | undefined {
  const state = message.providerState;

  if (state === undefined) {
    return undefined;
  }

  if (state.provider !== "openai-codex") {
    throw new Error(
      `OpenAI Codex provider cannot serialize assistant state owned by ` +
        `"${state.provider}".`,
    );
  }

  if (!isPlainRecord(state.value)) {
    throw invalidPersistedCodexState();
  }

  const reasoningItems = state.value.reasoningItems;
  const functionItemIds = state.value.functionItemIds;
  if (!Array.isArray(reasoningItems) || !isStringRecord(functionItemIds)) {
    throw invalidPersistedCodexState();
  }

  const parsedReasoning: Record<string, JsonValue>[] = [];
  for (const value of reasoningItems) {
    const reasoning = readReasoningItem(value);
    if (reasoning === undefined) {
      throw invalidPersistedCodexState();
    }
    parsedReasoning.push(reasoning);
  }

  return { reasoningItems: parsedReasoning, functionItemIds };
}

function invalidPersistedCodexState(): Error {
  return new Error("OpenAI Codex provider cannot serialize malformed persisted state.");
}

function readReasoningItem(
  value: unknown,
): Record<string, JsonValue> | undefined {
  if (
    !isPlainRecord(value)
    || value.type !== "reasoning"
    || typeof value.id !== "string"
    || typeof value.encrypted_content !== "string"
    || !Array.isArray(value.summary)
    || !value.summary.every(isJsonValue)
  ) {
    return undefined;
  }

  return {
    type: "reasoning",
    id: value.id,
    summary: value.summary,
    encrypted_content: value.encrypted_content,
  };
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return isPlainRecord(value)
    && Object.values(value).every((item) => typeof item === "string");
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value) as unknown;
  return prototype === Object.prototype || prototype === null;
}

function isJsonValue(value: unknown): value is JsonValue {
  if (
    value === null
    || typeof value === "boolean"
    || typeof value === "string"
  ) {
    return true;
  }
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isJsonValue);
  return isPlainRecord(value) && Object.values(value).every(isJsonValue);
}

function requireJsonValue(value: unknown, field: string): JsonValue {
  if (!isJsonValue(value)) {
    throw malformed(`${field} must contain only JSON-compatible values`);
  }
  return value;
}

function parseReasoningItem(item: Record<string, unknown>): Record<string, JsonValue> {
  const id = requireString(item.id, "item.id");
  const encryptedContent = requireString(
    item.encrypted_content,
    "item.encrypted_content",
  );
  if (!Array.isArray(item.summary)) {
    throw malformed("item.summary must be an array");
  }
  const summary = item.summary.map((value, index) =>
    requireJsonValue(value, `item.summary[${index}]`));
  // raw event 전체가 아니라 store:false 후속 요청에 필요한 opaque item만 보존한다.
  return {
    type: "reasoning",
    id,
    summary,
    encrypted_content: encryptedContent,
  };
}

function collectTerminalReasoning(
  event: Record<string, unknown>,
  target: Map<string, Record<string, JsonValue>>,
): void {
  const response = optionalRecord(event.response, "response");
  const output = response?.output;
  if (output === undefined || output === null) return;
  if (!Array.isArray(output)) throw malformed("response.output must be an array");
  for (const rawItem of output) {
    const item = requireRecord(rawItem, "response.output[]");
    if (item.type !== "reasoning") continue;
    const replay = parseReasoningItem(item);
    target.set(requireString(replay.id, "item.id"), replay);
  }
}

function collectTerminalOutput(
  event: Record<string, unknown>,
  reasoningItems: Map<string, Record<string, JsonValue>>,
  pendingCalls: Map<number, PendingToolCall>,
  toolItems: Map<string, string>,
  seenCallIds: Set<string>,
): void {
  const response = optionalRecord(event.response, "response");
  const output = response?.output;

  if (output === undefined || output === null) {
    return;
  }

  if (!Array.isArray(output)) {
    throw malformed("response.output must be an array");
  }

  for (const [index, rawItem] of output.entries()) {
    const item = requireRecord(rawItem, "response.output[]");

    if (item.type === "reasoning") {
      const replay = parseReasoningItem(item);
      reasoningItems.set(requireString(replay.id, "item.id"), replay);
    } else if (item.type === "function_call") {
      recordFinalFunctionItem(
        index,
        item,
        pendingCalls,
        toolItems,
        seenCallIds,
      );
    }
  }
}

function readIncompleteReason(
  event: Record<string, unknown>,
): string | undefined {
  const response = optionalRecord(event.response, "response");
  const details = optionalRecord(
    response?.incomplete_details,
    "response.incomplete_details",
  );
  return optionalString(details?.reason, "response.incomplete_details.reason");
}

function serializeTool(tool: ToolDefinition): Record<string, unknown> {
  return {
    type: "function",
    name: tool.name,
    description: tool.description,
    parameters: tool.inputSchema,
    strict: false,
  };
}

function parseEvent(data: string): Record<string, unknown> {
  try {
    return requireRecord(JSON.parse(data) as unknown, "event");
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("OpenAI Codex provider")) {
      throw error;
    }
    throw malformed("event must contain JSON");
  }
}

function requireRecord(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw malformed(`${field} must be an object`);
  }
  return value as Record<string, unknown>;
}

function optionalRecord(
  value: unknown,
  field: string,
): Record<string, unknown> | undefined {
  if (value === undefined || value === null) return undefined;
  return requireRecord(value, field);
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== "string") throw malformed(`${field} must be a string`);
  return value;
}

function optionalString(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  return requireString(value, field);
}

function requireIndex(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw malformed(`${field} must be a non-negative integer`);
  }
  return value;
}

function malformed(detail: string): Error {
  return new Error(`OpenAI Codex provider returned a malformed event: ${detail}`);
}
