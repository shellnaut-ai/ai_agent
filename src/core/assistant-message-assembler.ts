import type {
  AssistantMessage,
  ModelStreamEvent,
  ToolCall,
} from "./contracts.js";

interface AssistantMessageIdentity {
  readonly id: string;
  readonly createdAt: string;
}

interface ToolCallDraft {
  id?: string;
  name?: string;
  argumentsJson: string;
}

/**
 * Provider가 잘게 보낸 text/tool-call delta를 하나의 확정 AssistantMessage로 조립한다.
 *
 * Provider는 전송 형식 번역만 맡고, "메시지가 언제 완성되는가"는 Agent 계층이 소유한다.
 * 그래서 ScriptedProvider와 실제 OpenAI adapter가 동일한 조립 경로를 검증할 수 있다.
 */
export class AssistantMessageAssembler {
  readonly #identity: AssistantMessageIdentity;
  readonly #toolCalls = new Map<number, ToolCallDraft>();
  #content = "";

  constructor(identity: AssistantMessageIdentity) {
    this.#identity = identity;
  }

  apply(event: ModelStreamEvent): void {
    if (event.type === "text_delta") {
      this.#content += event.delta;
      return;
    }

    if (event.type !== "tool_call_delta") {
      return;
    }

    // index별 draft를 유지하면 복수 tool call의 인자 조각이 교차해도 서로 섞이지 않는다.
    const draft = this.#toolCalls.get(event.index) ?? { argumentsJson: "" };
    if (event.id !== undefined) {
      draft.id = event.id;
    }
    if (event.name !== undefined) {
      draft.name = event.name;
    }
    if (event.argumentsDelta !== undefined) {
      draft.argumentsJson += event.argumentsDelta;
    }
    this.#toolCalls.set(event.index, draft);
  }

  finalize(): AssistantMessage {
    // 모델이 선언한 source index 순서가 실제 도구 실행 순서의 기준이 된다.
    const toolCalls: ToolCall[] = [...this.#toolCalls.entries()]
      .sort(([left], [right]) => left - right)
      .map(([index, draft]) => {
        if (draft.id === undefined || draft.name === undefined) {
          // 불완전한 호출을 내부 ToolCall로 위장시키지 않고 조립 경계에서 즉시 거부한다.
          throw new Error(`Tool call at index ${index} is missing an id or name`);
        }

        return {
          id: draft.id,
          name: draft.name,
          argumentsJson: draft.argumentsJson,
        };
      });

    return {
      id: this.#identity.id,
      role: "assistant",
      content: this.#content,
      toolCalls,
      createdAt: this.#identity.createdAt,
    };
  }
}

