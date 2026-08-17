# Compact Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 최신 업스트림 `main`에 `feat/compact`의 llama.cpp token counting, overflow recovery, safe split-turn compaction, 수동 `/compact` 기능을 테스트 우선 merge commit으로 통합한다.

**Architecture:** Provider는 llama.cpp의 token-count 및 overflow wire 신호만 공통 계약으로 번역한다. Runtime은 capability 전달과 일반 retry를 담당하고, Context/Session 계층은 Provider 이름을 보지 않은 채 압축 선택·JSONL 기록·최대 1회 overflow 복구를 수행한다. 최신 `main`의 ModelHttpError, continuation, writer-lock, approval 및 세션 내구성은 충돌 해결의 기준으로 보존한다.

**Tech Stack:** TypeScript 7, Node.js 22.12+, Vitest 4, append-only JSONL, llama.cpp OpenAI-compatible HTTP/SSE, PowerShell, GitHub Actions.

## Global Constraints

- 통합 기준은 `shellnaut/main@2e5c5b1`이고 원본은 `shellnaut/feat/compact@9d7bb58`이다.
- 작업 브랜치는 `codex/compact-integration`이다.
- Production 코드보다 테스트를 먼저 커밋하고 RED를 확인한다.
- 원본 branch ancestry는 `git merge --no-ff` merge commit으로 보존한다.
- JSONL 원본 entry를 삭제·재작성하지 않는다.
- 기존 `ModelHttpError`, output continuation, providerState, writer-lock, approval, process supervision을 제거하거나 약화하지 않는다.
- 자동 overflow 복구는 visible output 전에 최대 1회만 허용한다.
- 단일 user message를 문자 위치에서 자르지 않는다.
- Skills, Prompt Templates, 추가 OAuth Provider는 범위 밖이다.

---

### Task 1: Provider 및 Runtime RED 계약 고정

**Files:**
- Create: `src/providers/llama/provider.test.ts`
- Modify: `src/model/errors.test.ts`
- Modify: `src/model/retry.test.ts`
- Test: `src/providers/provider-contract.test.ts`

**Interfaces:**
- Consumes: 현재 `ModelProvider`, `ModelRuntime`, `RetryingModelRuntime`, `ModelHttpError`, `LlamaProvider`.
- Produces: `ContextOverflowError`, `isContextOverflowError()`, optional `countInputTokens()` capability가 필요함을 증명하는 failing tests.

- [ ] **Step 1: Context overflow 오류 RED 테스트 작성**

`src/model/errors.test.ts`에 다음 테스트를 추가한다.

```ts
import {
  ContextOverflowError,
  isContextOverflowError,
  isContextOverflowMessage,
} from "./errors.js";

test("classifies only known context overflow messages", () => {
  expect(isContextOverflowMessage("context_length_exceeded")).toBe(true);
  expect(isContextOverflowMessage("exceeds the available context size")).toBe(true);
  expect(isContextOverflowMessage("HTTP 500 connection reset")).toBe(false);
  expect(isContextOverflowError(new ContextOverflowError("overflow"))).toBe(true);
  expect(isContextOverflowError(new Error("overflow"))).toBe(false);
});
```

- [ ] **Step 2: overflow 무재시도 RED 테스트 작성**

`src/model/retry.test.ts`에 실제 async generator runner를 사용해 다음 계약을 추가한다.

```ts
test("does not retry a context overflow", async () => {
  let calls = 0;
  const runner = {
    async *stream() {
      calls += 1;
      yield { type: "start" as const };
      yield {
        type: "error" as const,
        reason: "error" as const,
        error: new ContextOverflowError("context_length_exceeded"),
      };
    },
  };
  const runtime = new RetryingModelRuntime(runner, {
    maxRetries: 2,
    initialDelayMs: 1,
  });

  const events = await collect(runtime.stream(request));

  expect(calls).toBe(1);
  expect(events.at(-1)).toMatchObject({
    type: "error",
    error: { name: "ContextOverflowError" },
  });
});
```

- [ ] **Step 3: llama.cpp token counter와 overflow RED 테스트 작성**

