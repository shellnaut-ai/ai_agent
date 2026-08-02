/**
 * Provider와 Tool 사이를 오가는 값은 JSON으로 직렬화할 수 있어야 한다.
 * SDK 전용 타입을 여기 넣지 않아야 Agent Core가 특정 회사 API에 묶이지 않는다.
 */
export type JsonPrimitive = boolean | number | string | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };

export interface UserMessage {
  readonly id: string;
  readonly role: "user";
  readonly content: string;
  readonly createdAt: string;
}

export interface ToolCall {
  readonly id: string;
  readonly name: string;
  readonly argumentsJson: string;
}

export interface AssistantMessage {
  readonly id: string;
  readonly role: "assistant";
  readonly content: string;
  readonly toolCalls: readonly ToolCall[];
  readonly createdAt: string;
}

export type ToolErrorCode =
  | "execution_error"
  | "invalid_arguments"
  | "invalid_json"
  | "unknown_tool";

export interface ToolResultError {
  readonly code: ToolErrorCode;
  readonly message: string;
}

export interface ToolResultMessage {
  readonly id: string;
  readonly role: "tool";
  readonly toolCallId: string;
  readonly toolName: string;
  readonly ok: boolean;
  readonly content: string;
  readonly error?: ToolResultError;
  readonly createdAt: string;
}

/**
 * 다음 Provider 호출과 세션 replay에 필요한 "확정된 사실"의 합집합이다.
 * 화면용 순간 이벤트인 AgentEvent와 분리해야 저장 형식이 UI 요구에 끌려가지 않는다.
 */
export type Message = UserMessage | AssistantMessage | ToolResultMessage;

export interface ToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: JsonObject;
}

export interface ModelRequest {
  readonly model: string;
  readonly messages: readonly Message[];
  readonly tools: readonly ToolDefinition[];
}

export type FinishReason = "length" | "other" | "stop" | "tool_calls";

/**
 * 각 Provider의 원본 streaming payload를 이 작은 공통 언어로 정규화한다.
 * tool_call_delta.index는 여러 호출의 조각이 섞여 와도 같은 draft에 붙이기 위한 키다.
 */
export type ModelStreamEvent =
  | { readonly type: "text_delta"; readonly delta: string }
  | {
      readonly type: "tool_call_delta";
      readonly index: number;
      readonly id?: string;
      readonly name?: string;
      readonly argumentsDelta?: string;
    }
  | { readonly type: "finish"; readonly reason: FinishReason };

export interface ProviderCallOptions {
  /**
   * 미래 abort 전달을 위한 자리만 예약한다.
   * 첫 수직 슬라이스는 signal을 만들거나 실제 요청을 중단하지 않는다.
   */
  readonly signal?: AbortSignal;
}

/** Agent가 구체적인 HTTP/SDK 형식을 모르도록 만드는 모델 호출 경계다. */
export interface ModelProvider {
  stream(
    request: ModelRequest,
    options?: ProviderCallOptions,
  ): AsyncIterable<ModelStreamEvent>;
}

export interface ToolExecution {
  readonly content: string;
  readonly details?: JsonValue;
}

export interface AgentTool<TArguments = unknown> extends ToolDefinition {
  /** 모델이 만든 unknown 입력을 도구별 안전한 인자 타입으로 바꾼다. */
  parse(argumentsValue: unknown): TArguments;
  execute(argumentsValue: TArguments): Promise<ToolExecution>;
}

/**
 * 구독자가 진행 상황을 관찰하는 실시간 사건이다.
 * Message와 달리 text_delta 같은 중간 상태를 포함하며, 기본 세션 원본에는 저장하지 않는다.
 */
export type AgentEvent =
  | { readonly type: "agent_start"; readonly userMessage: UserMessage }
  | { readonly type: "turn_start"; readonly turn: number }
  | { readonly type: "message_start"; readonly messageId: string }
  | { readonly type: "text_delta"; readonly messageId: string; readonly delta: string }
  | {
      readonly type: "tool_call_delta";
      readonly messageId: string;
      readonly index: number;
      readonly argumentsDelta?: string;
    }
  | { readonly type: "message_end"; readonly message: AssistantMessage }
  | { readonly type: "tool_execution_start"; readonly toolCall: ToolCall }
  | { readonly type: "tool_execution_end"; readonly result: ToolResultMessage }
  | {
      readonly type: "turn_end";
      readonly turn: number;
      readonly toolResults: readonly ToolResultMessage[];
    }
  | { readonly type: "agent_end"; readonly messages: readonly Message[] }
  | { readonly type: "agent_error"; readonly error: Error };

export type AgentEventListener = (event: AgentEvent) => void;

/**
 * JSONL 한 줄에 기록되는 append-only 단위다.
 * 나중에 record 종류를 늘릴 수 있지만 기존 줄을 덮어쓰지 않는 것이 핵심 계약이다.
 */
export type SessionRecord =
  | { readonly type: "session_started"; readonly sessionId: string; readonly createdAt: string }
  | { readonly type: "message_appended"; readonly message: Message }
  | { readonly type: "run_finished"; readonly createdAt: string };

export interface SessionStore {
  append(record: SessionRecord): Promise<void>;
  replay(): AsyncIterable<SessionRecord>;
}

