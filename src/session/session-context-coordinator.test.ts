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
  test("rejects caller messages that do not match the durable session tail", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "ai-agent-context-tail-"));
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
      sessionId: "coordinator-tail-mismatch",
      model,
    });
    await store.load();
    const session = new Session(store);
    await session.appendMessage({ role: "user", content: "durable" });
    const coordinator = new SessionContextCoordinator(
      session,
      new CompactionService({
        async *stream(): AsyncIterable<StreamEvent> {
          yield { type: "done", reason: "stop" };
        },
      }, {
        reserveTokens: 100,
        keepRecentTokens: 1_000,
        charsPerToken: 1,
        maxSummaryOutputTokens: 100,
        toolResultMaxChars: 1_000,
      }),
      new ContextBudgetCalculator(new TokenEstimator(1)),
    );

    await expect(collect(coordinator.prepareModelRequest({
      model,
      messages: [{ role: "user", content: "not durable" }],
      tools: [],
    }))).rejects.toThrow(/session.*messages|durable.*tail|synchron/i);
  });

  test("includes the system prompt when deciding whether to compact", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "ai-agent-context-system-"));
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
      sessionId: "coordinator-system-prompt",
      model,
    });
    await store.load();
    const session = new Session(store);
    const long = "x".repeat(600);
    for (let index = 0; index < 2; index += 1) {
      await session.appendMessages([
        { role: "user", content: `${index}:${long}` },
        { role: "assistant", content: long, toolCalls: [] },
      ]);
    }
    const coordinator = new SessionContextCoordinator(
      session,
      new CompactionService({
        async *stream(): AsyncIterable<StreamEvent> {
          yield { type: "text-delta", delta: "summary" };
          yield { type: "done", reason: "stop" };
        },
      }, {
        reserveTokens: 100,
        keepRecentTokens: 1_000,
        charsPerToken: 1,
        maxSummaryOutputTokens: 100,
        toolResultMaxChars: 1_000,
      }),
      new ContextBudgetCalculator(new TokenEstimator(1)),
    );
    const messages = [...session.buildActiveMessages()];
    const events = await collect(coordinator.prepareModelRequest({
      model,
      systemPrompt: "s".repeat(1_500),
      messages,
      tools: [],
    }));

    expect(events.map((event) => event.type)).toEqual([
      "compaction-start",
      "compaction-done",
      "model-input-ready",
    ]);
  }, 15_000);

  test("returns a canonical projection after tool-result reservation compaction", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "ai-agent-context-reserve-"));
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
      sessionId: "coordinator-reserve-compaction",
      model,
    });
    await store.load();
    const session = new Session(store);
    const long = "x".repeat(800);
    for (let index = 0; index < 2; index += 1) {
      await session.appendMessages([
        { role: "user", content: `${index}:${long}` },
        { role: "assistant", content: long, toolCalls: [] },
      ]);
    }
    await session.appendMessages([
      { role: "user", content: "run two tools" },
      {
        role: "assistant",
        content: "",
        toolCalls: [
          { id: "call-1", name: "read", arguments: {} },
          { id: "call-2", name: "read", arguments: {} },
        ],
      },
    ]);
    const coordinator = new SessionContextCoordinator(
      session,
      new CompactionService({
        async *stream(): AsyncIterable<StreamEvent> {
          yield { type: "text-delta", delta: "summary" };
          yield { type: "done", reason: "stop" };
        },
      }, {
        reserveTokens: 100,
        keepRecentTokens: 1_000,
        charsPerToken: 1,
        maxSummaryOutputTokens: 100,
        toolResultMaxChars: 1_000,
      }),
      new ContextBudgetCalculator(new TokenEstimator(1)),
    );
    const first = await collect(coordinator.reserveToolResult({
      model,
      messages: [...session.buildActiveMessages()],
      tools: [],
    }, { toolCallId: "call-1" }));
    const ready = first.at(-1);
    if (ready?.type !== "tool-result-budget-ready" || ready.request === undefined) {
      throw new Error("Expected canonical tool result reservation request.");
    }

    expect(first.map((event) => event.type)).toContain("compaction-done");
    await expect(collect(coordinator.reserveToolResult(
      ready.request,
      { toolCallId: "call-2" },
    ))).resolves.toBeDefined();
  }, 15_000);

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

  test("uses exact provider input tokens before estimator compaction", async () => {
    const fixture = await createCountingFixture("coordinator-exact-count");
    let counterCalls = 0;
    const counter = {
      async countInputTokens(): Promise<number | undefined> {
        counterCalls += 1;
        return counterCalls === 1 ? 9_000 : undefined;
      },
    };
    const coordinator = new SessionContextCoordinator(
      fixture.session,
      fixture.compaction,
      fixture.calculator,
      counter,
    );

    const events = await collect(
      coordinator.prepareModelRequest(fixture.request),
    );

    expect(counterCalls).toBe(2);
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: "compaction-start",
        reason: "threshold",
      }),
    ]));
    expect(events.at(-1)).toMatchObject({ type: "model-input-ready" });
  }, 15_000);

  test("falls back to estimated tokens when optional counting fails", async () => {
    const fixture = await createCountingFixture("coordinator-count-fallback");
    let counterCalls = 0;
    const counter = {
      async countInputTokens(): Promise<number> {
        counterCalls += 1;
        throw new Error("offline");
      },
    };
    const coordinator = new SessionContextCoordinator(
      fixture.session,
      fixture.compaction,
      fixture.calculator,
      counter,
    );

    const events = await collect(
      coordinator.prepareModelRequest(fixture.request),
    );

    expect(counterCalls).toBe(1);
    expect(events).toHaveLength(1);
    expect(events.at(-1)).toMatchObject({ type: "model-input-ready" });
  });

  test("does not hide an aborted token-count request", async () => {
    const fixture = await createCountingFixture("coordinator-count-abort");
    const controller = new AbortController();
    let counterCalls = 0;
    const counter = {
      async countInputTokens(): Promise<number> {
        counterCalls += 1;
        controller.abort();
        throw new Error("token count aborted");
      },
    };
    const coordinator = new SessionContextCoordinator(
      fixture.session,
      fixture.compaction,
      fixture.calculator,
      counter,
    );

    await expect(collect(coordinator.prepareModelRequest(fixture.request, {
      signal: controller.signal,
    }))).rejects.toThrow("token count aborted");
    expect(counterCalls).toBe(1);
  });
});

