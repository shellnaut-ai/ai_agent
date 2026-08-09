# ai_agent

`ai_agent`는 스트리밍 모델, 승인형 도구 실행, append-only 세션과 context
compaction을 직접 학습하고 확장하기 위한 TypeScript Agent다. 기존 `main`의
llama.cpp runtime을 보존하면서 OpenAI-compatible endpoint와 ChatGPT Codex OAuth를
같은 Model/Agent/Session 계약에 연결한다.

## 지원 기능

- Provider: llama.cpp, OpenAI-compatible chat completions, ChatGPT Codex OAuth
- Agent: retry, abort, 다단계 tool loop, 선택적 `maxToolBatches`
- Tools: workspace 안의 read/write/edit와 제한된 bash
- Approval: write/edit/bash의 once/session/deny 결정
- Session: JSONL replay, branch leaf, approval 기록, context compaction
- CLI: 인증, Provider 선택, 세션 재개, EOF 정상 종료

## 설치와 검증

```powershell
npm ci
npm run check
```

`check`는 TypeScript 검사, Vitest, build와 실제 CLI EOF 자식 프로세스 스모크를
순서대로 실행한다. Node.js 22 이상이 필요하다.

## CLI

```powershell
npm run cli -- --help
npm run cli -- chat --provider llama --model gemma-local
npm run cli -- chat --provider openai-compatible --model gemma3
npm run cli -- auth login
npm run cli -- chat --provider openai-codex --model gpt-5.5
```

세션을 다시 열려면 `--session <ID>`를 추가한다. write/edit/bash는 실행 전에
승인을 요청하며 session 승인은 JSONL 세션에 기록된다.

### Provider 환경변수

| 변수 | 용도 | 기본값 |
|---|---|---|
| `AI_AGENT_LLAMA_URL` | llama.cpp server | `http://127.0.0.1:8080` |
| `AI_AGENT_OPENAI_BASE_URL` | OpenAI-compatible `/v1` base URL | `http://127.0.0.1:11434/v1` |
| `AI_AGENT_OPENAI_API_KEY` | 호환 endpoint 인증 | 미설정 |
| `AI_AGENT_BASH_PATH` | bash 실행 파일 | `bash` |

OAuth credential은 사용자 credential 파일에 저장하며 access/refresh token을 CLI
상태 출력이나 Provider 오류에 포함하지 않는다.

## 통합 구조

```mermaid
flowchart LR
    CLI["CLI auth / chat"] --> Registry["ProviderRegistry"]
    Registry --> Llama["llama.cpp"]
    Registry --> Compatible["OpenAI-compatible"]
    Registry --> Codex["Codex OAuth"]
    Registry --> Runtime["RetryingModelRuntime"]
    Runtime --> Loop["AgentLoop"]
    Loop --> Approval["Session approval"]
    Approval --> Tools["read / write / edit / bash"]
    Loop --> Session["JSONL Session"]
    Session --> Compact["Context compaction"]
```

설계 근거와 실행 순서는 다음 문서에 있다.

- [Main 기능 보존 통합 설계](./docs/superpowers/specs/2026-08-02-main-feature-integration-design.md)
- [Main 기능 통합 실행 계획](./docs/superpowers/plans/2026-08-02-main-feature-integration.md)
- [기능 보존표](./docs/superpowers/plans/2026-08-02-main-feature-preservation-matrix.md)
