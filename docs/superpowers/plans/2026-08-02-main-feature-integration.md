# Main Feature Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `shellnaut/main`의 기존 기능을 보존하면서 pi-clone import의 인증, Provider, 안전한 도구, 세션 검증과 CLI를 하나의 canonical runtime으로 통합한다.

**Architecture:** `main`의 ModelRuntime, AgentLoop, approval, session, compaction을 중심으로 유지하고 import 구현을 adapter와 구체 Provider/Tool로 포팅한다. 기존 동작은 characterization test로 잠그고 새 통합 동작은 RED-GREEN TDD로 추가한다.

**Tech Stack:** Node.js 22+, TypeScript 7, ESM, Vitest 4, TypeBox, JSONL, OpenAI Responses API, OpenAI-compatible chat completions, llama.cpp SSE

## Global Constraints

- 기준은 `shellnaut/main@0c6c0057d7c10a6f434a169a68985306618c9e7b`이다.
- `codex/pi-clone-import@3b1977b2e847c60e9f2ea2c080d13026456b954f`는 read-only 이식 원본이다.
- `main` 직접 커밋과 force push를 금지한다.
- write, edit, bash는 승인 없이 실행하지 않는다.
- production 동작 변경은 반드시 실패하는 테스트를 먼저 확인한다.
- 삭제 파일은 기능 보존표에 대체 경로와 검증 테스트를 기록한다.

---

### Task 1: 통합 기준과 테스트 하네스 고정

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `tsconfig.json`
- Create: `tsconfig.build.json`
- Create: `vitest.config.ts`
- Create: `test/main-capabilities.test.ts`
- Create: `docs/superpowers/plans/2026-08-02-main-feature-preservation-matrix.md`

**Interfaces:**
- Consumes: 현재 `main`의 `AgentLoop`, `ModelRuntime`, `SessionStore`, `CompactionService`, `LlamaProvider`, `ToolRegistry`
- Produces: `npm run typecheck`, `npm test`, `npm run build`, `npm run check`와 기능 보존표

- [ ] **Step 1: main 동작을 characterization test로 기록한다**

```ts
import { describe, expect, test } from "vitest";

describe("main capability baseline", () => {
  test("unknown provider produces a terminal error event", async () => {
    // 실제 ProviderRegistry와 ModelRuntime을 사용해 error event의 reason을 검증한다.
  });

  test("write-class tool without an approval handler is denied", async () => {
    // 실제 AgentLoop와 ToolRegistry를 사용해 실행 부작용이 없고 ToolResult가 오류인지 검증한다.
  });
});
```

- [ ] **Step 2: 기존 타입 검사와 characterization test를 실행한다**

Run: `npm run check`

Expected: 기존 `tsc --noEmit`은 성공하고 새 test script가 아직 없어 실패한다.

- [ ] **Step 3: ESM/Vitest/build script를 최소 구성한다**

`package.json`에는 `typecheck`, `test`, `build`, `check`를 추가하고 `typebox`,
`tsx`, TypeScript 의존성을 보존한다. `check` 순서는 typecheck, test, build다.

- [ ] **Step 4: 전체 기준 검증을 통과시킨다**

Run: `npm run check`

Expected: typecheck, characterization test, build가 모두 성공한다.

- [ ] **Step 5: 기능 보존표를 작성하고 커밋한다**

Run: `git diff --diff-filter=D --name-only shellnaut/main..codex/pi-clone-import`

Expected: 41개 파일 각각에 `유지`, `대체`, `흡수`, `비제품 제거`와 검증 테스트가 기록된다.

Commit: `test: characterize main agent capabilities`

### Task 2: 인증 코어와 Codex OAuth 포팅

**Files:**
- Create: `src/auth/oauth-contracts.ts`
- Create: `src/auth/pkce.ts`
- Create: `src/auth/oauth-store.ts`
- Create: `src/auth/memory-oauth-store.ts`
- Create: `src/auth/file-oauth-store.ts`
- Create: `src/auth/openai-codex-oauth.ts`
- Create: `src/auth/oauth-resolver.ts`
- Test: `src/auth/*.test.ts`

