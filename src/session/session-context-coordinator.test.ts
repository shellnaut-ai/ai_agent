import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import { ContextBudgetCalculator } from "../context/budget.js";
import { CompactionService } from "../context/compaction.js";
import { TokenEstimator } from "../context/token-estimator.js";
import type { ModelStreamRunner } from "../model/runtime.js";
import type { ModelRequest, StreamEvent } from "../model/types.js";
import { JsonlSessionStore } from "./jsonl-store.js";
import { Session } from "./session.js";
import { SessionContextCoordinator } from "./session-context-coordinator.js";

const cleanup: string[] = [];

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((path) =>
    rm(path, { recursive: true, force: true })
  ));
});

async function collect<T>(stream: AsyncIterable<T>): Promise<T[]> {
  const events: T[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

describe("SessionContextCoordinator", () => {
  test("compacts old complete turns before returning an over-budget model request", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "ai-agent-context-coordinator-"));
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
      sessionId: "coordinator-compaction",
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
    await session.appendMessage({ role: "user", content: "current" });

    const summaryRunner: ModelStreamRunner = {
      async *stream(): AsyncIterable<StreamEvent> {
        yield { type: "text-delta", delta: "stable summary" };
        yield { type: "done", reason: "stop" };
      },
    };
    const estimator = new TokenEstimator(1);
    const coordinator = new SessionContextCoordinator(
      session,
      new CompactionService(summaryRunner, {
        reserveTokens: 100,
        keepRecentTokens: 1_000,
        charsPerToken: 1,
        maxSummaryOutputTokens: 100,
        toolResultMaxChars: 1_000,
      }),
      new ContextBudgetCalculator(estimator),
    );
    const request: ModelRequest = {
      model,
      messages: [...session.buildActiveMessages()],
      tools: [],
    };

    const events = await collect(coordinator.prepareModelRequest(request));

    expect(events.map((event) => event.type)).toEqual([
      "compaction-start",
      "compaction-done",
      "model-input-ready",
    ]);
    const ready = events.at(-1);
    expect(ready).toMatchObject({
      type: "model-input-ready",
      budget: { remainingInputTokens: expect.any(Number) },
    });
    if (ready?.type !== "model-input-ready") {
      throw new Error("Expected a ready model input");
    }
    expect(ready.budget.remainingInputTokens).toBeGreaterThanOrEqual(0);
    expect(store.getEntries().some((entry) => entry.type === "compaction"))
      .toBe(true);
  }, 15_000);
});
