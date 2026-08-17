# Context Compaction과 llama.cpp Overflow 학습 노트

이 문서는 현재 AI Agent 프로젝트의 이번 주 구현을 코드 중심으로 정리합니다.
원본 pi에서 가져온 핵심 원칙은 다음과 같습니다.

1. 실제 모델 요청의 입력 토큰을 가능한 정확히 계산합니다.
2. context overflow는 일반 네트워크 재시도와 구분합니다.
3. overflow이면 오래된 문맥을 요약한 뒤 같은 요청을 한 번만 다시 시도합니다.
4. JSONL 원본 기록은 보존하고, CompactionEntry가 모델에 보낼 활성 경로만 바꿉니다.

## 전체 흐름

~~~text
사용자 입력
  -> ContextCoordinator: 예산 검사
  -> ChatSession / AgentLoop: 모델 스트림
  -> llama.cpp overflow?
       아니오 -> 최종 메시지 저장
       예 -> CompactionEntry 저장 -> 활성 문맥 재구성 -> 한 번 재시도
~~~

## Task 1. llama.cpp 정확한 토큰 수와 overflow 분류

### 핵심 개념

문자 수를 4로 나누는 추정은 빠르지만 chat template과 tools의 실제 토큰 수를 반영하지 못합니다.
llama.cpp input token endpoint에는 실제 chat request와 같은 messages, tools, max_tokens를 보냅니다.
Provider마다 이 endpoint가 있는 것은 아니므로, 공통 필수 메서드가 아닌 선택 capability로 만들었습니다.

### 볼 파일

- src/model/errors.ts
- src/model/provider.ts
- src/model/runtime.ts
- src/providers/llama/provider.ts

### 1) overflow를 의미 있는 오류 타입으로 변환

~~~ts
export class ContextOverflowError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ContextOverflowError";
  }
}

export function isContextOverflowError(
  error: unknown,
): error is ContextOverflowError {
  return error instanceof ContextOverflowError;
}
~~~

단순 Error 문자열만 전달하면 retry 계층은 timeout과 overflow를 구분할 수 없습니다.
Provider가 llama.cpp 오류 문구를 이 타입으로 바꾸므로 이후 계층은 서버 문구를 알 필요가 없습니다.

### 2) 선택 capability

~~~ts
export interface ModelInputTokenCounter {
  countInputTokens(
    request: ModelRequest,
    options?: StreamOptions,
  ): Promise<number>;
}

export function isModelInputTokenCounter(
  provider: ModelProvider,
): provider is ModelProvider & ModelInputTokenCounter {
  return typeof Reflect.get(provider, "countInputTokens") === "function";
}
~~~

ModelRuntime.countInputTokens()는 capability가 없으면 undefined를 반환합니다.
따라서 ContextCoordinator는 정확한 값이 있으면 사용하고, 없거나 endpoint 호출이 실패하면 TokenEstimator로 fallback합니다.

### 3) stream과 token count가 같은 request body를 사용

~~~ts
const response = await fetch(
  this.serverUrl + "/v1/chat/completions/input_tokens",
  {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(toLlamaRequestBody(request, false)),
    signal: options?.signal,
  },
);
~~~

toLlamaRequestBody()를 공용으로 둔 이유가 중요합니다. stream 요청과 token count 요청의 messages/tools가 다르면 계산 결과도 신뢰할 수 없기 때문입니다.
HTTP error와 SSE 안의 error payload 모두 createLlamaServerError()로 모아 처리합니다.

## Task 2. overflow 복구: compact 후 한 번만 재시도

### 볼 파일

- src/model/retry.ts
- src/context/budget.ts
- src/context/coordinator.ts
- src/session/session-context-coordinator.ts
- src/session/chat-session.ts

### 1) overflow는 일반 retry 대상이 아님

~~~ts
if (
  event.reason === "aborted" ||
  isContextOverflowError(event.error) ||
  meaningfulEventSeen ||
  attemptIndex === this.maxRetries
) {
  yield event;
  return;
}
~~~

