# Compact 기능 통합 설계

## 목표

최신 업스트림 `main`을 기준으로 `feat/compact`의 유효한 기능을 테스트 우선으로 병합한다. 기존 Token Limit Resilience, Codex 모델 지원, 오류 보안, JSONL 내구성, 승인·도구·출력 연속성 기능은 그대로 보존한다.

## 기준 브랜치와 원본

- 통합 기준: `shellnaut/main@2e5c5b1`
- 작업 브랜치: `codex/compact-integration`
- 원본 기능 브랜치: `shellnaut/feat/compact@9d7bb58`
- 원본 분기점: `9a76557`
- 병합 방식: 테스트 RED 커밋 뒤 `git merge --no-ff --no-commit shellnaut/feat/compact`

사용자가 제공한 `feat/compactv` URL은 현재 404이고 해당 ref도 존재하지 않는다. 같은 저장소에서 유일하게 대응하는 `feat/compact`를 승인받아 통합 대상으로 확정했다.

## 통합 원칙

1. 원본 커밋의 ancestry와 작성자 이력을 merge commit으로 보존한다.
2. 원본 구현을 테스트 없이 그대로 수용하지 않는다.
3. Production 코드가 들어오기 전에 최신 `main`에 회귀 테스트를 추가하고 예상 실패를 확인한다.
4. 충돌 해결 시 최신 `main`을 기본값으로 유지하고, 테스트가 요구하는 compact 동작만 의미 단위로 이식한다.
5. Provider별 wire 처리는 Adapter에 두고, 압축 정책과 복구 횟수 제한은 공통 Context/Session 계층에 둔다.
6. JSONL 원본 entry는 변경하거나 삭제하지 않고 CompactionEntry가 활성 경로만 바꾸게 한다.

## 통합할 기능

### 1. llama.cpp 입력 토큰 계산 capability

`LlamaProvider`는 `/v1/chat/completions/input_tokens`를 선택적 capability로 제공한다. Token count 요청은 실제 chat 요청과 동일한 messages, tools, model, output budget 직렬화를 공유하되 streaming 필드만 제외한다.

`ModelRuntime`과 `RetryingModelRuntime`은 이 capability를 Provider 중립적으로 전달한다. capability가 없거나 token endpoint가 실패하면 기존 `TokenEstimator` 결과를 사용한다. Abort는 fallback으로 숨기지 않고 그대로 중단한다.

### 2. Context overflow 오류 분류

llama.cpp HTTP 오류와 SSE error payload에서 context overflow를 식별해 공통 `ContextOverflowError`로 변환한다. 기존 `ModelHttpError`와 retry 분류는 제거하거나 약화하지 않는다.

`RetryingModelRuntime`은 context overflow를 일시적 네트워크 오류로 재시도하지 않고 즉시 Session 계층으로 전달한다.

### 3. 압축 후 한 번만 overflow 복구

`ChatSession`은 다음 조건을 모두 만족할 때만 자동 복구한다.

- 오류가 `ContextOverflowError`다.
- 아직 text, tool call, tool result, checkpoint 등 사용자에게 보이는 출력이 없다.
- ContextCoordinator가 강제 compact를 지원한다.
- 현재 turn에서 overflow 복구를 시도하지 않았다.

조건을 만족하면 `overflow` 사유로 강제 compact하고 활성 JSONL 경로를 다시 읽어 같은 논리 요청을 한 번만 재시도한다. 두 번째 overflow, visible output 이후 overflow, compact 실패는 명시적 terminal error로 끝낸다.

### 4. Oversized turn 안전 분할

최근 turn 하나가 `keepRecentTokens`를 초과하더라도 메시지 경계에서 안전하게 prefix를 요약하고 suffix를 보존할 수 있게 한다.

- ToolCall과 해당 ToolResult는 서로 다른 쪽으로 갈라지지 않는다.
- 보존 suffix는 tool message로 시작하지 않는다.
- `messageEntryIds`와 messages의 위치 대응이 일치해야 한다.
- 안전한 split 지점이 없거나 단일 user message 자체가 너무 크면 fail closed한다.
- CompactionEntry가 가리키는 첫 보존 entry는 user 또는 assistant만 허용한다.

### 5. 수동 `/compact`와 사유 이벤트

