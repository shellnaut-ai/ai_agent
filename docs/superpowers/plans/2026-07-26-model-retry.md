# Model Retry Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 모델이 의미 있는 출력이나 ToolCall을 생성하기 전에 실패하면 최대 두 번 재시도하고, 진행 상태와 Esc 중단을 CLI까지 전달한다.

**Architecture:** `ModelStreamRunner`로 단일 Provider 실행과 Retry 장식 계층의 경계를 만든다. `RetryingModelRuntime`은 다른 runner를 감싸 모델 호출만 반복하며 AgentLoop는 Runtime의 retry 이벤트를 UI로 전달한다.

**Tech Stack:** TypeScript, Node.js AsyncIterable, AbortController, 기존 llama.cpp Provider 구조

## Global Constraints

- 최초 요청 1회와 재시도 2회를 합쳐 최대 3회 호출한다.
- `text-delta` 또는 `tool-call` 이후에는 재시도하지 않는다.
- `aborted`와 Tool 실행은 재시도하지 않는다.
- 대기 시간은 500ms와 1000ms다.
- 대기 중 Esc에 즉시 반응한다.
- 새 외부 의존성, 자동 테스트, 커밋을 추가하지 않는다.
- 코드 변경 후 `npm run check` 전체 출력을 확인한다.

---

## File Map

- Create `src/model/retry.ts`: Retry 설정, 중단 가능한 지연, 모델 스트림 재시도
- Modify `src/model/runtime.ts`: 실행 인터페이스와 Runtime 이벤트
- Modify `src/agent/types.ts`: `retry` AgentEvent
- Modify `src/agent/loop.ts`: 추상 Runtime 의존과 retry 전달
- Modify `src/cli/chat.ts`: retry 상태 출력
- Modify `src/demo.ts`: Retry Runtime 조립

### Task 1: 모델 실행 경계 정의

**Files:**
- Modify: `src/model/runtime.ts`

**Interfaces:**
- Consumes: `ModelRequest`, `StreamEvent`, `StreamOptions`, `ProviderRegistry`
- Produces: `ModelRetryEvent`, `ModelRuntimeEvent`, `ModelStreamRunner`

- [ ] **Step 1: Runtime 타입 추가**

```ts
export interface ModelRetryEvent {
  readonly type: "retry";
  readonly attempt: number;
  readonly maxRetries: number;
  readonly delayMs: number;
  readonly error: Error;
}

export type ModelRuntimeEvent = StreamEvent | ModelRetryEvent;

export interface ModelStreamRunner {
  stream(
    request: ModelRequest,
    options?: StreamOptions,
  ): AsyncIterable<ModelRuntimeEvent>;
}
```

- [ ] **Step 2: 기존 클래스에 계약 적용**

```ts
export class ModelRuntime implements ModelStreamRunner {
  // 기존 Provider 조회와 yield* 동작을 유지한다.
}
```

- [ ] **Step 3: 중간 확인**

Run: `npm run check`

Expected: 기존 AgentLoop가 계속 `ModelRuntime`을 받을 수 있고 오류가 없다.

### Task 2: Retry 장식 Runtime 구현

**Files:**
- Create: `src/model/retry.ts`

**Interfaces:**
- Consumes: `ModelStreamRunner`, `ModelRuntimeEvent`, `ModelRequest`, `StreamOptions`
- Produces: `RetryOptions`, `RetryingModelRuntime`

- [ ] **Step 1: 설정과 생성자 검증**

```ts
export interface RetryOptions {
  readonly maxRetries: number;
  readonly initialDelayMs: number;
}

export class RetryingModelRuntime implements ModelStreamRunner {
  private readonly runner: ModelStreamRunner;
  private readonly maxRetries: number;
  private readonly initialDelayMs: number;

  constructor(runner: ModelStreamRunner, options: RetryOptions) {
    if (!Number.isInteger(options.maxRetries) || options.maxRetries < 0) {
      throw new Error("Retry maxRetries must be a non-negative integer.");
    }

    if (
      !Number.isFinite(options.initialDelayMs) ||
      options.initialDelayMs < 0
    ) {
      throw new Error("Retry initialDelayMs must be a non-negative number.");
    }

    this.runner = runner;
    this.maxRetries = options.maxRetries;
    this.initialDelayMs = options.initialDelayMs;
  }
}
```

- [ ] **Step 2: 중단 가능한 지연 함수**

```ts
function waitForRetry(
  delayMs: number,
  signal?: AbortSignal,
): Promise<void> {
  if (signal?.aborted) {
    return Promise.reject(new Error("Request aborted."));
  }

  return new Promise<void>((resolve, reject) => {
    const onAbort = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      reject(new Error("Request aborted."));
    };

    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, delayMs);

    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
```

- [ ] **Step 3: 스트림 재시도**