**Interfaces:**
- Consumes: Node crypto, filesystem, injected `fetch`
- Produces: `OAuthCredential`, `OAuthStore`, `OpenAICodexOAuth`, `OAuthResolver`

- [ ] **Step 1: import의 auth 테스트만 먼저 이식한다**

Run: `npm test -- src/auth`

Expected: auth production module을 찾지 못해 RED가 된다.

- [ ] **Step 2: PKCE, credential validation, memory store를 포팅한다**

Run: `npm test -- src/auth/pkce.test.ts src/auth/oauth-contracts.test.ts src/auth/oauth-store.test.ts`

Expected: literal PKCE fixture, 만료 판단, store round-trip이 성공한다.

- [ ] **Step 3: file store와 OAuth login/refresh를 포팅한다**

Run: `npm test -- src/auth/openai-codex-oauth.test.ts src/auth/oauth-resolver.test.ts`

Expected: state 검증, token refresh, 중첩 account id, file lock 경계가 성공한다.

- [ ] **Step 4: 전체 검증 후 커밋한다**

Run: `npm run check`

Commit: `feat(auth): integrate Codex OAuth core`

### Task 3: Provider를 canonical Model 계약에 연결

**Files:**
- Modify: `src/model/types.ts`
- Modify: `src/model/registry.ts`
- Create: `src/providers/sse.ts`
- Create: `src/providers/openai-compatible-provider.ts`
- Create: `src/providers/openai-codex-provider.ts`
- Test: `src/providers/openai-compatible-provider.test.ts`
- Test: `src/providers/openai-codex-provider.test.ts`
- Test: `src/model/provider-matrix.test.ts`

**Interfaces:**
- Consumes: `ModelProvider`, `ModelRequest`, `StreamEvent`, `OAuthResolver`
- Produces: `OpenAICompatibleProvider`, `OpenAICodexProvider`, registry provider ids `openai-compatible`, `openai-codex`

- [ ] **Step 1: Provider 테스트와 provider-matrix RED를 작성한다**

```ts
test.each(["llama", "openai-compatible", "openai-codex"])(
  "%s provider emits one terminal event",
  async (providerId) => {
    const events = await collectRegisteredProviderEvents(providerId);
    expect(events.filter(isTerminalEvent)).toHaveLength(1);
  },
);
```

Run: `npm test -- src/model/provider-matrix.test.ts`

Expected: 두 신규 Provider가 registry에 없어 RED가 된다.

- [ ] **Step 2: 공통 SSE parser와 OpenAI-compatible Provider를 포팅한다**

Run: `npm test -- src/providers/openai-compatible-provider.test.ts`

Expected: multiline/CRLF SSE, malformed chunk, tool call 조립이 성공한다.

- [ ] **Step 3: Codex Responses Provider를 ModelProvider에 맞춘다**

Run: `npm test -- src/providers/openai-codex-provider.test.ts`

Expected: reasoning replay, context position, token refresh, terminal event 검증이 성공한다.

- [ ] **Step 4: Provider matrix와 전체 검증 후 커밋한다**

Run: `npm run check`

Commit: `feat(provider): add OpenAI and Codex providers`

### Task 4: 안전한 네 도구와 승인 결합

**Files:**
- Create: `src/tools/workspace-paths.ts`
- Modify: `src/tools/read.ts`
- Modify: `src/tools/write.ts`
- Modify: `src/tools/edit.ts`
- Modify: `src/tools/bash.ts`
- Modify: `src/tools/registry.ts`
- Test: `src/tools/workspace-paths.test.ts`
- Test: `src/tools/tool-integration.test.ts`

**Interfaces:**
- Consumes: main `Tool`, `ToolDefinition`, `ToolRegistry`, `ToolApprovalHandler`
- Produces: workspace-contained read/write/edit/bash와 source-order `executeBatch`