`src/providers/llama/provider.test.ts`에서 `vi.stubGlobal("fetch", fetchFake)`를 사용한다. token endpoint 응답과 stream 응답을 분리하고 다음을 검증한다.

```ts
test("counts input tokens with the same request payload as streaming", async () => {
  const requests: Request[] = [];
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const captured = new Request(input, init);
    requests.push(captured);
    if (captured.url.endsWith("/input_tokens")) {
      return Response.json({ input_tokens: 321 });
    }
    return sseResponse([
      { choices: [{ delta: { content: "ok" }, finish_reason: "stop" }] },
    ]);
  });

  await expect(provider.countInputTokens(request)).resolves.toBe(321);
  await collect(provider.stream(request));
  const countBody = await requests[0].json();
  const streamBody = await requests[1].json();

  expect(countBody).toEqual({ ...streamBody, stream: undefined });
});

test.each([
  [400, { error: { message: "context_length_exceeded" } }],
  [500, { message: "exceeds the available context size" }],
])("maps HTTP %i context overflow", async (status, body) => {
  vi.stubGlobal("fetch", async () => Response.json(body, { status }));
  const events = await collect(provider.stream(request));
  expect(events.at(-1)).toMatchObject({
    type: "error",
    error: { name: "ContextOverflowError" },
  });
});
```

실제 구현에서는 count body에 `stream` key 자체가 없어야 하므로 테스트 helper는 두 body에서 `stream`만 명시적으로 제거한 뒤 나머지 literal 구조를 비교한다.

- [ ] **Step 4: RED 실행**

Run:

```powershell
npx vitest run src/model/errors.test.ts src/model/retry.test.ts src/providers/llama/provider.test.ts
```

Expected: `ContextOverflowError`, `countInputTokens`, llama overflow 번역이 없어 실패한다. 기존 `ModelHttpError` 테스트는 계속 통과해야 한다.

- [ ] **Step 5: Provider/Runtime RED 테스트 커밋**

```powershell
git add src/model/errors.test.ts src/model/retry.test.ts src/providers/llama/provider.test.ts
git commit -m "test: define llama overflow recovery contracts"
```

---

### Task 2: Context, Session 및 CLI RED 계약 고정

**Files:**
- Modify: `src/context/compaction-integration.test.ts`
- Modify: `src/session/session-context-coordinator.test.ts`
- Modify: `src/session/chat-session-journal.test.ts`
- Modify: `src/session/session-compatibility.test.ts`
- Modify: `src/cli/chat.test.ts`

**Interfaces:**
- Consumes: `CompactionService`, `SessionContextCoordinator`, `ChatSession`, `JsonlSessionStore`, `runChat()`.
- Produces: `CompactionReason`, coordinator `compact()`, exact token counter fallback, safe split-turn, manual compaction, one-shot overflow recovery 계약.

- [ ] **Step 1: exact token count와 fallback RED 테스트 작성**

`src/session/session-context-coordinator.test.ts`에 counter를 주입하는 세 가지 테스트를 추가한다.

```ts
test("uses exact provider input tokens before estimator compaction", async () => {
  const counter = {
    async countInputTokens() {
      return 9_000;
    },
  };
  const coordinator = new SessionContextCoordinator(
    session,
    compaction,
    calculator,
    counter,
  );

  await expect(collect(coordinator.prepareModelRequest(request)))
    .resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "compaction-start", reason: "threshold" }),
    ]));
});

test("falls back to estimated tokens when optional counting fails", async () => {
  const counter = { async countInputTokens() { throw new Error("offline"); } };
  const events = await collect(new SessionContextCoordinator(
    session,
    compaction,
    calculator,
    counter,
  ).prepareModelRequest(fittingRequest));
  expect(events.at(-1)).toMatchObject({ type: "model-input-ready" });
});

test("does not hide an aborted token-count request", async () => {
  const controller = new AbortController();
  controller.abort();
  await expect(collect(coordinator.prepareModelRequest(request, {
    signal: controller.signal,
  }))).rejects.toThrow();
});
```

- [ ] **Step 2: oversized-turn 안전 split RED 테스트 작성**

`src/context/compaction-integration.test.ts`에 entry ID를 가진 한 turn을 사용한다.

