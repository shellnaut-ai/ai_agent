# Session Entry Structure Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace turn-based JSONL session persistence with version 2 append-only session entries while preserving conversation restore, approval memory, abort behavior, and context compaction.

**Architecture:** `JsonlSessionStore` owns JSONL persistence, entry validation, ID lookup, and the current leaf. A new `Session` domain object creates typed entries and projects the active branch into full messages, compaction turns, and model context. `ChatSession` remains responsible for running an agent turn and persists its completed messages through `Session`.

**Tech Stack:** TypeScript, Node.js `fs/promises`, Node.js `crypto`, JSONL

## Global Constraints

- Do not migrate or modify version 1 session files; return an explicit incompatibility error.
- Keep approval records in the JSONL session file but outside the session entry tree.
- Preserve the existing model-generated compaction behavior and replace turn indexes with entry IDs.
- Do not add `/tree`, `/fork`, `/clone`, branch summaries, session selection UI, or tests.
- Run only `npm run check`; do not run `npm test` or `npm run build`.
- Do not commit unless the user explicitly asks.

---

### Task 1: Define the version 2 session contracts

**Files:**
- Modify: `src/session/types.ts`
- Modify: `src/context/types.ts`

**Interfaces:**
- Produces: `SessionEntryBase`, `MessageEntry`, `CompactionEntry`, `LeafEntry`, `SessionEntry`
- Produces: version 2 `SessionHeaderRecord`, `LoadedSession`, and `SessionStore`
- Produces: entry-ID-based `CompactionTurn`, `PreviousCompaction`, `CompactionPreparation`, and `CompactionResult`

- [ ] **Step 1: Replace turn-based session types**

Define a `SessionEntry` discriminated union. `MessageEntry` contains one `Message`, `CompactionEntry` contains `firstKeptEntryId`, and `LeafEntry` contains `targetId`. Keep `SessionApprovalRecord` outside the union and change the session header version to `2`.

- [ ] **Step 2: Define storage operations**

Add `createEntryId()`, `appendEntry()`, `appendEntries()`, `getEntry()`, `getEntries()`, `getLeafId()`, `getPathToRoot()`, and `setLeafId()` to `SessionStore`. Retain `load()` and `appendApproval()`.

- [ ] **Step 3: Replace compaction turn indexes**

Change `CompactionTurn.index` to `CompactionTurn.firstEntryId`. Replace all `firstKeptTurnIndex` properties in context contracts with `firstKeptEntryId`.

### Task 2: Implement version 2 JSONL storage

**Files:**
- Modify: `src/session/jsonl-store.ts`

**Interfaces:**
- Consumes: the version 2 contracts from Task 1
- Produces: an initialized in-memory entry list, ID map, current leaf, and restored approval keys

- [ ] **Step 1: Add entry parsers**

Parse and validate common entry fields before parsing `message`, `compaction`, or `leaf` fields. Reuse the existing message parser and clone mutable values at the storage boundary.

- [ ] **Step 2: Load and validate the graph**

Require a version 2 header. Reject version 1 without writing to the file. While reading from top to bottom, reject duplicate IDs, missing or forward parents, invalid compaction boundaries, unknown records, and invalid leaf targets. Approval records must update only the approval-key set.

- [ ] **Step 3: Maintain the current leaf**

For message and compaction entries set the leaf to `entry.id`. For leaf entries set it to `entry.targetId`. Approval records must not alter the leaf.

- [ ] **Step 4: Append entry batches**

Validate a complete batch against temporary copies of the ID map and leaf, serialize one JSON object per line, and perform one `appendFile()` call. Update in-memory state only after the append succeeds.

- [ ] **Step 5: Reconstruct a path**

Follow `parentId` from a requested leaf to `null`, detect cycles and missing entries, reverse the result, and return defensive copies.

### Task 3: Add the Session domain object

**Files:**
- Create: `src/session/session.ts`

**Interfaces:**
- Consumes: `SessionStore`, `Message`, and entry-ID-based compaction contracts
- Produces: `appendMessages()`, `appendCompaction()`, `getMessages()`, `buildActiveMessages()`, `buildCompactionTurns()`, and `getLatestCompaction()`

- [ ] **Step 1: Create chained MessageEntry batches**

Start with the store leaf, clone each message, assign a unique ID and timestamp, and make each new entry the next message's parent. Persist the complete chain with `appendEntries()`.

- [ ] **Step 2: Project the active path**

Return all `MessageEntry.message` values for full history. Locate the latest `CompactionEntry` and build model context from its summary, its kept-message range, and messages appended after it.

- [ ] **Step 3: Reconstruct compaction turns**

Group active-path MessageEntries beginning with each user message. Reject assistant or tool messages that appear without an earlier user message. Keep tool calls and tool results in the same derived turn.

- [ ] **Step 4: Append compaction entries**

Validate that `firstKeptEntryId` is the user message starting a turn on the current path, then append the compaction entry as the current leaf.

### Task 4: Adapt compaction and chat orchestration

**Files:**
- Modify: `src/context/compaction.ts`
- Review and modify if required: `src/context/serialize.ts`
- Modify: `src/session/chat-session.ts`

**Interfaces:**
- Consumes: derived `CompactionTurn[]` and the latest `CompactionEntry`
- Produces: entry-ID-based `CompactionResult`

- [ ] **Step 1: Select turns by array position**

Remove numeric turn-index filtering. Select kept turns from the end of the active turn array and summarize the prefix before the first kept turn. Return the kept turn's `firstEntryId`.

- [ ] **Step 2: Use Session from ChatSession**

Remove `turns`, `compaction`, and direct store ownership from `ChatSession`. Build model requests through `session.buildActiveMessages()` and persist completed user/agent messages through `session.appendMessages()`.

- [ ] **Step 3: Preserve compaction event behavior**

Before each user turn, build derived compaction turns and previous compaction state from `Session`. Append a successful compaction before running the pending model request. Continue emitting existing compaction start, done, and error events.

### Task 5: Wire application startup and verify

**Files:**
- Modify: `src/demo.ts`
- Review and modify if required: `src/approval/session.ts`

**Interfaces:**
- Consumes: initialized `JsonlSessionStore`
- Produces: a `Session` shared by `ChatSession`; approval restore continues to use `LoadedSession.approvalKeys`

- [ ] **Step 1: Construct Session**

Load the store, construct `Session`, pass it to `ChatSession`, and remove the old `initialTurns` and `initialCompaction` wiring.

- [ ] **Step 2: Preserve approval memory**

Continue passing restored approval keys to `SessionToolApprovalHandler` and continue persisting `allow-session` decisions through `appendApproval()`.

- [ ] **Step 3: Run TypeScript verification**

Run `npm run check` from `E:\09.Study\open_source\ai_agent`. Read the full output and fix every reported TypeScript error.

- [ ] **Step 4: Review the implementation diff**

Inspect only the files changed for this feature. Confirm that version 1 files are never rewritten, approval records never change the leaf, every message is stored as an independent line, and no out-of-scope CLI commands or tests were added.

