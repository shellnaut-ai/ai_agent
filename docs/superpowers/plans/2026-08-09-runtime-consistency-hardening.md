# Runtime Consistency Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Persist partial agent turns safely, preserve Codex replay state across restart and compaction, and terminate managed Bash process trees on cancellation boundaries.

**Architecture:** Extend assistant messages with JSON-compatible provider state, then make AgentLoop emit persistence checkpoints that ChatSession commits before state transitions. Session recovery closes interrupted tool calls with explicit unknown outcomes. Bash lifecycle moves into a platform-specific process-tree helper.

**Tech Stack:** TypeScript 7, Node.js 22.12+, Vitest 4, append-only JSONL, Node child_process.

## Global Constraints

- Base commit is `shellnaut/main@a75dbde3aae18719c32b747bf7dd7c19ca32bc68`.
- Preserve JSONL header version 2 and read sessions that have no `providerState`.
- Preserve llama.cpp, OpenAI-compatible, approval, retry, branching, and compaction behavior.
- Persist user and assistant intent before any mutating tool executes.
- Never automatically repeat a tool whose prior outcome is unknown.
- Windows termination covers the Job Object-managed process tree; POSIX termination covers the spawned process group and does not claim escaped-session descendants.
- Every production behavior follows RED → verify failure → GREEN → verify pass.
- Commit only files belonging to the current task.

---

### Task 1: JSON-safe provider state contract

**Files:**
- Modify: `src/model/types.ts`
- Modify: `src/session/jsonl-store.ts`
- Modify: `src/session/session-compatibility.test.ts`
- Modify: `src/index.ts`

**Interfaces:**
- Consumes: existing `ProviderId`, `AssistantMessage`, and JSONL message parser.
- Produces: `JsonValue`, `ProviderMessageState`, optional `AssistantMessage.providerState`, and validated JSONL replay.

- [ ] **Step 1: Write failing session compatibility tests**

Add tests that write a version-2 session containing an assistant message with this literal state and assert it reloads unchanged:

```ts
providerState: {
  provider: "openai-codex",
  value: {
    reasoningItems: [{ type: "reasoning", id: "rs_1" }],
    functionItemIds: { "call-1": "fc_1" },
  },
}
```

Add a second test whose state contains a non-finite number by calling `Session.appendMessage()` after Task 3 is not yet available; for this task, exercise the JSONL parser with `1e999` parsed as Infinity and expect the load error to include the record line number.

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```powershell
npm test -- --run src/session/session-compatibility.test.ts
```

Expected: the valid state is dropped from the reloaded assistant message or the invalid value is accepted.

- [ ] **Step 3: Add the typed JSON value and provider state**

Add to `src/model/types.ts`:

```ts
export type JsonValue =
  | null
  | boolean
  | number
  | string
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };

export interface ProviderMessageState {
  readonly provider: ProviderId;
  readonly value: JsonValue;
}
```

Add `readonly providerState?: ProviderMessageState` to `AssistantMessage` and optional `providerState` to the `done` stream event. Export the public types from `src/index.ts`.

- [ ] **Step 4: Validate provider state while parsing JSONL**

Implement a recursive parser that accepts only null, boolean, string, finite number, arrays, and plain JSON objects. Validate that `provider` is a supported `ProviderId`. Preserve absence for old records and include the parsed state in the assistant message.

- [ ] **Step 5: Run tests and typecheck**

Run:

```powershell
npm test -- --run src/session/session-compatibility.test.ts src/index.test.ts
npm run typecheck
```

Expected: focused tests and typecheck pass.

- [ ] **Step 6: Commit**

```powershell
git add src/model/types.ts src/session/jsonl-store.ts src/session/session-compatibility.test.ts src/index.ts src/index.test.ts
git commit -m "feat(session): persist provider message state"
```

---

### Task 2: Durable Codex replay metadata

**Files:**
- Modify: `src/providers/openai-codex-provider.ts`
- Modify: `src/providers/openai-codex-provider.test.ts`
- Modify: `src/model/types.ts`

**Interfaces:**
- Consumes: `AssistantMessage.providerState` and `StreamEvent.done.providerState` from Task 1.
- Produces: Codex state value `{ reasoningItems, functionItemIds }` attached to each completed assistant message without message-index lookup.

- [ ] **Step 1: Write a failing restart replay test**

Use one provider to emit a completed response containing encrypted reasoning and a function-call output item ID. Build the resulting assistant message with the terminal `providerState`, serialize it through a fresh `OpenAICodexProvider`, and assert the captured request input includes both literals:

```ts
expect(input).toContainEqual({
  type: "reasoning",
  id: "rs_1",
  summary: [],
  encrypted_content: "encrypted",
});
expect(input).toContainEqual(expect.objectContaining({
  type: "function_call",
  id: "fc_1",
  call_id: "call-1",
}));
```

- [ ] **Step 2: Write a failing shifted-index test**

Insert a compaction summary user message before the restored assistant message and assert the same reasoning and function item IDs remain in the request. This mutation must fail against the current `messageIndex` lookup.

- [ ] **Step 3: Run tests and verify RED**