```ts
test("splits an oversized turn only after a complete tool pair", () => {
  const preparation = service.prepare({
    model,
    turns: [{
      firstEntryId: "user-1",
      messageEntryIds: ["user-1", "assistant-call", "tool-1", "assistant-final"],
      messages: [
        { role: "user", content: "old request" },
        { role: "assistant", content: "", toolCalls: [call] },
        { role: "tool", toolCallId: call.id, content: "result", isError: false },
        { role: "assistant", content: "recent answer", toolCalls: [] },
      ],
    }],
    force: true,
    toolDefinitions: [],
  });

  expect(preparation?.firstKeptEntryId).toBe("assistant-final");
  expect(preparation?.keptTurns[0].messages[0].role).toBe("assistant");
});

test("never starts a compacted suffix with a tool result", () => {
  expect(() => service.prepare(toolStartOnlyCandidate)).toThrow(
    "single message is too large",
  );
});
```

- [ ] **Step 3: overflow 복구 RED 테스트 작성**

`src/session/chat-session-journal.test.ts`에 scripted AgentLoop와 coordinator fake를 사용한다.

```ts
test("compacts and retries one overflow before visible output", async () => {
  const events = await collect(chat.streamTurn("hello"));
  expect(agentCalls).toBe(2);
  expect(compactReasons).toEqual(["overflow"]);
  expect(events).toEqual(expect.arrayContaining([
    expect.objectContaining({ type: "compaction-start", reason: "overflow" }),
    expect.objectContaining({ type: "done" }),
  ]));
});

test("does not retry overflow after visible output", async () => {
  const events = await collect(chatWithVisibleOverflow.streamTurn("hello"));
  expect(agentCalls).toBe(1);
  expect(compactReasons).toEqual([]);
  expect(events.at(-1)).toMatchObject({ type: "error" });
});

test("stops after one compact-and-retry", async () => {
  await collect(alwaysOverflowChat.streamTurn("hello"));
  expect(agentCalls).toBe(2);
  expect(compactReasons).toEqual(["overflow"]);
});
```

- [ ] **Step 4: 수동 `/compact` RED 테스트 작성**

`src/cli/chat.test.ts`의 `ChatSessionLike` fake에 `streamCompaction`을 추가하고 다음을 검증한다.

```ts
test("routes /compact without appending a user turn", async () => {
  const calls: string[] = [];
  const session: ChatSessionLike = {
    async *streamTurn(content) { calls.push(`turn:${content}`); },
    async *streamCompaction() {
      calls.push("compact");
      yield { type: "compaction-start", reason: "manual", tokensBefore: 200 };
      yield {
        type: "compaction-done",
        reason: "manual",
        tokensBefore: 200,
        tokensAfter: 80,
      };
    },
  };

  await runChat(session, scriptedIo(["/compact", "/exit"]));
  expect(calls).toEqual(["compact"]);
});
```

- [ ] **Step 5: assistant-start CompactionEntry RED 테스트 작성**

`src/session/session-compatibility.test.ts`에 user → assistant → tool → assistant 기록을 만들고, 마지막 assistant entry를 `firstKeptEntryId`로 갖는 CompactionEntry가 reload 뒤 활성 메시지로 유지되는지 검증한다. Tool entry를 첫 보존 entry로 지정한 fixture는 계속 거부돼야 한다.

- [ ] **Step 6: RED 실행**

```powershell
npx vitest run src/context/compaction-integration.test.ts src/session/session-context-coordinator.test.ts src/session/chat-session-journal.test.ts src/session/session-compatibility.test.ts src/cli/chat.test.ts
```

Expected: `reason`, `force`, `messageEntryIds`, `compact()`, `streamCompaction()` 및 overflow recovery 부재로 실패한다. 기존 continuation과 JSONL 테스트는 삭제하거나 skip하지 않는다.

- [ ] **Step 7: Context/Session/CLI RED 테스트 커밋**

```powershell
git add src/context/compaction-integration.test.ts src/session/session-context-coordinator.test.ts src/session/chat-session-journal.test.ts src/session/session-compatibility.test.ts src/cli/chat.test.ts
git commit -m "test: define compact integration behavior"
```

---