- [ ] **Step 1: 경로 탈출과 batch 승인 테스트를 RED로 작성한다**

```ts
test("denies write before touching the filesystem", async () => {
  const result = await runApprovedTool("write", "deny");
  expect(result.isError).toBe(true);
  await expect(fileExists("denied.txt")).resolves.toBe(false);
});
```

Run: `npm test -- src/tools/workspace-paths.test.ts src/tools/tool-integration.test.ts`

Expected: shared path guard 또는 batch API가 없어 RED가 된다.

- [ ] **Step 2: WorkspacePaths와 read/write/edit을 포팅한다**

Run: `npm test -- src/tools/workspace-paths.test.ts src/tools/tool-integration.test.ts`

Expected: 외부 절대경로, symlink, unsafe parent, zero/multiple edit가 차단된다.

- [ ] **Step 3: bash 제한과 source-order batch를 포팅한다**

Run: `npm test -- src/tools/tool-integration.test.ts`

Expected: timeout, 1 MiB 출력 제한, 실패 후 계속 실행, 결과 순서가 검증된다.

- [ ] **Step 4: 전체 검증 후 커밋한다**

Run: `npm run check`

Commit: `feat(tools): combine workspace safety with approvals`

### Task 5: Agent 실행 정책과 영속화 순서 통합

**Files:**
- Modify: `src/agent/types.ts`
- Modify: `src/agent/loop.ts`
- Test: `src/agent/loop-integration.test.ts`

**Interfaces:**
- Consumes: `ModelStreamRunner`, `ToolRegistry`, `ToolApprovalHandler`, `SessionStore`
- Produces: `AgentExecutionPolicy { maxSteps: number; maxToolBatches?: number }`와 persist-before-context-update

- [ ] **Step 1: strict batch와 persist 실패 테스트를 RED로 작성한다**

```ts
test("strict policy rejects a second tool batch", async () => {
  const events = await runWithPolicy({ maxSteps: 8, maxToolBatches: 1 });
  expect(events.at(-1)).toMatchObject({ type: "error" });
});
```

Run: `npm test -- src/agent/loop-integration.test.ts`

Expected: `maxToolBatches`가 없어 RED가 된다.

- [ ] **Step 2: 실행 정책과 tool batch 카운터를 구현한다**

Run: `npm test -- src/agent/loop-integration.test.ts`

Expected: 일반 다단계와 strict 한 batch 모드가 모두 성공한다.

- [ ] **Step 3: 저장 성공 후 context 반영 순서를 구현한다**

Run: `npm test -- src/agent/loop-integration.test.ts`

Expected: append 실패 메시지가 다음 ModelRequest에 포함되지 않는다.

- [ ] **Step 4: 전체 검증 후 커밋한다**

Run: `npm run check`

Commit: `feat(agent): unify execution and persistence policies`

### Task 6: Session validation과 compaction 연결

**Files:**
- Modify: `src/session/jsonl-store.ts`
- Modify: `src/session/session.ts`
- Modify: `src/session/chat-session.ts`
- Test: `src/session/session-compatibility.test.ts`
- Test: `src/context/compaction-integration.test.ts`

**Interfaces:**
- Consumes: main session branch/approval/compaction record와 import runtime validation 규칙
- Produces: 줄 번호 오류를 제공하는 validated replay와 compaction 후 재개 가능한 ChatSession

- [ ] **Step 1: 손상 JSONL과 기존 fixture replay 테스트를 RED로 작성한다**

Run: `npm test -- src/session/session-compatibility.test.ts`

Expected: 문법상 JSON이지만 구조가 틀린 record가 현재 통과해 RED가 된다.

- [ ] **Step 2: record별 runtime validator를 구현한다**

Run: `npm test -- src/session/session-compatibility.test.ts`

Expected: 기존 record는 replay되고 손상 record는 줄 번호와 함께 거부된다.

