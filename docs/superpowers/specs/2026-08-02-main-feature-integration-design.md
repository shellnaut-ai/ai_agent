# Main 기능 보존 통합 설계

## 목표

`shellnaut-ai/ai_agent`의 `main@0c6c0057`을 기준으로 기존 AgentLoop, 승인,
retry, context compaction, session, llama.cpp 기능을 보존하면서
`codex/pi-clone-import@3b1977b2`의 Codex OAuth, OpenAI-compatible Provider,
안전한 네 도구, 검증된 JSONL, CLI와 학습 문서를 통합한다.

## 현재 위험

`codex/pi-clone-import`는 `main`의 직접 자식이므로 Git 병합 자체는
fast-forward다. 그러나 그 커밋은 `main`의 41개 파일을 삭제하고 73개 파일을
추가하며 4개 파일을 교체한다. 그대로 병합하면 텍스트 충돌 없이 기능이
사라진다. 따라서 import 브랜치는 병합 대상이 아니라 이식 원본으로 취급한다.

## 통합 원칙

1. `main`의 일반화된 Model, AgentLoop, approval, session, compaction 계약을
   canonical runtime으로 유지한다.
2. import의 기능은 canonical runtime에 adapter 또는 구체 구현으로 연결한다.
3. 같은 책임을 가진 두 구현을 최종 공개 API에 동시에 노출하지 않는다.
4. 기존 파일을 삭제하려면 동등 이상의 대체 기능과 회귀 테스트가 먼저 있어야 한다.
5. 새 동작은 RED-GREEN TDD로 추가하고 기존 동작은 characterization test로 고정한다.
6. 각 기능군은 독립 커밋으로 남기며 `main`에는 직접 커밋하지 않는다.

## 책임별 결정

### Model과 Provider

`src/model/types.ts`, `provider.ts`, `registry.ts`, `runtime.ts`, `retry.ts`를
공통 경계로 유지한다. llama.cpp Provider는 그대로 보존한다. Codex OAuth 및
OpenAI-compatible Provider는 공통 `ModelProvider`를 구현하도록 포팅한다.
Provider별 wire format과 SSE 파서는 Provider 내부에 격리한다.

### Agent 실행

`src/agent/loop.ts`의 다단계 실행, abort, retry event, approval 흐름을 유지한다.
import의 한 번짜리 tool batch 제한은 `maxToolBatches` 실행 정책으로 표현한다.
메시지는 영속 저장이 성공한 뒤에만 다음 in-memory context에 반영한다.

### 도구와 승인

`main`의 ToolRegistry와 approval 계약을 유지한다. import의 `WorkspacePaths`와
read/write/edit/bash 구현을 이 계약에 맞춘다. read는 자동 허용하고
write/edit/bash는 기본적으로 승인을 요구한다. 모든 batch는 source order로
순차 실행하며 한 도구 실패가 뒤 호출을 취소하지 않는다.

### 세션과 compaction

`main`의 SessionStore, ChatSession, branch, approval, compaction record를
canonical format으로 유지한다. import의 runtime JSONL validation과
persist-before-context-update 규칙을 흡수한다. 기존 main 세션 fixture와 새 형식의
round-trip을 모두 검증한다.

### CLI

하나의 ESM CLI에서 `auth login/status/logout`과 `chat`을 제공한다. chat은
llama.cpp, OpenAI-compatible, Codex OAuth Provider를 선택할 수 있어야 한다.
승인 입력, Ctrl+C abort, stdin EOF 정상 종료와 secret 비노출을 공통 경계로 둔다.

## 병합 안전장치

- 작업 브랜치: `codex/main-feature-integration`
- 기준 브랜치: `shellnaut/main@0c6c0057`
- 원본 브랜치: `codex/pi-clone-import@3b1977b2` (read-only)
- force push와 main 직접 커밋 금지
- package manifest는 ours/theirs 선택 대신 script와 dependency 합집합으로 구성
- 삭제 예정 41개 파일은 유지, 대체, 흡수, 비제품 파일 제거 중 하나로 기록
- 최종 병합은 Draft PR 검증 후 일반 merge commit 사용

## 완료 조건

- `npm ci`, `npm run check`, `npm audit --audit-level=high` 성공
- import의 108개 테스트를 그대로 이식하거나 canonical 계약용 대체 테스트로 추적
- main characterization test 전부 성공
- llama.cpp, OpenAI-compatible, Codex OAuth Provider E2E 성공
- read/write/edit/bash의 경로 탈출, 승인, 순차 실행 회귀 성공
- session replay, branch, compaction, persist 실패 회귀 성공
- CLI EOF smoke 성공 및 production/docs secret scan 성공
- 기능 보존표에서 미분류 삭제 파일 0개