### Task 3: 원본 브랜치 merge 및 Provider/Runtime 충돌 해결

**Files:**
- Modify: `src/model/errors.ts`
- Modify: `src/model/provider.ts`
- Modify: `src/model/runtime.ts`
- Modify: `src/model/retry.ts`
- Modify: `src/providers/llama/provider.ts`
- Preserve: `src/providers/openai-codex-provider.ts`

**Interfaces:**
- Consumes: Task 1 RED tests, `shellnaut/feat/compact@9d7bb58`.
- Produces: `ModelInputTokenCounter`, `ContextOverflowError`, llama exact token counter 및 overflow 번역.

- [ ] **Step 1: merge 시작**

```powershell
git merge --no-ff --no-commit shellnaut/feat/compact
git status --short
```

Expected: 공통 파일 충돌이 표시되고 merge가 아직 커밋되지 않는다.

- [ ] **Step 2: 오류 타입을 의미 단위로 통합**

`src/model/errors.ts`에서 기존 `ModelHttpError`와 `isRetryableModelError()`를 그대로 유지하고 아래를 추가한다.

```ts
const CONTEXT_OVERFLOW_PATTERN =
  /exceeds the available context size|context[_ ]length[_ ]exceeded/i;

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

export function isContextOverflowMessage(message: string): boolean {
  return CONTEXT_OVERFLOW_PATTERN.test(message);
}
```

`isRetryableModelError()`는 `ContextOverflowError`를 false로 분류하도록 명시한다.

- [ ] **Step 3: optional token counter capability 추가**

`src/model/provider.ts`:

```ts
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
```

`src/model/runtime.ts`와 `src/model/retry.ts`는 capability가 없으면 `undefined`, 있으면 동일 request/options를 전달한다. AbortSignal을 새로 만들거나 Provider ID로 분기하지 않는다.

- [ ] **Step 4: llama request body와 token endpoint 통합**

`src/providers/llama/provider.ts`에 `toLlamaRequestBody(request, stream)`을 두고 chat stream과 token endpoint가 공유한다. `countInputTokens()`는 `/v1/chat/completions/input_tokens`의 `{input_tokens: nonNegativeInteger}`만 허용한다.

HTTP와 SSE 오류는 `createLlamaServerError(message)`를 거쳐 known overflow만 `ContextOverflowError`로 바꾼다. 기존 incomplete tool-call, continuation 및 SSE framing 코드는 유지한다.

- [ ] **Step 5: Task 1 GREEN 확인**

```powershell
npx vitest run src/model/errors.test.ts src/model/retry.test.ts src/providers/llama/provider.test.ts src/providers/provider-contract.test.ts src/model/provider-matrix.test.ts
```

Expected: 모두 통과하고 OpenAI Codex의 영구 4xx 무재시도 테스트도 통과한다.

---

### Task 4: Context/Session/CLI 충돌 해결 및 merge commit 완성

**Files:**
- Modify: `src/context/budget.ts`
- Modify: `src/context/compaction.ts`
- Modify: `src/context/coordinator.ts`
- Modify: `src/context/types.ts`
- Modify: `src/session/session-context-coordinator.ts`
- Modify: `src/session/chat-session.ts`
- Modify: `src/session/session.ts`
- Modify: `src/session/jsonl-store.ts`
- Modify: `src/session/types.ts`
- Modify: `src/cli/chat.ts`
- Modify: `src/cli/main.ts`
- Modify: `src/demo.ts`
- Add from source: `docs/context-compaction-llama-overflow.md`

**Interfaces:**
- Consumes: Task 2 RED tests, Task 3 Provider/Runtime capability.
- Produces: `CompactionReason`, force compaction, safe split-turn, one-shot overflow recovery, manual `/compact`.

- [ ] **Step 1: compaction 계약 확장**

`src/context/types.ts`:

```ts
export interface CompactionTurn {
  readonly firstEntryId: string;
  readonly messages: readonly Message[];
  readonly messageEntryIds?: readonly string[];
}

export interface CompactionRequest {
  // existing fields preserved
  readonly force?: boolean;
}
```

`src/context/coordinator.ts`:

