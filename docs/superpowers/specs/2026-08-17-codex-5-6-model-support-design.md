# ChatGPT Codex GPT-5.6 Support Design

## 배경과 확인된 원인

`shellnaut/main@9a765576`의 `OpenAICodexProvider`는 ChatGPT Codex
`/backend-api/codex/responses` 요청에 `max_output_tokens`를 항상 넣는다. 실제 계정으로
확인한 결과 `gpt-5.5`, `gpt-5.6-sol`, `gpt-5.6-terra`, `gpt-5.6-luna`가 모두
`400 Unsupported parameter: max_output_tokens`를 반환했다. 같은 요청에서 그 필드만
제거하면 네 모델 모두 HTTP 200, text delta, terminal `done`을 반환했다.

현재 Codex `model/list`와 OpenAI Codex 원본 catalog가 광고하는 5.6 ID는 다음과 같다.

- `gpt-5.6-sol`: 기본 frontier 모델
- `gpt-5.6-terra`: 균형 모델
- `gpt-5.6-luna`: 빠르고 저렴한 모델

공식 API의 `gpt-5.6` alias는 ChatGPT Codex backend에서 직접 허용되지 않는다. 기존 실패
세션은 이미 `model.id: "gpt-5.6"`을 저장했으므로 adapter가 이 alias를
`gpt-5.6-sol` wire ID로 번역해야 안전하게 재개할 수 있다.

또한 현재 retry runtime은 HTTP 400도 500ms, 1000ms 간격으로 두 번 재시도하며,
Provider는 정확히 한 형태의 unsupported-model 문장 외에는 모든 서버 오류 설명을 숨긴다.
그 결과 영구 오류가 불필요하게 세 번 호출되고 사용자는 원인을 알 수 없다.

## 목표

- ChatGPT Codex wire에서 지원하지 않는 `max_output_tokens`를 보내지 않는다.
- `gpt-5.6-sol`을 CLI 기본값으로 사용한다.
- `gpt-5.6-sol`, `gpt-5.6-terra`, `gpt-5.6-luna`, `gpt-5.5`를 명시 지원한다.
- 기존 `gpt-5.6` 세션은 wire에서 Sol로 번역해 재개한다.
- Codex model context window를 현재 Codex catalog와 같은 272,000 token으로 설정한다.
- 4xx 영구 오류는 재시도하지 않고, 408/409/429와 5xx 또는 transport 오류만 재시도한다.
- 외부 오류 응답에서 허용된 구조화 필드만 길이 제한·제어문자 제거 후 표시한다.
- llama.cpp와 OpenAI-compatible의 wire output limit, 공통 context budget, compaction,
  paging, continuation, append-only JSONL 계약을 보존한다.

## 비목표

- Codex App Server를 런타임 의존성으로 추가하지 않는다.
- API key 기반 `api.openai.com/v1/responses` Provider를 새로 만들지 않는다.
- reasoning effort, service tier, image input, WebSocket transport를 이번 변경에 추가하지 않는다.
- ChatGPT Codex backend가 제공하지 않는 per-request output cap을 다른 필드로 추측하지 않는다.
- 기존 session JSONL을 rewrite하거나 model ID를 migration하지 않는다.

## 검토한 접근법

### 1. Provider wire 수정과 작은 로컬 catalog — 선택

공통 `Model.maxOutputTokens`는 context 예약과 continuation 정책에 유지하되
`OpenAICodexProvider`만 wire에서 `max_output_tokens`를 생략한다. CLI는 검증된 Codex
모델 catalog로 model metadata를 만들고 alias만 adapter에서 번역한다.

장점은 standalone 구조와 Provider 경계를 보존하며 현재 장애 원인을 직접 제거한다는 점이다.
단점은 새 Codex 모델이 등장하면 catalog 갱신이 필요하다는 점이다.

### 2. Codex App Server `model/list`에 런타임 의존

항상 최신 catalog를 얻을 수 있지만 사용자가 별도 Codex CLI를 설치·로그인·실행해야 하며,
pi-clone OAuth 저장소와 App Server 인증 상태가 달라질 수 있다. standalone CLI의 현재 범위를
크게 넓히므로 선택하지 않는다.

### 3. 임의 model ID pass-through 유지

코드 변경은 작지만 alias, context window, 계정 가용성을 검증하지 못하고 현재처럼 네트워크
400에서야 문제를 발견한다. 오류를 조기에 설명할 수 없으므로 선택하지 않는다.

## 설계

### Codex model catalog와 CLI

새 provider-local catalog는 model metadata와 alias translation을 한곳에서 관리한다.

```ts
type CodexModelId =
  | "gpt-5.6-sol"
  | "gpt-5.6-terra"
  | "gpt-5.6-luna"
  | "gpt-5.5"
  | "gpt-5.6";

function createCodexModel(id: string): Model;
function codexWireModelId(id: string): string;
```