같은 큰 요청을 그대로 다시 보내도 overflow는 해결되지 않습니다.
그래서 RetryingModelRuntime은 overflow를 바로 위 계층으로 보내고, ChatSession이 session-aware 복구를 수행합니다.

### 2) reason을 이벤트 계약에 포함

~~~ts
export type CompactionReason = "manual" | "threshold" | "overflow";

type ContextCoordinatorEvent =
  | {
      type: "compaction-start";
      reason: CompactionReason;
      tokensBefore: number;
    }
  | {
      type: "compaction-done";
      reason: CompactionReason;
      tokensBefore: number;
      tokensAfter: number;
    };
~~~

UI는 이 reason만 보고 자동 사전 정리인지, 서버 overflow 복구인지, 사용자의 /compact인지 표시할 수 있습니다.

### 3) 한 번만 compact-and-retry

~~~ts
if (
  visibleOutputSeen ||
  overflowRecoveryAttempted ||
  this.contextCoordinator?.compact === undefined
) {
  yield { type: "error", reason: "error", error: overflowError };
  return;
}

overflowRecoveryAttempted = true;

for await (const event of this.contextCoordinator.compact(
  recoveryRequest,
  "overflow",
  { signal: options?.signal },
)) {
  yield event;
}
~~~

visibleOutputSeen은 안전장치입니다. 이미 사용자에게 text/tool 실행이 보인 요청을 통째로 다시 실행하면 답변이나 작업이 중복될 수 있으므로 자동 재시도하지 않습니다.
overflowRecoveryAttempted로 recovery loop도 최대 한 번으로 제한합니다.

### 4) force compaction

~~~ts
if (tokensBefore <= inputBudget && request.force !== true) {
  return undefined;
}
~~~

추정치는 여유가 있다고 판단했지만 실제 llama tokenizer가 overflow를 낸 경우가 있습니다.
이때 force: true가 있어야 복구 경로가 compaction을 건너뛰지 않습니다.

## Task 3. split-turn Compaction과 /compact

### 문제

기존에는 user 메시지부터 그 다음 user 메시지 직전까지를 하나의 turn으로 취급했습니다.
가장 최근 turn 하나만으로도 keepRecentTokens를 넘으면, 예전 구현은 요약할 과거 turn이 없다고 실패했습니다.
하지만 한 turn 안에도 다음처럼 안전하게 나눌 수 있는 지점이 있습니다.

~~~text
user -> assistant(tool call A) -> tool(result A) -> assistant(final)
          요약할 prefix                 보존할 suffix
~~~

단, ToolCall은 해당 ToolResult보다 앞에 있어야 합니다.
tool 결과에서 문맥을 시작하거나, 아직 결과가 없는 call을 요약해 버리면 모델이 잘못된 이력을 받습니다.

### 볼 파일

- src/context/types.ts
- src/context/compaction.ts
- src/session/session.ts
- src/session/jsonl-store.ts
- src/session/chat-session.ts
- src/cli/chat.ts

### 1) turn이 각 message entry ID를 유지

~~~ts
export interface CompactionTurn {
  readonly firstEntryId: string;
  readonly messages: readonly Message[];
  readonly messageEntryIds?: readonly string[];
}

current = {
  firstEntryId: entry.id,
  messages: [cloneMessage(entry.message)],
  messageEntryIds: [entry.id],
};
~~~

messages[index]만으로는 split 뒤에 어떤 JSONL entry를 firstKeptEntryId로 저장해야 할지 알 수 없습니다.
그래서 Session이 path를 turn으로 바꿀 때 entry ID도 같은 순서로 보관합니다.
옵션 속성으로 둔 것은 기존 compaction 입력 계약을 깨지 않기 위해서입니다. 실제 Session이 만드는 turn에는 항상 들어 있습니다.

### 2) 안전한 split 지점 선택

~~~ts
function hasCompleteToolPairs(messages: readonly Message[]): boolean {
  const pending = new Set<string>();

  for (const message of messages) {
    if (message.role === "assistant") {
      for (const call of message.toolCalls) {
        if (pending.has(call.id)) return false;
        pending.add(call.id);
      }
    }

    if (message.role === "tool" && !pending.delete(message.toolCallId)) {
      return false;
    }
  }

  return pending.size === 0;
}
~~~

