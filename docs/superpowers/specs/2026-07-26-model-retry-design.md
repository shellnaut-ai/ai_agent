# Model Retry Design

## 목적

모델 Provider가 사용자에게 의미 있는 출력이나 ToolCall을 전달하기 전에 실패하면 동일한 모델 요청을 최대 두 번 자동 재시도한다. Tool 실행은 부작용이 중복될 수 있으므로 자동 재시도하지 않는다.

## 확정 정책

- 최초 호출 1회와 재시도 2회를 합쳐 모델 요청은 최대 3회 실행한다.
- 첫 번째 재시도는 500ms, 두 번째 재시도는 1000ms 뒤에 실행한다.
- `text-delta` 또는 `tool-call`이 한 번이라도 발생한 요청은 재시도하지 않는다.
- `start`는 의미 있는 출력으로 보지 않는다.
- `aborted` 오류는 재시도하지 않는다.
- 재시도 대기 중에도 `AbortSignal`을 관찰하여 Esc에 즉시 반응한다.
- 첫 버전은 의미 있는 출력 전 발생한 모든 비중단 오류를 재시도한다.
- 자동 테스트는 제외하고 `npm run check`와 수동 실행으로 확인한다.

## 아키텍처

```text
AgentLoop
   ↓ ModelStreamRunner
RetryingModelRuntime
   ↓ ModelStreamRunner
ModelRuntime
   ↓ ModelProvider
LlamaProvider
```

`ModelRuntime`은 Provider를 찾아 한 번 실행한다. `RetryingModelRuntime`은 다른 `ModelStreamRunner`를 감싸 모델 호출만 반복한다. `AgentLoop`는 구체 클래스가 아닌 `ModelStreamRunner` 인터페이스에 의존한다.

이 경계는 향후 `LoggingModelRuntime`, `MetricsModelRuntime`, `CachingModelRuntime`도 같은 방식으로 조합할 수 있게 한다.

## 타입 경계

`src/model/runtime.ts`에 공통 실행 인터페이스와 Runtime 전용 이벤트를 둔다.

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

Provider는 기존 `StreamEvent`만 발생시킨다. `retry`는 Runtime 장식 계층의 사건이므로 `ModelRuntimeEvent`에만 추가한다. `AgentEvent`에도 같은 `retry` 변형을 추가해 CLI까지 전달한다.

## RetryingModelRuntime

`src/model/retry.ts`에 설정과 실행기를 추가한다.

```ts
export interface RetryOptions {
  readonly maxRetries: number;
  readonly initialDelayMs: number;
}

export class RetryingModelRuntime implements ModelStreamRunner {
  // ModelStreamRunner를 감싸 모델 요청만 재시도한다.
}
```

생성자에서 `maxRetries`는 0 이상의 정수인지, `initialDelayMs`는 0 이상의 유한수인지 검증한다.

각 시도에서 `text-delta` 또는 `tool-call`을 관찰해 `meaningfulEventSeen`을 설정한다. 재시도 가능한 `error`는 외부로 전달하지 않고 `retry` 이벤트로 대체한다. 마지막 실패, 중단, 의미 있는 출력 이후의 실패는 기존 `error`를 전달하고 종료한다.

내부 스트림이 `done`이나 `error` 없이 끝나면 `Model stream ended without a terminal event.` 오류로 취급한다. 의미 있는 이벤트가 없다면 같은 정책으로 재시도한다.

두 번째 시도부터 발생하는 중복 `start` 이벤트는 외부로 전달하지 않는다.

## 중단 가능한 대기

재시도 지연은 `setTimeout`과 `AbortSignal` 리스너를 함께 등록한다. 타이머가 먼저 끝나면 abort 리스너를 제거한다. 중단이 먼저 발생하면 타이머와 리스너를 정리한 후 `aborted` 오류로 종료한다.

## Agent와 CLI 연결

`AgentLoop` 생성자 타입을 `ModelRuntime`에서 `ModelStreamRunner`로 바꾼다. Runtime의 `retry` 이벤트는 상태 변경 없이 `AgentEvent`로 전달한다. Retry 계층은 `ToolRegistry.execute`를 호출하지 않으므로 read, write, edit, bash 실행은 반복되지 않는다.

CLI 출력 형식은 다음과 같다.

```text
[Model] Retrying 1/2 in 500ms...
[Model] Retrying 2/2 in 1000ms...
```

`demo.ts` 조립은 다음과 같다.

```ts
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

## 실패 처리

- Provider가 `aborted`를 반환하면 즉시 AgentLoop에 전달한다.
- 의미 있는 이벤트 이후 오류가 발생하면 중복 출력을 막기 위해 즉시 전달한다.
- 최대 두 번 재시도 후에도 실패하면 마지막 Provider 오류를 전달한다.
- 재시도 대기 중 중단되면 `aborted` 오류를 전달한다.
- 잘못된 Retry 설정은 생성자에서 거부한다.

## 완료 기준

1. `npm run check`가 통과한다.
2. llama.cpp 서버가 꺼진 상태에서 재시도 메시지가 정확히 두 번 출력된 뒤 최종 오류가 표시된다.
3. 정상 서버에서는 재시도 메시지 없이 기존 채팅과 Tool 실행이 동작한다.
4. 재시도 대기 중 Esc를 누르면 추가 호출 없이 현재 턴만 취소된다.
5. 실패하거나 중단된 턴은 JSONL 세션에 저장되지 않는다.

## 후속 범위

- HTTP 408, 429, 5xx와 네트워크 오류만 재시도하는 오류 분류
- `Retry-After` 헤더 지원
- 지연 최대값과 무작위 jitter
- 설정 파일 또는 CLI 옵션을 통한 Retry 정책 변경