```ts
export type CompactionReason = "manual" | "threshold" | "overflow";

// compaction-start/done events include readonly reason: CompactionReason
compact?(
  request: ModelRequest,
  reason: CompactionReason,
  options?: { readonly signal?: AbortSignal },
): AsyncIterable<ContextCoordinatorEvent>;
```

- [ ] **Step 2: safe split 구현**

`src/context/compaction.ts`에서 `messageEntryIds` 길이가 messages와 일치할 때만 split을 허용한다. 각 후보는 다음 조건을 모두 통과해야 한다.

```ts
if (
  firstKeptMessage.role === "tool" ||
  !hasCompleteToolPairs(summarizedMessages) ||
  estimator.estimateMessages(keptMessages) > keepRecentTokens
) {
  continue;
}
```

선택된 suffix의 `firstEntryId`는 `messageEntryIds[index]`를 사용한다. 안전한 후보가 없으면 fail closed한다.

- [ ] **Step 3: coordinator exact budget와 manual compact 구현**

`SessionContextCoordinator` 생성자에 optional `ModelInputTokenCounter`를 추가한다. `#calculateBudget()`은 exact count 성공 시 `calculateWithInputTokens()`, non-abort 실패 시 estimator, abort 시 throw를 사용한다.

`compact(request, reason, options)`은 session message 동기화 확인 → force preparation → start event → summary → appendCompaction → done event → exact/estimated fit 재검사 순서로 실행한다.

- [ ] **Step 4: ChatSession overflow/manual 진입점 구현**

`streamCompaction()`은 turn mutex를 사용하고 `manual` reason만 전달한다. `streamAgentWithOverflowRecovery()`는 visible output 여부와 attempt boolean을 추적해 최대 한 번만 compact/retry한다.

기존 continuation recovery와 checkpoint 코드는 삭제하지 않고, overflow retry 후 request messages만 `session.buildActiveMessages()`로 갱신한다.

- [ ] **Step 5: Session/JSONL assistant-start 경계 통합**

`Session.buildCompactionTurns()`는 각 message의 entry ID 배열을 만든다. `appendCompaction()`과 JSONL validation은 first-kept entry가 `user` 또는 `assistant`인 경우만 허용하고 `tool`은 계속 거부한다. 현재 writer lock, version 2 header, append transaction 및 recovery 코드는 유지한다.

- [ ] **Step 6: CLI `/compact` 구현**

`ChatSessionLike`에 optional `streamCompaction()`을 추가한다. `runChat()`은 일반 turn 전에 `/compact`를 식별하고 동일 AbortController/listener 패턴으로 compaction event를 렌더링한다. `/compact` 문자열을 `streamTurn()`에 전달하지 않는다.

- [ ] **Step 7: Task 2 GREEN 확인**

```powershell
npx vitest run src/context/compaction-integration.test.ts src/session/session-context-coordinator.test.ts src/session/chat-session-journal.test.ts src/session/session-compatibility.test.ts src/cli/chat.test.ts
```

Expected: 모두 통과한다.

- [ ] **Step 8: 전체 충돌과 whitespace 확인**

```powershell
git status --short
git diff --check
git diff --name-only --diff-filter=U
```

Expected: unmerged path 0개, whitespace error 0개.

- [ ] **Step 9: merge commit 생성**

```powershell
git add docs/context-compaction-llama-overflow.md src/agent/types.ts src/cli/chat.ts src/cli/main.ts src/context src/demo.ts src/model src/providers/llama src/session
git commit -m "feat: integrate tested compact overflow recovery"
```

Expected: 두 parent를 가진 merge commit이다.

---

### Task 5: 문서 정합성과 전체 로컬 검증

**Files:**
- Modify: `docs/context-compaction-llama-overflow.md`
- Modify: `README.md`
- Modify if required: `docs/07-token-limit-resilience.md`

**Interfaces:**
- Consumes: 완료된 merge 구현과 실제 테스트 결과.
- Produces: 현재 동작·제약·검증 수치를 정확히 설명하는 운영 문서.

- [ ] **Step 1: 원본 문서의 테스트 미실행 문구 수정**

