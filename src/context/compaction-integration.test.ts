import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import { AgentLoop } from "../agent/loop.js";
import type { ModelStreamRunner } from "../model/runtime.js";
import type { ModelRequest, StreamEvent } from "../model/types.js";
import { ChatSession } from "../session/chat-session.js";
import { JsonlSessionStore } from "../session/jsonl-store.js";
import { Session } from "../session/session.js";
import { ToolRegistry } from "../tools/registry.js";
import { CompactionService } from "./compaction.js";

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
    const long = "x".repeat(420);
    const preparation = service.prepare({
      model: {
        id: "fake-model",
        name: "Fake",
        provider: "fake",
        contextWindow: 1_000,
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
    expect(preparation?.turnsToSummarize.map((turn) => turn.firstEntryId))
      .toEqual(["turn-1", "turn-2"]);
    expect(preparation?.firstKeptEntryId).toBe("turn-3");

    const result = await service.compact(preparation!);

    expect(result.summary).toContain("stable summary");
    expect(result.firstKeptEntryId).toBe("turn-3");
    expect(result.tokensAfter).toBeLessThan(result.tokensBefore);
  });

  test("persists a pending user once beneath compaction before the agent provider runs", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "ai-agent-compaction-"));
    cleanup.push(rootDir);
    const model = {
      id: "fake-model",
      name: "Fake",
      provider: "fake" as const,
      contextWindow: 1_000,
      maxOutputTokens: 100,
    };
    const store = new JsonlSessionStore({
      rootDir,
      sessionId: "pending-user-order",
      model,
    });
    await store.load();
    const session = new Session(store);
    const long = "x".repeat(420);
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
  });
});