async function createCountingFixture(sessionId: string): Promise<{
  session: Session;
  compaction: CompactionService;
  calculator: ContextBudgetCalculator;
  request: ModelRequest;
}> {
  const rootDir = await mkdtemp(join(tmpdir(), "ai-agent-context-count-"));
  cleanup.push(rootDir);
  const model = {
    id: "fake-model",
    name: "Fake",
    provider: "fake" as const,
    contextWindow: 4_000,
    maxOutputTokens: 100,
  };
  const store = new JsonlSessionStore({ rootDir, sessionId, model });
  await store.load();
  const session = new Session(store);
  for (let index = 0; index < 2; index += 1) {
    await session.appendMessages([
      { role: "user", content: `${index}:${"q".repeat(150)}` },
      { role: "assistant", content: "a".repeat(150), toolCalls: [] },
    ]);
  }
  const compaction = new CompactionService({
    async *stream(): AsyncIterable<StreamEvent> {
      yield { type: "text-delta", delta: "stable summary" };
      yield { type: "done", reason: "stop" };
    },
  }, {
    reserveTokens: 100,
    keepRecentTokens: 450,
    charsPerToken: 1,
    maxSummaryOutputTokens: 100,
    toolResultMaxChars: 1_000,
  });
  const calculator = new ContextBudgetCalculator(new TokenEstimator(1));

  return {
    session,
    compaction,
    calculator,
    request: {
      model,
      messages: [...session.buildActiveMessages()],
      tools: [],
    },
  };
}