`docs/context-compaction-llama-overflow.md`에서 “테스트는 작성하거나 실행하지 않았다”는 과거 문구를 제거하고 실제 RED/GREEN 및 전체 검증 명령을 기록한다. Provider-neutral policy, 최대 1회 복구, visible-output 차단, exact-counter fallback을 명시한다.

- [ ] **Step 2: README 사용법 추가**

다음 명령과 의미를 기록한다.

```powershell
npm run cli -- chat --provider llama --model gemma-local
# 대화 중 /compact 입력: 현재 활성 문맥을 수동 압축
```

llama.cpp token endpoint가 없거나 실패하면 estimator를 사용하며, overflow 자동 복구가 반복 실행이나 tool 재실행을 허용하지 않는다고 설명한다.

- [ ] **Step 3: 집중 회귀 실행**

```powershell
npx vitest run src/model/errors.test.ts src/model/retry.test.ts src/providers/llama/provider.test.ts src/context/compaction-integration.test.ts src/session/session-context-coordinator.test.ts src/session/chat-session-journal.test.ts src/session/session-compatibility.test.ts src/cli/chat.test.ts
```

- [ ] **Step 4: Windows helper provenance 검증**

```powershell
npm run verify:windows-helper
```

- [ ] **Step 5: 전체 acceptance 실행**

```powershell
$env:CI = "true"
npm run check
npm audit --audit-level=high
git diff --check
git status -sb
```

Expected: 모든 테스트, typecheck, production build, package smoke, CLI EOF smoke, audit가 통과한다.

- [ ] **Step 6: 문서 커밋**

```powershell
git add README.md docs/context-compaction-llama-overflow.md docs/07-token-limit-resilience.md
git commit -m "docs: explain compact overflow recovery"
```

변경이 없는 문서는 `git add` 목록에서 제외한다.

---

### Task 6: 독립 리뷰, push, Draft PR 및 CI

**Files:**
- Review range: `shellnaut/main..HEAD`
- PR target: `shellnaut-ai/ai_agent:main`
- PR head: `shellnaut-ai/ai_agent:codex/compact-integration`

**Interfaces:**
- Consumes: clean local branch와 전체 검증 증거.
- Produces: 리뷰 완료된 원격 branch, 한국어 Draft PR, green CI.

- [ ] **Step 1: 독립 코드 리뷰 요청**

리뷰 범위에서 다음을 확인한다.

- 기존 PR #6 모델 및 error redaction 회귀 없음
- Provider-neutral compaction policy
- overflow 최대 1회 및 visible-output 차단
- ToolCall/ToolResult split 안전성
- JSONL/writer-lock/continuation 내구성
- 테스트가 실제 동작을 검증하고 mock 존재만 검증하지 않음

Critical과 Important가 있으면 TDD로 수정한 뒤 Task 5 전체 검증을 다시 실행한다.

- [ ] **Step 2: 브랜치 push**

```powershell
git push -u shellnaut codex/compact-integration
```

- [ ] **Step 3: 한국어 Draft PR 생성**

PR 본문에는 다음을 포함한다.

- `feat/compactv` 404와 실제 `feat/compact@9d7bb58` 식별 근거
- 최신 `main` 기준 merge 및 충돌 해결 원칙
- 테스트 RED 증거와 GREEN/전체 검증 수치
- exact token count, overflow recovery, safe split, `/compact` 설명
- 보존한 기존 기능 목록
- 리뷰 확인 항목과 알려진 fallback/비목표

- [ ] **Step 4: GitHub Actions 확인**

```powershell
gh pr checks --watch --interval 10 --repo shellnaut-ai/ai_agent
```

Windows, macOS, POSIX가 모두 통과해야 완료한다. 기존 Windows writer-lock startup timeout만 단독 실패하고 로컬 전체 검증이 통과했다면 로그로 동일 증상을 확인한 뒤 failed job을 한 번만 재실행한다.

- [ ] **Step 5: 최종 상태 검증**

```powershell
gh pr view --repo shellnaut-ai/ai_agent --json title,url,state,isDraft,mergeable,mergeStateStatus,statusCheckRollup
git status -sb
git log --oneline --decorate shellnaut/main..HEAD
```

Expected: Draft PR OPEN, MERGEABLE/CLEAN, 모든 required check 성공, local working tree clean.