- [ ] **Step 3: compaction 및 persist 실패 통합 테스트를 추가한다**

Run: `npm test -- src/context/compaction-integration.test.ts`

Expected: summary, 최근 turn, pending user message와 branch identity가 보존된다.

- [ ] **Step 4: 전체 검증 후 커밋한다**

Run: `npm run check`

Commit: `feat(session): validate replay and preserve compaction`

### Task 7: 하나의 CLI로 인증, chat, 승인을 통합

**Files:**
- Create: `src/cli/main.ts`
- Create: `src/cli/auth-commands.ts`
- Modify: `src/cli/chat.ts`
- Modify: `src/cli/approval.ts`
- Modify: `src/cli/io.ts`
- Create: `src/cli/oauth-callback-server.ts`
- Create: `src/cli/open-url.ts`
- Create: `src/cli.ts`
- Create: `scripts/smoke-cli-eof.mjs`
- Test: `src/cli/*.test.ts`

**Interfaces:**
- Consumes: ProviderRegistry, OAuthResolver, AgentLoop, SessionToolApprovalHandler
- Produces: `ai-agent auth login|status|logout`, `ai-agent chat`, exit code 계약

- [ ] **Step 1: command routing과 EOF smoke를 RED로 작성한다**

Run: `npm test -- src/cli && npm run smoke:cli-eof`

Expected: auth command와 smoke script가 없어 RED가 된다.

- [ ] **Step 2: auth command와 callback server를 포팅한다**

Run: `npm test -- src/cli/auth-commands.test.ts src/cli/oauth-callback-server.test.ts`

Expected: callback state 선검증과 token 비노출 오류가 성공한다.

- [ ] **Step 3: Provider 선택, chat, approval 입력을 하나로 연결한다**

Run: `npm test -- src/cli`

Expected: 세 Provider 선택, allow-once/allow-session/deny, abort가 성공한다.

- [ ] **Step 4: EOF smoke와 전체 검증 후 커밋한다**

Run: `npm run check`

Commit: `feat(cli): combine auth chat and approval flows`

### Task 8: 문서, 보존표, 배포 전 검증

**Files:**
- Modify: `README.md`
- Modify: `docs/README.md`
- Preserve: `docs/superpowers/plans/*`
- Preserve: `docs/superpowers/specs/*`
- Modify: `docs/superpowers/plans/2026-08-02-main-feature-preservation-matrix.md`

**Interfaces:**
- Consumes: 통합된 runtime과 모든 검증 명령
- Produces: 사용자 실행 문서, 삭제 0건의 기능 보존표, merge-ready branch

- [ ] **Step 1: README에 설치, Provider, 승인, session 실행 경계를 기록한다**

- [ ] **Step 2: 보존표의 41개 파일을 최종 대체 경로와 테스트에 연결한다**

Run: `git diff --diff-filter=D --name-only shellnaut/main...HEAD`

Expected: 삭제 파일이 없거나 모든 삭제가 보존표에서 `비제품 제거`로 승인되어 있다.

- [ ] **Step 3: 최종 품질 검증을 실행한다**

Run: `npm ci && npm run check && npm audit --audit-level=high`

Expected: 모든 명령 exit 0, 0 high vulnerabilities.

- [ ] **Step 4: secret과 merge-base를 검증한다**

Run: `git merge-base --is-ancestor shellnaut/main HEAD`

Expected: exit 0.

Run: `rg -n -i "(access[_-]?token|refresh[_-]?token|client[_-]?secret)\s*[:=]\s*['\"][^'\"]+" src docs --glob '!**/*.test.ts'`

Expected: 실제 credential literal 0건.

- [ ] **Step 5: 문서 커밋과 원격 push를 수행한다**

Commit: `docs: document unified agent architecture`

Run: `git push -u shellnaut codex/main-feature-integration`

Expected: local HEAD, upstream, remote ref가 동일하다.
