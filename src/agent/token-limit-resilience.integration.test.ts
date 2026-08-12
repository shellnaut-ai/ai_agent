import { randomBytes } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import { ContextBudgetCalculator } from "../context/budget.js";
import { CompactionService } from "../context/compaction.js";
import { TokenEstimator } from "../context/token-estimator.js";
import type { ModelStreamRunner } from "../model/runtime.js";
import type { ModelRequest, StreamEvent } from "../model/types.js";
import { ChatSession } from "../session/chat-session.js";
import { JsonlSessionStore } from "../session/jsonl-store.js";
import { SessionContextCoordinator } from "../session/session-context-coordinator.js";
import { Session } from "../session/session.js";
import { ReadTool } from "../tools/read.js";
import { ToolRegistry } from "../tools/registry.js";
import { AgentLoop } from "./loop.js";

const cleanup: string[] = [];

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((path) =>
    rm(path, { recursive: true, force: true })
  ));
});

describe("token limit resilience", () => {
  test("compacts, reads two pages, and joins two output continuations", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "pi-clone-token-resilience-"));
    cleanup.push(rootDir);
    await writeFile(join(rootDir, "large.txt"), "r".repeat(1000), "utf8");
    const model = {
      id: "fake-model",
      name: "Fake",
      provider: "fake" as const,
      contextWindow: 5500,
      maxOutputTokens: 100,
    };
    const store = new JsonlSessionStore({
      rootDir,
      sessionId: "full-overflow-sequence",
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

    const calculator = new ContextBudgetCalculator(new TokenEstimator(1));
    const providerRequests: ModelRequest[] = [];
    const runner: ModelStreamRunner = {
      async *stream(request): AsyncIterable<StreamEvent> {
        if (request.systemPrompt?.includes("context summarization")) {
          yield { type: "text-delta", delta: "durable compact summary" };
          yield { type: "done", reason: "stop" };
          return;
        }
        calculator.assertFits(request);
        providerRequests.push(structuredClone(request));
        const call = providerRequests.length;
        if (call === 1) {
          yield {
            type: "tool-call",
            toolCall: { id: "read-1", name: "read", arguments: { path: "large.txt" } },
          };
          yield { type: "done", reason: "tool-call" };
          return;
        }
        if (call === 2) {
          const result = request.messages.at(-1);
          if (result?.role !== "tool") throw new Error("Expected first read result.");
          const cursor = /"nextCursor":"([^"]+)"/u.exec(result.content)?.[1];
          if (cursor === undefined) throw new Error("Expected next read cursor.");
          yield {
            type: "tool-call",
            toolCall: { id: "read-2", name: "read", arguments: { cursor } },
          };
          yield { type: "done", reason: "tool-call" };
          return;
        }
        const output = call === 3
          ? { text: "alpha beta ", reason: "length" as const }
          : call === 4
            ? { text: "beta gamma ", reason: "length" as const }
            : { text: "gamma delta", reason: "stop" as const };
        yield { type: "text-delta", delta: output.text };
        yield {
          type: "done",
          reason: output.reason,
          providerState: { provider: "fake", value: { segment: call } },
        };
      },
    };
    const tools = new ToolRegistry();
    tools.register(new ReadTool({
      rootDir,
      maxBytes: 900,
      cursorKey: randomBytes(32),
    }));
    const compaction = new CompactionService(runner, {
      reserveTokens: 100,
      keepRecentTokens: 1000,
      charsPerToken: 1,
      maxSummaryOutputTokens: 100,
      toolResultMaxChars: 1000,
    });
    const coordinator = new SessionContextCoordinator(
      session,
      compaction,
      calculator,
    );
    const chat = new ChatSession(
      new AgentLoop(runner, tools, undefined, coordinator),
      model,
      {
        session,
        contextCoordinator: coordinator,
        toolDefinitions: tools.listDefinitions(),
      },
    );

    const events = await collect(chat.streamTurn("handle every overflow"));
    const earlyError = events.find((event) => event.type === "error");
    if (earlyError?.type === "error") throw earlyError.error;

    expect(events.map((event) => event.type)).toEqual(expect.arrayContaining([
      "compaction-start",
      "compaction-done",
      "tool-result",
      "done",
    ]));
    expect(events.filter((event) => event.type === "tool-result")).toHaveLength(2);
    expect(events.filter((event) => event.type === "text-delta")
      .map((event) => event.delta).join(""))
      .toBe("alpha beta gamma delta");
    expect(providerRequests).toHaveLength(5);
    expect(providerRequests[3]?.continuation?.segmentIndex).toBe(1);
    expect(providerRequests[4]?.continuation?.segmentIndex).toBe(2);

    const reloadedStore = new JsonlSessionStore({
      rootDir,
      sessionId: "full-overflow-sequence",
      model,
    });
    await reloadedStore.load();
    const reloaded = new Session(reloadedStore);
    expect(reloaded.buildDisplayMessages().at(-1)).toMatchObject({
      role: "assistant",
      content: "alpha beta gamma delta",
      continuation: { status: "complete" },
      providerState: { value: { segment: 5 } },
    });
  }, 20_000);
});

async function collect<T>(stream: AsyncIterable<T>): Promise<T[]> {
  const events: T[] = [];
  for await (const event of stream) events.push(event);
  return events;
}
