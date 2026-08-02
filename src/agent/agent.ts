import { randomUUID } from "node:crypto";

import { AssistantMessageAssembler } from "../core/assistant-message-assembler.js";
import type {
  AgentEvent,
  AgentEventListener,
  Message,
  ModelProvider,
  SessionStore,
  UserMessage,
} from "../core/contracts.js";
import { ToolRegistry } from "../tools/tool-registry.js";

export type MessageIdKind = "assistant" | "user";

export interface AgentOptions {
  readonly sessionId: string;
  readonly model: string;
  readonly provider: ModelProvider;
  readonly tools: ToolRegistry;
  readonly session: SessionStore;
  readonly createMessageId?: (kind: MessageIdKind) => string;
  readonly now?: () => string;
}

/**
 * Provider, message assembler, ToolRegistry, SessionStore를 한 run으로 연결하는 중심 조정자다.
 *
 * Agent는 외부 API payload나 파일 읽기 세부사항을 직접 알지 않는다. 대신 각 경계의 공통
 * 계약을 이어 붙이고, 진행 상황을 AgentEvent로 발행하며 확정된 Message만 세션에 기록한다.
 */
export class Agent {
  readonly #sessionId: string;
  readonly #model: string;
  readonly #provider: ModelProvider;
  readonly #tools: ToolRegistry;
  readonly #session: SessionStore;
  readonly #createMessageId: (kind: MessageIdKind) => string;
  readonly #now: () => string;
  readonly #listeners = new Set<AgentEventListener>();
  readonly #messages: Message[] = [];
  #sessionStarted = false;

  constructor(options: AgentOptions) {
    this.#sessionId = options.sessionId;
    this.#model = options.model;
    this.#provider = options.provider;
    this.#tools = options.tools;
    this.#session = options.session;
    // 시간과 ID 생성을 주입 가능하게 두면 테스트 결과가 매번 동일해진다.
    this.#createMessageId = options.createMessageId ?? (() => randomUUID());
    this.#now = options.now ?? (() => new Date().toISOString());
  }

  /** UI나 CLI가 내부 상태를 직접 읽지 않고 run의 순간 변화를 관찰하는 통로다. */
  subscribe(listener: AgentEventListener): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  async prompt(content: string): Promise<readonly Message[]> {
    // prompt 한 번은 user message 하나에서 시작하는 Agent run 하나다.
    const userMessage: UserMessage = {
      id: this.#createMessageId("user"),
      role: "user",
      content,
      createdAt: this.#now(),
    };

    try {
      await this.#startSessionIfNeeded();
      await this.#persistMessage(userMessage);
      this.#emit({ type: "agent_start", userMessage });

      let turn = 0;
      // 첫 학습 slice는 "도구 batch 1회 + 최종 답변 1회"만 허용한다.
      // 이 boolean이 일반적인 maxTurns 대신 현재 범위를 가장 직접적으로 표현한다.
      let hasExecutedToolBatch = false;
      while (true) {
        turn += 1;
        this.#emit({ type: "turn_start", turn });

        // Provider delta는 바로 Message가 아니므로 turn마다 새 assembler에서 조립한다.
        const messageId = this.#createMessageId("assistant");
        const assembler = new AssistantMessageAssembler({
          id: messageId,
          createdAt: this.#now(),
        });
        this.#emit({ type: "message_start", messageId });

        for await (const event of this.#provider.stream({
          model: this.#model,
          // Provider가 Agent의 mutable 배열을 보관하지 못하도록 현재 snapshot을 넘긴다.
          messages: [...this.#messages],
          tools: this.#tools.definitions,
        })) {
          assembler.apply(event);
          // 조립과 별개로 delta를 즉시 알려야 UI가 완성 시점까지 기다리지 않고 표시할 수 있다.
          if (event.type === "text_delta") {
            this.#emit({ type: "text_delta", messageId, delta: event.delta });
          }
          if (event.type === "tool_call_delta") {
            this.#emit({
              type: "tool_call_delta",
              messageId,
              index: event.index,
              ...(event.argumentsDelta === undefined
                ? {}
                : { argumentsDelta: event.argumentsDelta }),
            });
          }
        }

        // stream이 끝난 뒤에만 draft를 확정 Message로 바꾸고, 세션 append 후 상태에 넣는다.
        const assistantMessage = assembler.finalize();
        if (hasExecutedToolBatch && assistantMessage.toolCalls.length > 0) {
          // follow-up tool call을 허용하면 세 번째 Provider turn으로 무한히 이어질 수 있다.
          // retry/maxTurns 정책이 없는 첫 단계에서는 조용히 반복하지 않고 명시적으로 실패한다.
          throw new Error(
            "The follow-up assistant response must be final text without tool calls",
          );
        }
        await this.#persistMessage(assistantMessage);
        this.#emit({ type: "message_end", message: assistantMessage });

        if (assistantMessage.toolCalls.length === 0) {
          // tool call이 없다는 것은 모델이 사용자에게 줄 최종 답을 만들었다는 종료 조건이다.
          this.#emit({ type: "turn_end", turn, toolResults: [] });
          await this.#session.append({ type: "run_finished", createdAt: this.#now() });
          const messages = [...this.#messages];
          this.#emit({ type: "agent_end", messages });
          return messages;
        }

        // 한 assistant가 만든 모든 호출을 하나의 batch로 실행하고 시작/끝을 이벤트로 중계한다.
        const toolResults = await this.#tools.executeBatch(assistantMessage.toolCalls, {
          onStart: (toolCall) => {
            this.#emit({ type: "tool_execution_start", toolCall });
          },
          onEnd: (result) => {
            this.#emit({ type: "tool_execution_end", result });
          },
        });

        for (const result of toolResults) {
          // ToolResult도 Message이므로 다음 Provider 호출이 실행 결과를 문맥으로 읽을 수 있다.
          await this.#persistMessage(result);
        }
        // 모든 결과가 문맥에 들어간 뒤부터 다음 assistant는 반드시 최종 text여야 한다.
        hasExecutedToolBatch = true;
        this.#emit({ type: "turn_end", turn, toolResults });
      }
    } catch (error: unknown) {
      // 외부 경계의 unknown throw를 Error 하나로 정규화해 구독자와 호출자가 같은 실패를 본다.
      const normalizedError = error instanceof Error ? error : new Error(String(error));
      this.#emit({ type: "agent_error", error: normalizedError });
      throw normalizedError;
    }
  }

  async #startSessionIfNeeded(): Promise<void> {
    if (this.#sessionStarted) {
      return;
    }
    await this.#session.append({
      type: "session_started",
      sessionId: this.#sessionId,
      createdAt: this.#now(),
    });
    // session_started가 실제로 기록된 뒤에만 플래그를 바꿔 중복 또는 유실을 피한다.
    this.#sessionStarted = true;
  }

  async #persistMessage(message: Message): Promise<void> {
    // 디스크 기록을 먼저 확정해야 실패한 메시지가 다음 Provider context에만 남는 일이 없다.
    // 이 순서는 in-memory history와 JSONL replay가 같은 확정 상태를 보게 하는 durability 경계다.
    await this.#session.append({ type: "message_appended", message });
    this.#messages.push(message);
  }

  #emit(event: AgentEvent): void {
    // Agent는 렌더링 방식을 모르고, 등록된 모든 구독자에게 동일한 사건만 전달한다.
    for (const listener of this.#listeners) {
      listener(event);
    }
  }
}
