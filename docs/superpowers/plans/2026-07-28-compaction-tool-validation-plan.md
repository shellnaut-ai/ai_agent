# Context Compaction and Tool Validation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add pi-style model-generated context compaction and TypeBox validation before Tool approval and execution.

**Architecture:** `ChatSession` coordinates an injected `CompactionService` and append-only `SessionStore`. `ToolRegistry` owns compiled validators and produces either an immediate error ToolResult or a prepared call containing separate raw and executable arguments.

**Tech Stack:** TypeScript, Node.js AsyncIterable/AbortSignal, TypeBox 1.1.38, JSONL, llama.cpp OpenAI-compatible API

## Global Constraints

- Do not delete or rewrite original JSONL turns.
- Do not mutate raw ToolCall arguments.
- Do not auto-retry or auto-replay Tool execution.
- Keep complete turn boundaries.
- Do not add automated tests or run build/test commands.
- Run `npm run check` after each implementation batch.
- Do not commit.

### Task 1: TypeBox ToolCall validation

**Files:**
- Modify: `package.json`, `package-lock.json`
- Create: `src/tools/validation.ts`
- Modify: `src/tools/types.ts`, `src/tools/registry.ts`
- Modify: `src/tools/read.ts`, `write.ts`, `edit.ts`, `bash.ts`
- Modify: `src/agent/loop.ts`

- [ ] Install exact dependency with `npm install --save-exact --ignore-scripts typebox@1.1.38`.
- [ ] Replace handwritten schema objects with TypeBox schemas.
- [ ] Compile validators at registration.
- [ ] Add `prepare(call)` that clones, converts, validates, and returns raw/executable calls separately.
- [ ] Make AgentLoop validate before approval and turn validation failures into ToolResults.
- [ ] Run `npm run check`.

### Task 2: Compaction core

**Files:**
- Create: `src/context/types.ts`
- Create: `src/context/token-estimator.ts`
- Create: `src/context/serialize.ts`
- Create: `src/context/compaction.ts`
- Modify: `src/model/types.ts`
- Modify: `src/providers/llama/provider.ts`

- [ ] Define settings, preparation, result, and service interfaces.
- [ ] Estimate full request tokens using configurable chars-per-token.
- [ ] Serialize conversation with 2000-character ToolResult truncation and file tracking.
- [ ] Select complete recent turns and prepare repeated compaction from the previous boundary.
- [ ] Generate the exact structured summary with tools disabled and AbortSignal forwarded.
- [ ] Add request-level `maxOutputTokens` and use it in llama Provider.
- [ ] Verify compacted context fits before returning a result.
- [ ] Run `npm run check`.

### Task 3: JSONL and ChatSession integration

**Files:**
- Modify: `src/session/types.ts`
- Modify: `src/session/jsonl-store.ts`
- Modify: `src/session/chat-session.ts`

- [ ] Load original JSONL turns as indexed `SessionTurn` values.
- [ ] Parse and append `SessionCompactionRecord`.
- [ ] Build active messages from the latest summary and kept turn boundary.
- [ ] Check compaction before AgentLoop using the pending user message and tool definitions.
- [ ] Persist compaction before changing in-memory state.
- [ ] Preserve the completed-turn persistence order.
- [ ] Run `npm run check`.

### Task 4: CLI and composition

**Files:**
- Modify: `src/cli/chat.ts`
- Modify: `src/demo.ts`

- [ ] Print compaction start/done events.
- [ ] Construct CompactionService with the retrying runtime and fixed Gemma settings.
- [ ] Pass loaded turns, latest compaction, store, and tool definitions to ChatSession.
- [ ] Run final `npm run check`.
- [ ] Run `git diff --check` for the scoped files.

### Task 5: Manual acceptance guide

- [ ] Explain how to temporarily lower budgets to trigger compaction quickly.
- [ ] Explain how to inspect JSONL for preserved turns and appended compaction.
- [ ] Explain how to issue an invalid FakeProvider ToolCall to observe validation without approval.
- [ ] Identify the five core files to study.