`attemptIndex`를 0부터 `maxRetries`까지 순회한다. 각 시도에서 `meaningfulEventSeen`, `terminalEventSeen`, `retryError`를 관리한다.

```ts
const canRetry =
  event.reason !== "aborted" &&
  !meaningfulEventSeen &&
  attemptIndex < this.maxRetries;
```

재시도 가능하면 `error`를 숨기고 다음 이벤트를 발생시킨다.

```ts
const delayMs = this.initialDelayMs * 2 ** attemptIndex;

yield {
  type: "retry",
  attempt: attemptIndex + 1,
  maxRetries: this.maxRetries,
  delayMs,
  error: retryError,
};

await waitForRetry(delayMs, options?.signal);
```

`done`이면 즉시 종료한다. `aborted`, 의미 있는 이벤트 이후 오류, 횟수 소진 오류는 그대로 전달한다. 스트림이 terminal 이벤트 없이 종료되면 합성 오류를 같은 정책으로 처리한다. 최초 `start`만 전달하도록 `startEmitted`를 실행 전체에서 관리한다.

- [ ] **Step 4: 중간 확인**

Run: `npm run check`

Expected: `RetryingModelRuntime`이 `ModelStreamRunner` 계약을 만족한다.

### Task 3: AgentLoop 연결

**Files:**
- Modify: `src/agent/types.ts`
- Modify: `src/agent/loop.ts`

**Interfaces:**
- Consumes: `ModelStreamRunner`, `ModelRetryEvent`
- Produces: `AgentEvent.retry`

- [ ] **Step 1: AgentEvent 변형 추가**

```ts
| {
    type: "retry";
    attempt: number;
    maxRetries: number;
    delayMs: number;
    error: Error;
  }
```

- [ ] **Step 2: 구체 클래스 의존 제거**

```ts
import type { ModelStreamRunner } from "../model/runtime.js";

private readonly runtime: ModelStreamRunner;
```

생성자 매개변수도 `ModelStreamRunner`로 변경한다.

- [ ] **Step 3: retry 이벤트 전달**

```ts
if (event.type === "retry") {
  yield {
    type: "retry",
    attempt: event.attempt,
    maxRetries: event.maxRetries,
    delayMs: event.delayMs,
    error: event.error,
  };
  continue;
}
```

Tool 실행과 승인 코드는 변경하지 않는다.

- [ ] **Step 4: 중간 확인**

Run: `npm run check`

Expected: 기존 ToolCall 흐름을 포함해 타입 오류가 없다.

### Task 4: CLI와 조립 연결

**Files:**
- Modify: `src/cli/chat.ts`
- Modify: `src/demo.ts`

**Interfaces:**
- Consumes: `AgentEvent.retry`, `RetryingModelRuntime`
- Produces: 재시도 진행 출력과 기본 Retry 설정

- [ ] **Step 1: CLI 출력 추가**

```ts
if (event.type === "retry") {
  if (assistantLineOpen) {
    io.write("\n");
    assistantLineOpen = false;
  }

  io.write(
    `[Model] Retrying ${event.attempt}/${event.maxRetries} ` +
      `in ${event.delayMs}ms...\n`,
  );
}
```

- [ ] **Step 2: Composition Root에서 장식**

```ts
import { RetryingModelRuntime } from "./model/retry.js";

const runtime = new ModelRuntime(registry);
const retryingRuntime = new RetryingModelRuntime(runtime, {
  maxRetries: 2,
  initialDelayMs: 500,
});

const agentLoop = new AgentLoop(
  retryingRuntime,
  toolRegistry,
  approvalHandler,
);
```

- [ ] **Step 3: 전체 타입 검사**

Run: `npm run check`

Expected: `tsc --noEmit`이 종료 코드 0으로 끝난다.

### Task 5: 수동 승인 확인

**Files:**
- No file changes

- [ ] **Step 1: 서버 중단 상태**

llama.cpp 서버를 끄고 `npm run dev`에서 질문을 입력한다.

Expected:

```text
[Model] Retrying 1/2 in 500ms...
[Model] Retrying 2/2 in 1000ms...
Error: ...
```

- [ ] **Step 2: 정상 서버**

서버를 시작하고 일반 질문과 read 요청을 입력한다.

Expected: retry 없이 텍스트 스트리밍과 `[Tool] read`, `[Tool] completed`가 동작한다.

- [ ] **Step 3: 대기 중 Esc**

서버를 끄고 첫 retry 메시지가 보이면 Esc를 누른다.

Expected:

```text
Cancelling current turn...
Turn cancelled.
You>_
```

프로그램은 종료되지 않고 추가 재시도도 없어야 한다.

- [ ] **Step 4: 세션 경계**

세션 JSONL을 UTF-8로 확인한다.

Expected: 실패하거나 중단된 턴은 저장되지 않고 정상 완료된 턴만 `turn` 레코드로 추가된다.