```powershell
npm test -- --run src/providers/openai-codex-provider.test.ts
```

Expected: the fresh instance and shifted-index requests contain zero reasoning items or omit `id: "fc_1"`.

- [ ] **Step 4: Replace volatile replay storage**

Delete `#assistantReplay`, `AssistantReplay`, `findReplay`, and index/content matching. At the terminal response, emit:

```ts
providerState: {
  provider: "openai-codex",
  value: {
    reasoningItems: replayItems,
    functionItemIds: Object.fromEntries(toolItems),
  },
}
```

When serializing an assistant message, validate and consume only state whose provider is `openai-codex`. Read function item IDs by call ID from the persisted object.

- [ ] **Step 5: Preserve state in AgentLoop assistant messages**

Capture `event.providerState` from the terminal model event and copy it to the constructed assistant message. Do not add Provider-specific branching to AgentLoop.

- [ ] **Step 6: Run provider and agent tests**

```powershell
npm test -- --run src/providers/openai-codex-provider.test.ts src/agent/loop-integration.test.ts
npm run typecheck
```

Expected: all focused tests pass.

- [ ] **Step 7: Commit**

```powershell
git add src/providers/openai-codex-provider.ts src/providers/openai-codex-provider.test.ts src/model/types.ts src/agent/loop.ts src/agent/loop-integration.test.ts
git commit -m "fix(provider): persist Codex replay metadata"
```

---

### Task 3: Incremental Session journal and interrupted-call recovery

**Files:**
- Modify: `src/session/session.ts`
- Modify: `src/session/types.ts`
- Modify: `src/session/session-compatibility.test.ts`
- Create: `src/session/session-journal.test.ts`

**Interfaces:**
- Consumes: existing `SessionStore.appendEntry()` and Message types.
- Produces: `Session.appendMessage(message)` and `Session.recoverInterruptedToolCalls()`.

- [ ] **Step 1: Write failing appendMessage tests**

Use a real `JsonlSessionStore`. Append user, assistant tool-call, and matching tool result one at a time. Reload the store and assert exact message order. Add tests that reject a tool result whose call ID is absent and a duplicate assistant tool call ID.

- [ ] **Step 2: Write failing recovery tests**

Persist a user and assistant message containing calls `call-1` and `call-2`, then persist only `call-1`'s result. Call `recoverInterruptedToolCalls()` and assert it appends exactly one error result for `call-2` with content:

```text
Tool execution was interrupted before its result was recorded. The outcome is unknown. Inspect workspace state before retrying this operation.
```

Call recovery again and assert it appends nothing.

- [ ] **Step 3: Run focused tests and verify RED**

```powershell
npm test -- --run src/session/session-journal.test.ts
```

Expected: `appendMessage` and `recoverInterruptedToolCalls` do not exist.

- [ ] **Step 4: Implement single-message append**

Create one `MessageEntry` whose parent is the current leaf, call `store.appendEntry`, and return a structured clone. Before append, scan the active branch to enforce unique tool call IDs and require a pending ID for tool results. Store success remains the only operation that advances the underlying leaf.

- [ ] **Step 5: Implement conservative recovery**

Scan the active branch in order. Add assistant call IDs to a pending map and remove them on tool results. Append one literal unknown-outcome error result per remaining call in source order by calling `appendMessage()`.

- [ ] **Step 6: Run session tests**

```powershell
npm test -- --run src/session/session-journal.test.ts src/session/session-compatibility.test.ts
npm run typecheck
```

Expected: focused tests and typecheck pass.

- [ ] **Step 7: Commit**

```powershell
git add src/session/session.ts src/session/types.ts src/session/session-compatibility.test.ts src/session/session-journal.test.ts
git commit -m "feat(session): journal partial agent turns"
```

---

### Task 4: Persist checkpoints around Agent execution

**Files:**
- Modify: `src/agent/types.ts`
- Modify: `src/agent/loop.ts`
- Modify: `src/agent/loop-integration.test.ts`
- Modify: `src/session/chat-session.ts`
- Modify: `src/session/types.ts`
- Create: `src/session/chat-session-journal.test.ts`
- Modify: `src/cli/chat.ts`

**Interfaces:**
- Consumes: Session journal APIs from Task 3 and provider state from Task 2.
- Produces: `message-checkpoint`, enriched `tool-result.message`, and `session-recovery` events.

- [ ] **Step 1: Write the failing side-effect ordering test**

Use a real SessionStore and a mutating fake tool. Make session append fail for the assistant checkpoint and assert tool execution count remains zero. The production mutation this catches is resuming AgentLoop before checkpoint persistence completes.

- [ ] **Step 2: Write failing result/recovery integration tests**

Scenario A: tool succeeds, its result is persisted, then the second Provider call fails. Assert JSONL contains the actual result and recovery appends nothing.

Scenario B: tool succeeds but result append fails. Reload the persisted JSONL, recover, and assert an unknown result is appended while tool execution count stays one.

- [ ] **Step 3: Write failing compaction-order test**

Force compaction with a pending user message. Assert the user appears once in the compacted request accounting and once in JSONL after compaction, with its parent equal to the compaction entry.