~~~ts
for (let index = 1; index < turn.messages.length; index += 1) {
  const firstKeptMessage = turn.messages[index];
  const summarizedMessages = turn.messages.slice(0, index);
  const keptMessages = turn.messages.slice(index);

  if (
    firstKeptMessage.role === "tool" ||
    !hasCompleteToolPairs(summarizedMessages) ||
    estimator.estimateMessages(keptMessages) > keepRecentTokens
  ) {
    continue;
  }

  return { summarized: prefix, kept: suffix };
}
~~~

이 코드는 앞에서부터 후보를 검사합니다. 따라서 허용되는 범위 안에서 가능한 많은 최신 message를 suffix로 보존합니다.
한 개의 user message 자체가 너무 큰 경우처럼 안전한 split 지점이 없으면 실패합니다. 메시지 내용을 임의로 자르면 사용자의 명령 자체가 훼손될 수 있기 때문입니다.

### 3) CompactionEntry의 시작은 assistant도 가능

~~~ts
if (
  !firstKeptEntry ||
  firstKeptEntry.type !== "message" ||
  firstKeptEntry.message.role === "tool"
) {
  throw new Error(
    "Compaction entry must keep a user or assistant message.",
  );
}
~~~

split suffix가 assistant에서 시작할 수 있으므로 JSONL 검증과 Session.appendCompaction() 모두 user만 허용하던 제약을 바꿨습니다.
그래도 tool에서 시작하는 것은 계속 거부합니다.

### 4) 수동 /compact

~~~ts
public async *streamCompaction(
  options?: AgentLoopOptions,
): AsyncIterable<ChatEvent> {
  const request = {
    model: this.model,
    messages: [...this.session.buildActiveMessages()],
    tools: this.toolDefinitions,
  };

  for await (const event of this.contextCoordinator.compact(
    request,
    "manual",
    { signal: options?.signal },
  )) {
    yield event;
  }
}
~~~

~~~ts
if (content === "/compact") {
  await renderEvents(
    session.streamCompaction({ signal: controller.signal }),
    io,
  );
  continue;
}
~~~

CLI는 명령을 해석하고 출력/ESC 취소만 담당합니다.
compaction의 판단, 요약, JSONL 저장은 ChatSession -> ContextCoordinator -> Session에 남습니다.
그래서 이후 GUI를 추가해도 /compact 문자열 처리만 새 UI에 맞추면 되고, compaction 로직을 복사할 필요가 없습니다.

## 읽는 순서

1. src/context/types.ts: compaction이 주고받는 데이터 계약
2. src/context/compaction.ts: 예산 계산, turn 선택, split 안전 규칙
3. src/session/session.ts: JSONL entry path를 CompactionTurn으로 변환
4. src/session/session-context-coordinator.ts: compaction 결과를 세션에 저장하고 실제 토큰 수로 재검사
5. src/session/chat-session.ts: 사용자 turn, overflow 복구, 수동 compaction 진입점
6. src/providers/llama/provider.ts: llama.cpp token/overflow adapter
7. src/cli/chat.ts: /compact 및 이벤트 렌더링

## 가장 중요한 구분

| 구분 | 책임 |
| --- | --- |
| Provider | llama.cpp HTTP/SSE 형식을 공통 모델 이벤트로 변환 |
| Runtime/Retry | provider 선택, 일시적 오류 재시도 |
| CompactionService | 무엇을 요약하고 무엇을 보존할지 결정, 요약 모델 호출 |
| Session/JSONL | 원본 entry와 CompactionEntry를 영속화, 활성 path 재구성 |
| ChatSession | session 상태가 필요한 overflow recovery와 API 제공 |
| CLI | 명령 입력, 출력, ESC abort |

## 검증

테스트는 사용자 요청에 따라 작성하거나 실행하지 않았습니다.
구현 Task 1, Task 2, Task 3 각각에서 npm.cmd run typecheck를 실행했고 통과했습니다.