CLI `/compact`는 새 사용자 메시지로 저장하지 않고 `ChatSession.streamCompaction()`을 호출한다. 압축 이벤트에는 `manual`, `threshold`, `overflow` 사유를 포함한다.

동시에 turn이 실행 중이거나 coordinator가 없거나 abort가 발생하면 도구·모델 부작용 없이 명시적 오류로 종료한다.

## 충돌 해결 경계

원본 브랜치와 최신 `main`이 동시에 수정한 파일은 단순 ours/theirs 선택을 금지한다.

- `src/model/errors.ts`: PR #6의 `ModelHttpError` 및 보안 경계를 유지하고 `ContextOverflowError`를 추가한다.
- `src/model/retry.ts`: 영구 HTTP 오류 분류와 bounded retry를 유지하면서 overflow만 즉시 전달한다.
- `src/providers/llama/provider.ts`: 현재 continuation 및 incomplete-tool 안전 계약을 유지하고 token counter와 overflow 번역을 추가한다.
- `src/session/chat-session.ts`: continuation checkpoint/recovery를 유지하고 overflow recovery 및 manual compaction을 추가한다.
- `src/context/*`: 기존 Provider-neutral budget/compaction을 유지하고 exact token capability, reason, force, safe split을 추가한다.
- `src/session/jsonl-store.ts`와 `src/session/session.ts`: 현재 writer-lock, append-only, replay, session compatibility를 유지하고 assistant-start compaction만 허용한다.

## 테스트 설계

Production 병합 전에 다음 테스트를 최신 `main`에 추가하고 실패를 확인한다.

### Provider와 Runtime

- `src/providers/llama/provider.test.ts`
  - stream과 token count가 동일한 핵심 body를 사용한다.
  - 올바른 `input_tokens` 정수만 허용한다.
  - HTTP 및 SSE overflow가 `ContextOverflowError`가 된다.
  - 일반 서버 오류는 overflow로 오분류하지 않는다.
- `src/model/retry.test.ts`
  - context overflow는 0회 재시도한다.
  - 기존 transient HTTP 오류는 bounded retry를 유지한다.

### Context와 Session

- `src/session/session-context-coordinator.test.ts`
  - exact counter 우선 사용, capability 부재·비-abort 실패 시 estimator fallback, abort 전파를 검증한다.
- `src/context/compaction-integration.test.ts`
  - oversized turn의 안전 split과 entry ID 대응을 검증한다.
  - ToolCall/ToolResult 분리 및 tool-start suffix를 거부한다.
- `src/session/chat-session-journal.test.ts`
  - visible output 전 overflow만 compact 후 1회 재시도한다.
  - 두 번째 overflow와 visible output 이후 overflow는 재실행하지 않는다.
  - manual compaction이 user message를 추가하지 않는다.
- `src/session/session-compatibility.test.ts`
  - assistant entry부터 시작하는 compaction replay와 legacy JSONL 호환성을 검증한다.

### CLI

- `src/cli/chat.test.ts`
  - `/compact` 명령 라우팅, event 출력, abort, 일반 입력과의 구분을 검증한다.

## 검증 게이트

1. 새 테스트가 최신 `main`에서 요구 기능 부재로 실패한다.
2. 원본 브랜치를 merge하고 충돌을 의미 단위로 해결한다.
3. 집중 테스트가 모두 통과한다.
4. `git diff --check`가 통과한다.
5. `npm run verify:windows-helper`가 통과한다.
6. `CI=true npm run check`가 통과한다.
7. `npm audit --audit-level=high`가 통과한다.
8. 독립 코드 리뷰에서 Critical과 Important가 0건이다.
9. 브랜치를 업스트림에 push하고 한국어 상세 본문의 Draft PR을 생성한다.
10. Windows, macOS, POSIX GitHub Actions가 모두 통과한다.

## 비목표

- OpenAI-compatible 또는 Codex에 llama.cpp 전용 token endpoint를 강제하지 않는다.
- Provider Adapter가 자체적으로 압축 정책이나 반복 횟수를 결정하지 않는다.
- 단일 user message 내용을 임의 문자 위치에서 자르지 않는다.
- JSONL 원본 기록을 삭제·재작성하지 않는다.
- Skills, Prompt Templates, 추가 OAuth Provider는 이번 PR에 포함하지 않는다.