- [ ] **Step 4: Run focused tests and verify RED**

```powershell
npm test -- --run src/session/chat-session-journal.test.ts src/context/compaction-integration.test.ts
```

Expected: checkpoint failure still allows the tool or completed messages are absent after the Provider failure.

- [ ] **Step 5: Add Agent checkpoint events**

After constructing each assistant message, yield `message-checkpoint` before mutating working state or executing tools. Include the exact `ToolResultMessage` in `tool-result`. Resume only when the consumer requests the next generator value.

- [ ] **Step 6: Change ChatSession orchestration**

Execute in this exact order:

```text
recover interrupted calls
prepare and execute compaction with the still-pending user
append the user once
stream AgentLoop
persist each message-checkpoint before resuming AgentLoop
persist each tool-result message before yielding it to callers
```

Do not batch-save `done.newMessages`. Emit `session-recovery` with recovered IDs. Update CLI text to report unknown outcomes.

- [ ] **Step 7: Run journal, agent, compaction, and CLI tests**

```powershell
npm test -- --run src/session/chat-session-journal.test.ts src/agent/loop-integration.test.ts src/context/compaction-integration.test.ts src/cli/chat.test.ts
npm run typecheck
```

Expected: focused tests and typecheck pass.

- [ ] **Step 8: Commit**

```powershell
git add src/agent/types.ts src/agent/loop.ts src/agent/loop-integration.test.ts src/session/chat-session.ts src/session/types.ts src/session/chat-session-journal.test.ts src/context/compaction-integration.test.ts src/cli/chat.ts src/cli/chat.test.ts
git commit -m "fix(agent): journal execution checkpoints"
```

---

### Task 5: Managed Bash process-group termination

**Files:**
- Create: `src/tools/process-tree.ts`
- Create: `src/tools/process-tree.test.ts`
- Modify: `src/tools/bash.ts`
- Modify: `src/tools/tool-integration.test.ts`

**Interfaces:**
- Consumes: exact spawned child PID and current platform.
- Produces: `terminateProcessTree(child, platform)` plus deduplicated Bash termination coordination.

- [ ] **Step 1: Write failing process-tree contract tests**

On Windows, spawn a long-running Node parent that spawns a long-running Node child and writes the child PID. Terminate the parent tree and poll both PIDs until neither exists. On POSIX, spawn the equivalent detached process group and verify both group members exit. Always clean up remaining test processes in `finally`.

- [ ] **Step 2: Write failing Bash boundary tests**

Cover timeout, AbortSignal, and output-limit termination. Assert the Tool returns/throws the existing semantic result and the recorded descendant PID is no longer alive. Use platform-specific skips only where the production guarantee differs.

- [ ] **Step 3: Run focused tests and verify RED**

```powershell
npm test -- --run src/tools/process-tree.test.ts src/tools/tool-integration.test.ts
```

Expected: at least the descendant process remains alive against current direct-child `kill()`.

- [ ] **Step 4: Implement platform termination**

Windows invokes hidden `taskkill.exe /PID <exact pid> /T /F` and awaits exit. POSIX spawns bash detached, sends `SIGTERM` to `-pid`, waits a short bounded grace period, then sends `SIGKILL` if the group still exists. Treat already-exited/not-found as successful cleanup.

- [ ] **Step 5: Integrate a single termination coordinator**

Do not pass AbortSignal directly to `spawn`. Register one abort listener and route abort, timeout, and output-limit causes through one memoized termination Promise. Remove timers, listeners, and stream handlers after close.

- [ ] **Step 6: Run tool tests repeatedly**

```powershell
1..3 | ForEach-Object { npm test -- --run src/tools/process-tree.test.ts src/tools/tool-integration.test.ts }
npm run typecheck
```

Expected: all three runs and typecheck pass without leaked child processes.

- [ ] **Step 7: Commit**

```powershell
git add src/tools/process-tree.ts src/tools/process-tree.test.ts src/tools/bash.ts src/tools/tool-integration.test.ts
git commit -m "fix(tools): terminate Bash process trees"
```

---

### Task 6: Runtime branch final verification

**Files:**
- Modify: `README.md`
- Modify: `docs/superpowers/specs/2026-08-09-runtime-consistency-hardening-design.md` only if behavior wording needs synchronization

**Interfaces:**
- Consumes: all previous task contracts.
- Produces: user-facing recovery/process termination documentation and verified branch.

- [ ] **Step 1: Update runtime documentation**

Document partial-turn recovery, unknown tool outcomes, durable Codex session replay, and platform-specific Bash termination scope. Do not claim rollback or termination of POSIX descendants that escaped the process group.

- [ ] **Step 2: Run full verification**

```powershell
npm ci
npm run check
npm audit --audit-level=high
git diff --check shellnaut/main...HEAD
```

Expected: all checks pass with zero high/critical advisories after merging the independent quality-gates PR into this branch before runtime implementation begins.

- [ ] **Step 3: Commit documentation**

```powershell
git add README.md docs/superpowers/specs/2026-08-09-runtime-consistency-hardening-design.md
git commit -m "docs: explain runtime recovery guarantees"
```
