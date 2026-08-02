# Context Compaction and Tool Validation Design

## Goal

Complete the remaining pi-clone features: pi-style context compaction and TypeBox-based ToolCall validation.

## Context compaction

- Preserve every original turn in append-only JSONL.
- Represent the active model context as the latest structured summary plus turns from `firstKeptTurnIndex`.
- Store compaction as a separate JSONL record; never rewrite old turn records.
- Let `ChatSession` coordinate compaction, `CompactionService` calculate and summarize, and `SessionStore` persist records.
- Estimate Korean-heavy content conservatively with `chars / 2`.
- Use `reserveTokens: 1280`, `keepRecentTokens: 1024`, `maxSummaryOutputTokens: 1024`, and truncate tool results to 2000 characters only in summarization input.
- Preserve complete turns. A single turn that cannot fit produces a clear error; split-turn compaction is deferred.
- Repeated compaction sends the previous summary and only newly compacted turns to the summarizer.
- Summary calls use the existing retrying model runtime, provide no tools, and honor the current AbortSignal.
- Append the compaction record before replacing in-memory active context.

## Tool validation

- Pin `typebox` to `1.1.38`, matching pi.
- Keep raw model ToolCall arguments immutable for AssistantMessage and JSONL.
- `structuredClone` raw arguments, convert and validate only the clone.
- Compile and cache each tool schema at registration.
- Validate before approval and execution.
- Use validated arguments for approval display, session approval keys, and execution.
- Convert unknown tools and invalid arguments into error ToolResults so the model can recover.
- Revalidate stored ToolCalls if a future explicit replay feature is added; never auto-run restored calls.

## Session representation

```ts
interface SessionTurn {
  readonly index: number;
  readonly messages: readonly Message[];
}

interface SessionCompactionRecord {
  readonly type: "compaction";
  readonly summary: string;
  readonly firstKeptTurnIndex: number;
  readonly tokensBefore: number;
  readonly createdAt: string;
  readonly details: {
    readonly readFiles: readonly string[];
    readonly modifiedFiles: readonly string[];
  };
}
```

Existing turn records remain readable because turn indices are derived from append order.

## Event flow

`ChatSession.streamTurn()` returns `ChatEvent`, which adds `compaction-start` and `compaction-done` to `AgentEvent`. CLI prints compaction progress. Abort and compaction failures leave the previous session state unchanged.

## Excluded

- Session-history retrieval tool
- Branch/tree summaries
- Extension hooks
- Split-turn dual summaries
- Provider usage accounting and exact tokenizers
- Automated tests, per the project learning-time constraint

## Acceptance

- `npm run check` succeeds.
- Invalid ToolCalls do not ask for approval and return error ToolResults.
- Normal read/write/edit/bash calls still work.
- Compaction records append without deleting turn records.
- Restoring a compacted session produces summary plus recent turns.
- Esc during compaction does not save compaction or the pending user turn.