`createCodexModel()`은 위 ID 외의 값을 network 전에 거부하고 지원 목록을 오류에 포함한다.
모든 Codex 모델은 `contextWindow: 272_000`, 내부 정책용
`maxOutputTokens: 4_096`을 사용한다. `gpt-5.6`은 session-facing ID를 유지하고
`codexWireModelId()`에서만 `gpt-5.6-sol`로 변환한다.

CLI의 `openai-codex` 기본 모델은 `gpt-5.6-sol`이다. help와 README는 Sol/Terra/Luna,
기존 5.5, alias 호환성을 설명한다. 기존 session 재개 시 사용자는 저장된 모델 ID와 같은
`--model`을 제공해야 하는 기존 compatibility 규칙을 그대로 따른다.

### Provider wire와 context budget

`OpenAICodexProvider`의 request body는 `model`에 translated wire ID를 사용하고
`max_output_tokens`를 포함하지 않는다. `ModelRequest.maxOutputTokens`와
`Model.maxOutputTokens`는 삭제하지 않는다. 두 값은 Provider 공통 context budget,
tool-result reservation, output continuation 총량 제한에 계속 사용한다.

llama.cpp의 `max_tokens`와 OpenAI-compatible의 `max_tokens`는 변경하지 않는다. 이 차이는
공통 정책을 Provider-specific wire로 번역하는 기존 경계에 속한다.

### HTTP 오류와 retry 분류

Provider HTTP 실패는 status와 retry 가능 여부를 가진 공통 오류로 변환한다.

```ts
class ModelHttpError extends Error {
  readonly status: number;
  readonly retryable: boolean;
}
```

- retryable: 408, 409, 429, 500–599
- non-retryable: 그 외 4xx
- transport/SSE 오류: 기존처럼 meaningful output 전까지만 retry
- abort와 meaningful output 이후 오류: 기존처럼 retry하지 않음

허용된 JSON 구조 `error.{type,code,param,message}` 또는 top-level `message/detail`만 읽는다.
표시 문자열은 CR/LF와 제어문자를 공백으로 바꾸고 300자로 자르며 bearer token, JWT,
API-key 형태를 redact한다. header와 임의 body는 출력하지 않는다. 구조를 벗어난 응답은
기존처럼 status만 표시한다.

`RetryingModelRuntime`은 `retryable === false`인 오류를 즉시 terminal error로 전달한다.
일반 Error와 명시적 retryable 오류는 현재 정책을 보존한다.

### Session 호환성

JSONL schema와 기존 record는 변경하지 않는다. `model.id: "gpt-5.6"`인 실패 세션은
CLI에서 같은 alias를 지정하면 기존 compatibility validation을 통과하고 Provider wire에서
Sol로 실행된다. 새 기본 session은 `gpt-5.6-sol`을 저장한다.

사용자 메시지만 저장되고 assistant checkpoint가 없는 실패 세션도 기존 append-only 규칙에
따라 유지한다. 자동 삭제나 rewrite는 하지 않는다.

## 테스트와 검증

TDD 순서는 다음과 같다.

1. Provider request test가 `max_output_tokens` 부재와 alias translation을 요구하도록 RED.
2. model catalog test가 기본값, 5.6 세 모델, 5.5, alias, unknown rejection을 요구하도록 RED.
3. retry test가 400 non-retry와 429/5xx retry를 요구하도록 RED.
4. HTTP error test가 안전한 message 표시와 token-like redaction을 요구하도록 RED.
5. session compatibility test가 `gpt-5.6` alias session 재개 metadata를 보존하도록 RED.
6. README와 토큰 복원 문서의 CLI 예제에 빠진 `chat` 명령과 새 모델 목록을 수정한다.
7. `CI=true npm run check` 전체 acceptance를 실행한다.
8. 자동 acceptance와 분리해 실제 OAuth 계정으로 5.5와 Sol/Terra/Luna를 각각 한 번 호출하고
   HTTP 200, text delta, terminal done을 확인한다. token이나 response text는 로그에 남기지 않는다.

## 성공 기준

- 기본 `npm run cli -- chat --provider openai-codex`가 `gpt-5.6-sol`로 정상 응답한다.
- `--model gpt-5.6-terra`, `--model gpt-5.6-luna`, `--model gpt-5.5`가 정상 응답한다.
- `--model gpt-5.6 --session 60f7da6c-8da8-4b4e-8216-5abb7b6c4233`가 alias를 Sol로
  번역하고 기존 session model ID를 rewrite하지 않는다.
- 지원하지 않는 model과 non-retryable 400은 network retry 없이 원인을 표시한다.
- 모든 기존 Provider와 token-limit resilience 테스트가 통과한다.
