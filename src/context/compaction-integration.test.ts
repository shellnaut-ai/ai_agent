import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import { AgentLoop } from "../agent/loop.js";
import { continuationTailHash } from "../agent/output-continuation.js";
import type { ModelStreamRunner } from "../model/runtime.js";
import type { ModelRequest, StreamEvent } from "../model/types.js";
import { ChatSession } from "../session/chat-session.js";
import { JsonlSessionStore } from "../session/jsonl-store.js";
import { Session } from "../session/session.js";
import { ToolRegistry } from "../tools/registry.js";
import { CompactionService } from "./compaction.js";
import { ContextBudgetCalculator } from "./budget.js";
import { TokenEstimator } from "./token-estimator.js";
import { SessionContextCoordinator } from "../session/session-context-coordinator.js";

const cleanup: string[] = [];

afterEach(async () => {
  await Promise.all(
    cleanup.splice(0).map((path) =>
      rm(path, { recursive: true, force: true }),
    ),
  );
});

async function collect<T>(stream: AsyncIterable<T>): Promise<T[]> {
  const events: T[] = [];

  for await (const event of stream) {
    events.push(event);
  }

  return events;
}

describe("CompactionService integration", () => {
  test("summarizes old turns while preserving the newest complete turn", async () => {
    const runner: ModelStreamRunner = {
      async *stream(_request: ModelRequest): AsyncIterable<StreamEvent> {
        yield { type: "start" };
        yield { type: "text-delta", delta: "stable summary" };
        yield { type: "done", reason: "stop" };
      },
    };
    const service = new CompactionService(runner, {
      reserveTokens: 100,
      keepRecentTokens: 180,
      charsPerToken: 1,
      maxSummaryOutputTokens: 100,
      toolResultMaxChars: 100,
    });
    const long = "x".repeat(900);
    const preparation = service.prepare({
      model: {
        id: "fake-model",
        name: "Fake",
        provider: "fake",
        contextWindow: 4_000,
        maxOutputTokens: 100,
      },
      turns: [
        {
          firstEntryId: "turn-1",
          messages: [
            { role: "user", content: long },
            { role: "assistant", content: long, toolCalls: [] },
          ],
        },
        {
          firstEntryId: "turn-2",
          messages: [
            { role: "user", content: long },
            { role: "assistant", content: long, toolCalls: [] },
          ],
        },
        {
          firstEntryId: "turn-3",
          messages: [
            { role: "user", content: "recent question" },
            { role: "assistant", content: "recent answer", toolCalls: [] },
          ],
        },
      ],
      pendingUserMessage: { role: "user", content: "continue" },
      toolDefinitions: [],
    });

    expect(preparation).toBeDefined();
    expect(preparation?.inputBudget).toBe(3_644);
    expect(preparation?.turnsToSummarize.map((turn) => turn.firstEntryId))
      .toEqual(["turn-1", "turn-2"]);
    expect(preparation?.firstKeptEntryId).toBe("turn-3");

    const result = await service.compact(preparation!);

    expect(result.summary).toContain("stable summary");
    expect(result.firstKeptEntryId).toBe("turn-3");
    expect(result.tokensAfter).toBeLessThan(result.tokensBefore);
  });

  test("refuses to summarize a turn with an unmatched tool call", () => {
    const runner: ModelStreamRunner = {
      async *stream(): AsyncIterable<StreamEvent> {
        yield { type: "done", reason: "stop" };
      },
    };
    const service = new CompactionService(runner, {
      reserveTokens: 100,
      keepRecentTokens: 100,
      charsPerToken: 1,
      maxSummaryOutputTokens: 100,
      toolResultMaxChars: 100,
    });

    expect(() => service.prepare({
      model: {
        id: "fake-model",
        name: "Fake",
        provider: "fake",
        contextWindow: 1_000,
        maxOutputTokens: 100,
      },
      turns: [
        {
          firstEntryId: "incomplete-turn",
          messages: [
            { role: "user", content: "x".repeat(400) },
            {
              role: "assistant",
              content: "",
              toolCalls: [{ id: "call-1", name: "read", arguments: { path: "a.txt" } }],
            },
          ],
        },
        {
          firstEntryId: "recent-turn",
          messages: [
            { role: "user", content: "recent" },
            { role: "assistant", content: "answer", toolCalls: [] },
          ],
        },
      ],
      pendingUserMessage: { role: "user", content: "continue" },
      toolDefinitions: [],
    })).toThrow(/incomplete tool call.*call-1/i);
  });

  test("splits an oversized turn only after a complete tool pair", () => {
    const service = new CompactionService({
      async *stream(): AsyncIterable<StreamEvent> {
        yield { type: "done", reason: "stop" };
      },
    }, {
      reserveTokens: 100,
      keepRecentTokens: 100,
      charsPerToken: 1,
      maxSummaryOutputTokens: 100,
      toolResultMaxChars: 100,
    });
    const call = {
      id: "call-1",
      name: "read",
      arguments: { path: "old.txt" },
    };

    const preparation = service.prepare({
      model: {
        id: "fake-model",
        name: "Fake",
        provider: "fake",
        contextWindow: 4_000,
        maxOutputTokens: 100,
      },
      turns: [{
        firstEntryId: "user-1",
        messageEntryIds: [
          "user-1",
          "assistant-call",
          "tool-1",
          "assistant-final",
        ],
        messages: [
          { role: "user", content: "old request" },
          { role: "assistant", content: "", toolCalls: [call] },
          {
            role: "tool",
            toolCallId: call.id,
            content: "r".repeat(200),
            isError: false,
          },
          { role: "assistant", content: "recent answer", toolCalls: [] },
        ],
      }],
      force: true,
      toolDefinitions: [],
    });

    expect(preparation?.firstKeptEntryId).toBe("assistant-final");
    expect(preparation?.keptTurns[0]?.messages[0]?.role).toBe("assistant");
  });

  test("fails closed when forced compaction has only one small complete turn", () => {
    const service = new CompactionService({
      async *stream(): AsyncIterable<StreamEvent> {
        yield { type: "done", reason: "stop" };
      },
    }, {
      reserveTokens: 100,
      keepRecentTokens: 1_000,
      charsPerToken: 1,
      maxSummaryOutputTokens: 100,
      toolResultMaxChars: 100,
    });

    expect(() => service.prepare({
      model: {
        id: "fake-model",
        name: "Fake",
        provider: "fake",
        contextWindow: 4_000,
        maxOutputTokens: 100,
      },
      turns: [{
        firstEntryId: "only-user",
        messageEntryIds: ["only-user", "only-assistant"],
        messages: [
          { role: "user", content: "small request" },
          { role: "assistant", content: "small answer", toolCalls: [] },
        ],
      }],
      force: true,
      toolDefinitions: [],
    })).toThrow(/only active turn.*safe message boundary/i);
  });

  test("keeps a continuation sequence atomic across compaction, reload, and resume", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "ai-agent-compact-continuation-"));
    cleanup.push(rootDir);
    const model = {
      id: "fake-model",
      name: "Fake",
      provider: "fake" as const,
      contextWindow: 5_000,
      maxOutputTokens: 100,
    };
    const sessionId = "continuation-atomic-compaction";
    const store = new JsonlSessionStore({ rootDir, sessionId, model });
    await store.load();
    const session = new Session(store);
    const firstContent = "first segment ".repeat(50);
    const secondContent = "second segment";
    const logicalContent = firstContent + secondContent;
    const entries = await session.appendMessages([
      { role: "user", content: "continue this answer" },
      {
        role: "assistant",
        content: firstContent,
        toolCalls: [],
        providerState: {
          provider: "openai-codex",
          value: { replay: [{ type: "reasoning", id: "reasoning-0" }] },
        },
        continuation: {
          logicalMessageId: "logical-atomic",
          segmentIndex: 0,
          status: "partial",
          resumeAllowed: true,
          tailHash: continuationTailHash(firstContent),
          estimatedTotalOutputTokens: 200,
        },
      },
      {
        role: "assistant",
        content: secondContent,
        toolCalls: [],
        providerState: {
          provider: "openai-codex",
          value: { replay: [{ type: "reasoning", id: "reasoning-1" }] },
        },
        continuation: {
          logicalMessageId: "logical-atomic",
          segmentIndex: 1,
          status: "partial",
          resumeAllowed: true,
          tailHash: continuationTailHash(logicalContent),
          estimatedTotalOutputTokens: 220,
        },
      },
    ]);
    const firstSegmentEntry = entries[1];
    if (firstSegmentEntry === undefined) {
      throw new Error("Expected a durable first continuation segment.");
    }
    const compaction = new CompactionService({
      async *stream(): AsyncIterable<StreamEvent> {
        yield { type: "text-delta", delta: "compact summary" };
        yield { type: "done", reason: "stop" };
      },
    }, {
      reserveTokens: 100,
      keepRecentTokens: 600,
      charsPerToken: 1,
      maxSummaryOutputTokens: 100,
      toolResultMaxChars: 100,
    });
    const coordinator = new SessionContextCoordinator(
      session,
      compaction,
      new ContextBudgetCalculator(new TokenEstimator(1)),
    );

    await collect(coordinator.compact({
      model,
      messages: [...session.buildActiveMessages()],
      tools: [],
    }, "manual"));

    expect(session.getPreviousCompaction()?.firstKeptEntryId).toBe(
      firstSegmentEntry.id,
    );

    const reloadedStore = new JsonlSessionStore({ rootDir, sessionId, model });
    await reloadedStore.load();
    const reloadedSession = new Session(reloadedStore);
    const requests: ModelRequest[] = [];
    const chat = new ChatSession(
      new AgentLoop({
        async *stream(request): AsyncIterable<StreamEvent> {
          requests.push(structuredClone(request));
          yield { type: "text-delta", delta: " final" };
          yield { type: "done", reason: "stop" };
        },
      }, new ToolRegistry()),
      model,
      { session: reloadedSession },
    );

    const events = await collect(chat.streamContinuation());

    expect(events.at(-1)).toMatchObject({ type: "done", reason: "stop" });
    expect(requests).toHaveLength(1);
    expect(requests[0]?.continuation).toMatchObject({
      logicalMessageId: "logical-atomic",
      segmentIndex: 2,
      previousTailHash: continuationTailHash(logicalContent),
    });
    expect(
      requests[0]?.messages
        .flatMap((message) =>
          message.role === "assistant" &&
            message.continuation?.logicalMessageId === "logical-atomic"
            ? [message.providerState?.value]
            : []
        ),
    ).toEqual([
      { replay: [{ type: "reasoning", id: "reasoning-0" }] },
      { replay: [{ type: "reasoning", id: "reasoning-1" }] },
    ]);
  });

  test("rejects a previous compaction that re-enters midway through a continuation", () => {
    const service = new CompactionService({
      async *stream(): AsyncIterable<StreamEvent> {
        yield { type: "done", reason: "stop" };
      },
    }, {
      reserveTokens: 100,
      keepRecentTokens: 1_000,
      charsPerToken: 1,
      maxSummaryOutputTokens: 100,
      toolResultMaxChars: 100,
    });
    const logicalContent = "firstsecond";

    expect(() => service.prepare({
      model: {
        id: "fake-model",
        name: "Fake",
        provider: "fake",
        contextWindow: 4_000,
        maxOutputTokens: 100,
      },
      turns: [{
        firstEntryId: "user",
        messageEntryIds: ["user", "segment-0", "segment-1"],
        messages: [
          { role: "user", content: "continue" },
          {
            role: "assistant",
            content: "first",
            toolCalls: [],
            continuation: {
              logicalMessageId: "logical-unsafe",
              segmentIndex: 0,
              status: "partial",
              resumeAllowed: true,
              tailHash: continuationTailHash("first"),
              estimatedTotalOutputTokens: 2,
            },
          },
          {
            role: "assistant",
            content: "second",
            toolCalls: [],
            continuation: {
              logicalMessageId: "logical-unsafe",
              segmentIndex: 1,
              status: "partial",
              resumeAllowed: true,
              tailHash: continuationTailHash(logicalContent),
              estimatedTotalOutputTokens: 4,
            },
          },
        ],
      }],
      previousCompaction: {
        summary: "unsafe summary",
        firstKeptEntryId: "segment-1",
        details: { readFiles: [], modifiedFiles: [] },
      },
      force: true,
      toolDefinitions: [],
    })).toThrow(/unsafe continuation boundary/i);
  });

  test("compacts again after an assistant-start compaction without rewriting history", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "ai-agent-recompact-"));
    cleanup.push(rootDir);
    const model = {
      id: "fake-model",
      name: "Fake",
      provider: "fake" as const,
      contextWindow: 4_000,
      maxOutputTokens: 100,
    };
    const store = new JsonlSessionStore({
      rootDir,
      sessionId: "assistant-start-recompact",
      model,
    });
    await store.load();
    const session = new Session(store);
    const initialEntries = await session.appendMessages([
      { role: "user", content: "old request" },
      {
        role: "assistant",
        content: "",
        toolCalls: [{
          id: "call-1",
          name: "read",
          arguments: { path: "old.txt" },
        }],
      },
      {
        role: "tool",
        toolCallId: "call-1",
        content: "r".repeat(200),
        isError: false,
      },
      { role: "assistant", content: "recent answer", toolCalls: [] },
    ]);
    const assistantFinalEntry = initialEntries[3];
    if (assistantFinalEntry === undefined) {
      throw new Error("Expected a durable final assistant entry.");
    }
    let summaryCount = 0;
    const service = new CompactionService({
      async *stream(): AsyncIterable<StreamEvent> {
        summaryCount += 1;
        yield { type: "text-delta", delta: `summary-${summaryCount}` };
        yield { type: "done", reason: "stop" };
      },
    }, {
      reserveTokens: 100,
      keepRecentTokens: 140,
      charsPerToken: 1,
      maxSummaryOutputTokens: 100,
      toolResultMaxChars: 100,
    });
    const coordinator = new SessionContextCoordinator(
      session,
      service,
      new ContextBudgetCalculator(new TokenEstimator(1)),
    );

    const firstEvents = await collect(coordinator.compact({
      model,
      messages: [...session.buildActiveMessages()],
      tools: [],
    }, "manual"));

    expect(firstEvents.map((event) => event.type)).toEqual([
      "compaction-start",
      "compaction-done",
    ]);
    expect(session.getPreviousCompaction()?.firstKeptEntryId).toBe(
      assistantFinalEntry.id,
    );

    await session.appendMessages([
      { role: "user", content: "next question" },
      { role: "assistant", content: "next answer", toolCalls: [] },
    ]);
    const journalBeforeSecond = structuredClone(store.getEntries());

    const secondEvents = await collect(coordinator.compact({
      model,
      messages: [...session.buildActiveMessages()],
      tools: [],
    }, "overflow"));

    expect(secondEvents).toEqual([
      expect.objectContaining({ type: "compaction-start", reason: "overflow" }),
      expect.objectContaining({ type: "compaction-done", reason: "overflow" }),
    ]);
    expect(store.getEntries().slice(0, journalBeforeSecond.length)).toEqual(
      journalBeforeSecond,
    );

    const reloadedStore = new JsonlSessionStore({
      rootDir,
      sessionId: "assistant-start-recompact",
      model,
    });
    await reloadedStore.load();
    expect(
      reloadedStore.getEntries().slice(0, journalBeforeSecond.length),
    ).toEqual(journalBeforeSecond);
  });

  test("never starts a compacted suffix with a tool result", () => {
    const service = new CompactionService({
      async *stream(): AsyncIterable<StreamEvent> {
        yield { type: "done", reason: "stop" };
      },
    }, {
      reserveTokens: 100,
      keepRecentTokens: 120,
      charsPerToken: 1,
      maxSummaryOutputTokens: 100,
      toolResultMaxChars: 100,
    });
    const call = {
      id: "call-1",
      name: "read",
      arguments: { path: "old.txt" },
    };

    expect(() => service.prepare({
      model: {
        id: "fake-model",
        name: "Fake",
        provider: "fake",
        contextWindow: 4_000,
        maxOutputTokens: 100,
      },
      turns: [{
        firstEntryId: "user-1",
        messageEntryIds: ["user-1", "assistant-call", "tool-1"],
        messages: [
          { role: "user", content: "old request" },
          {
            role: "assistant",
            content: "x".repeat(100),
            toolCalls: [call],
          },
          {
            role: "tool",
            toolCallId: call.id,
            content: "result",
            isError: false,
          },
        ],
      }],
      force: true,
      toolDefinitions: [],
    })).toThrow("single message is too large");
  });

  test("summarizes oversized evicted history in complete-turn batches", async () => {
    const requests: ModelRequest[] = [];
    const runner: ModelStreamRunner = {
      async *stream(request: ModelRequest): AsyncIterable<StreamEvent> {
        requests.push(structuredClone(request));
        yield { type: "text-delta", delta: `summary-${requests.length}` };
        yield { type: "done", reason: "stop" };
      },
    };
    const service = new CompactionService(runner, {
      reserveTokens: 100,
      keepRecentTokens: 100,
      charsPerToken: 1,
      maxSummaryOutputTokens: 100,
      toolResultMaxChars: 2_000,
    });
    const evictedTurns = ["turn-1", "turn-2", "turn-3"].map((firstEntryId) => ({
      firstEntryId,
      messages: [
        { role: "user" as const, content: "q".repeat(700) },
        { role: "assistant" as const, content: "a", toolCalls: [] },
      ],
    }));

    await service.compact({
      model: {
        id: "summary-model",
        name: "Summary",
        provider: "fake",
        contextWindow: 2_500,
        maxOutputTokens: 100,
      },
      turnsToSummarize: evictedTurns,
      keptTurns: [{
        firstEntryId: "kept",
        messages: [
          { role: "user", content: "recent" },
          { role: "assistant", content: "answer", toolCalls: [] },
        ],
      }],
      pendingUserMessage: { role: "user", content: "continue" },
      toolDefinitions: [],
      firstKeptEntryId: "kept",
      tokensBefore: 2_400,
      inputBudget: 2_144,
      details: { readFiles: [], modifiedFiles: [] },
    });

    expect(requests.length).toBeGreaterThan(1);
    expect(requests[1]?.messages[0]).toMatchObject({
      role: "user",
      content: expect.stringContaining("<previous-summary>\nsummary-1"),
    });
  });

  test("persists a pending user once beneath compaction before the agent provider runs", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "ai-agent-compaction-"));
    cleanup.push(rootDir);
    const model = {
      id: "fake-model",
      name: "Fake",
      provider: "fake" as const,
      contextWindow: 4_000,
      maxOutputTokens: 100,
    };
    const store = new JsonlSessionStore({
      rootDir,
      sessionId: "pending-user-order",
      model,
    });
    await store.load();
    const session = new Session(store);
    const long = "x".repeat(900);
    await session.appendMessages([
      { role: "user", content: long },
      { role: "assistant", content: long, toolCalls: [] },
    ]);
    await session.appendMessages([
      { role: "user", content: long },
      { role: "assistant", content: long, toolCalls: [] },
    ]);
    await session.appendMessages([
      { role: "user", content: "recent question" },
      { role: "assistant", content: "recent answer", toolCalls: [] },
    ]);
    const summaryRunner: ModelStreamRunner = {
      async *stream(): AsyncIterable<StreamEvent> {
        yield { type: "start" };
        yield { type: "text-delta", delta: "stable summary" };
        yield { type: "done", reason: "stop" };
      },
    };
    const requests: ModelRequest[] = [];
    const agentRunner: ModelStreamRunner = {
      async *stream(request: ModelRequest): AsyncIterable<StreamEvent> {
        requests.push(structuredClone(request));
        yield { type: "start" };
        yield {
          type: "error",
          reason: "error",
          error: new Error("agent provider failed"),
        };
      },
    };
    const chat = new ChatSession(
      new AgentLoop(agentRunner, new ToolRegistry()),
      model,
      {
        session,
        compactionService: new CompactionService(summaryRunner, {
          reserveTokens: 100,
          keepRecentTokens: 180,
          charsPerToken: 1,
          maxSummaryOutputTokens: 100,
          toolResultMaxChars: 100,
        }),
      },
    );

    const events = await collect(chat.streamTurn("continue once"));

    expect(events.at(-1)).toMatchObject({
      type: "error",
      error: { message: "agent provider failed" },
    });
    expect(
      requests[0]?.messages.filter(
        (message) =>
          message.role === "user" && message.content === "continue once",
      ),
    ).toHaveLength(1);
    const reloadedStore = new JsonlSessionStore({
      rootDir,
      sessionId: "pending-user-order",
      model,
    });
    await reloadedStore.load();
    const entries = reloadedStore.getEntries();
    const compaction = entries.find((entry) => entry.type === "compaction");
    const pendingUsers = entries.filter(
      (entry) =>
        entry.type === "message" &&
        entry.message.role === "user" &&
        entry.message.content === "continue once",
    );

    expect(compaction).toBeDefined();
    expect(pendingUsers).toHaveLength(1);
    expect(pendingUsers[0]?.parentId).toBe(compaction?.id);
  }, 15_000);

  test("does not journal a pending user when coordinator compaction fails", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "ai-agent-compaction-fail-"));
    cleanup.push(rootDir);
    const model = {
      id: "fake-model",
      name: "Fake",
      provider: "fake" as const,
      contextWindow: 4_000,
      maxOutputTokens: 100,
    };
    const store = new JsonlSessionStore({
      rootDir,
      sessionId: "pending-user-failure",
      model,
    });
    await store.load();
    const session = new Session(store);
    const long = "x".repeat(900);
    for (let index = 0; index < 3; index += 1) {
      await session.appendMessages([
        { role: "user", content: `${index}:${long}` },
        { role: "assistant", content: long, toolCalls: [] },
      ]);
    }
    const compaction = new CompactionService({
      async *stream(): AsyncIterable<StreamEvent> {
        yield { type: "error", reason: "error", error: new Error("summary failed") };
      },
    }, {
      reserveTokens: 100,
      keepRecentTokens: 1_000,
      charsPerToken: 1,
      maxSummaryOutputTokens: 100,
      toolResultMaxChars: 1_000,
    });
    const coordinator = new SessionContextCoordinator(
      session,
      compaction,
      new ContextBudgetCalculator(new TokenEstimator(1)),
    );
    const chat = new ChatSession(
      new AgentLoop({
        async *stream(): AsyncIterable<StreamEvent> {
          throw new Error("Provider must not run");
        },
      }, new ToolRegistry(), undefined, coordinator),
      model,
      { session, contextCoordinator: coordinator },
    );

    const events = await collect(chat.streamTurn("must stay pending-only"));

    expect(events.at(-1)).toMatchObject({
      type: "error",
      error: { message: "summary failed" },
    });
    expect(session.getMessages()).not.toContainEqual({
      role: "user",
      content: "must stay pending-only",
    });
  }, 15_000);
});
