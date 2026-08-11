import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Type } from "typebox";
import { afterEach, describe, expect, test } from "vitest";

import { AgentLoop } from "../agent/loop.js";
import { continuationTailHash } from "../agent/output-continuation.js";
import type { ModelStreamRunner } from "../model/runtime.js";
import type {
  Message,
  ModelRequest,
  StreamEvent,
} from "../model/types.js";
import { ToolRegistry } from "../tools/registry.js";
import type { Tool } from "../tools/types.js";
import { ChatSession } from "./chat-session.js";
import { JsonlSessionStore } from "./jsonl-store.js";
import { Session } from "./session.js";
import type { ChatEvent, SessionEntry } from "./types.js";

const cleanup: string[] = [];

afterEach(async () => {
  await Promise.all(
    cleanup.splice(0).map((path) =>
      rm(path, { recursive: true, force: true }),
    ),
  );
});

const model = {
  id: "fake-model",
  name: "Fake",
  provider: "fake" as const,
  contextWindow: 4096,
  maxOutputTokens: 1024,
};

const interruptedToolResultContent =
  "Tool execution was interrupted before its result was recorded. " +
  "The outcome is unknown. Inspect workspace state before retrying " +
  "this operation.";

async function collect<T>(stream: AsyncIterable<T>): Promise<T[]> {
  const events: T[] = [];

  for await (const event of stream) {
    events.push(event);
  }

  return events;
}

async function createStore(
  sessionId: string,
): Promise<{
  rootDir: string;
  store: FailingJsonlSessionStore;
}> {
  const rootDir = await mkdtemp(join(tmpdir(), "ai-agent-chat-session-"));
  cleanup.push(rootDir);
  const store = new FailingJsonlSessionStore({
    rootDir,
    sessionId,
    model,
  });
  await store.load();

  return { rootDir, store };
}

async function reloadSession(
  rootDir: string,
  sessionId: string,
): Promise<{
  session: Session;
  store: JsonlSessionStore;
}> {
  const store = new JsonlSessionStore({ rootDir, sessionId, model });
  await store.load();

  return { session: new Session(store), store };
}

function createMutatingTool(
  onExecute: () => void,
): { registry: ToolRegistry; tool: Tool } {
  const tool: Tool = {
    approval: "never",
    definition: {
      name: "write-test",
      description: "Mutates test state.",
      inputSchema: Type.Object({}, { additionalProperties: false }),
    },
    async execute() {
      onExecute();
      return { content: "written", isError: false };
    },
  };
  const registry = new ToolRegistry();
  registry.register(tool);

  return { registry, tool };
}

function createToolThenRunner(
  secondCall: "error" | "stop",
  toolCallCount = 1,
): {
  runner: ModelStreamRunner;
  getProviderCalls(): number;
} {
  let providerCalls = 0;
  const runner: ModelStreamRunner = {
    async *stream(_request: ModelRequest): AsyncIterable<StreamEvent> {
      providerCalls += 1;
      yield { type: "start" };

      if (providerCalls === 1) {
        for (let index = 1; index <= toolCallCount; index += 1) {
          yield {
            type: "tool-call",
            toolCall: {
              id: `call-${index}`,
              name: "write-test",
              arguments: {},
            },
          };
        }
        yield { type: "done", reason: "tool-call" };
        return;
      }

      if (secondCall === "error") {
        yield {
          type: "error",
          reason: "error",
          error: new Error("follow-up provider failed"),
        };
        return;
      }

      yield { type: "text-delta", delta: "finished" };
      yield { type: "done", reason: "stop" };
    },
  };

  return {
    runner,
    getProviderCalls: () => providerCalls,
  };
}

describe("ChatSession incremental journal", () => {
  test("requires explicit recovery before resuming a durable partial", async () => {
    const { store } = await createStore("continuation-recovery");
    const session = new Session(store);
    await session.appendMessage({ role: "user", content: "write" });
    await session.appendMessage({
      role: "assistant",
      content: "durable partial",
      toolCalls: [],
      continuation: {
        logicalMessageId: "recover-logical",
        segmentIndex: 0,
        status: "partial",
        resumeAllowed: true,
        tailHash: continuationTailHash("durable partial"),
        estimatedTotalOutputTokens: 8,
      },
    });
    let providerCalls = 0;
    const runner: ModelStreamRunner = {
      async *stream(request): AsyncIterable<StreamEvent> {
        providerCalls += 1;
        expect(request.continuation).toMatchObject({
          logicalMessageId: "recover-logical",
          segmentIndex: 1,
        });
        yield { type: "text-delta", delta: " final" };
        yield { type: "done", reason: "stop" };
      },
    };
    const chat = new ChatSession(
      new AgentLoop(runner, new ToolRegistry()),
      model,
      { session },
    );

    await expect(collect(chat.streamTurn("must not append"))).resolves.toEqual([
      {
        type: "continuation-recovery-required",
        continuation: expect.objectContaining({ logicalMessageId: "recover-logical" }),
      },
    ]);
    expect(providerCalls).toBe(0);
    expect(session.getMessages()).not.toContainEqual({
      role: "user",
      content: "must not append",
    });

    const events = await collect(chat.streamContinuation());
    expect(providerCalls).toBe(1);
    expect(events.at(-1)).toMatchObject({ type: "done", reason: "stop" });
    expect(session.buildDisplayMessages().at(-1)).toMatchObject({
      role: "assistant",
      content: "durable partial final",
      continuation: { status: "complete" },
    });
  });

  test("persists every automatic continuation segment before the next call", async () => {
    const { rootDir, store } = await createStore("automatic-continuation");
    const requests: ModelRequest[] = [];
    const runner: ModelStreamRunner = {
      async *stream(request): AsyncIterable<StreamEvent> {
        requests.push(structuredClone(request));
        yield { type: "text-delta", delta: requests.length === 1 ? "part one " : "part two" };
        yield {
          type: "done",
          reason: requests.length === 1 ? "length" : "stop",
          providerState: {
            provider: "fake",
            value: { segment: requests.length },
          },
        };
      },
    };
    const chat = new ChatSession(
      new AgentLoop(runner, new ToolRegistry()),
      model,
      { session: new Session(store) },
    );

    const events = await collect(chat.streamTurn("continue it"));
    const reloaded = await reloadSession(rootDir, "automatic-continuation");
    const activeAssistants = reloaded.session.buildActiveMessages()
      .filter((message) => message.role === "assistant");

    expect(requests).toHaveLength(2);
    expect(requests[1]?.messages.at(-1)).toMatchObject({
      role: "assistant",
      content: "part one ",
      continuation: { status: "partial" },
      providerState: { value: { segment: 1 } },
    });
    expect(activeAssistants.map((message) => message.content))
      .toEqual(["part one ", "part two"]);
    expect(reloaded.session.buildDisplayMessages().at(-1)).toMatchObject({
      role: "assistant",
      content: "part one part two",
      continuation: { status: "complete" },
    });
    expect(events.at(-1)).toMatchObject({ type: "done", reason: "stop" });
  });

  test("rejects a concurrent turn until the active consumer returns", async () => {
    const { store } = await createStore("single-flight");
    let providerCalls = 0;
    const runner: ModelStreamRunner = {
      async *stream(): AsyncIterable<StreamEvent> {
        providerCalls += 1;
        yield { type: "start" };
        yield { type: "done", reason: "stop" };
      },
    };
    const chat = new ChatSession(
      new AgentLoop(runner, new ToolRegistry()),
      model,
      { session: new Session(store) },
    );
    const first = chat.streamTurn("first")[Symbol.asyncIterator]();

    await expect(first.next()).resolves.toEqual({
      done: false,
      value: { type: "start" },
    });
    await expect(collect(chat.streamTurn("concurrent"))).resolves.toEqual([
      {
        type: "error",
        reason: "error",
        error: new Error("ChatSession already has an active turn."),
      },
    ]);
    expect(providerCalls).toBe(0);

    await first.return?.();
    const afterReturn = await collect(chat.streamTurn("after return"));

    expect(afterReturn.at(-1)).toMatchObject({
      type: "done",
      reason: "stop",
    });
    expect(providerCalls).toBe(1);
  });

  test("releases the turn guard after persistence, abort, Provider error, and success", async () => {
    const { store } = await createStore("single-flight-release");
    let providerCalls = 0;
    const runner: ModelStreamRunner = {
      async *stream(): AsyncIterable<StreamEvent> {
        providerCalls += 1;
        yield { type: "start" };

        if (providerCalls === 1) {
          yield {
            type: "error",
            reason: "error",
            error: new Error("provider failed"),
          };
          return;
        }

        yield { type: "done", reason: "stop" };
      },
    };
    const chat = new ChatSession(
      new AgentLoop(runner, new ToolRegistry()),
      model,
      { session: new Session(store) },
    );
    store.failMessageAppend("user", 1);

    expect((await collect(chat.streamTurn("persistence failure"))).at(-1))
      .toMatchObject({ type: "error", reason: "error" });

    const controller = new AbortController();
    controller.abort();
    expect((await collect(
      chat.streamTurn("aborted", { signal: controller.signal }),
    )).at(-1)).toMatchObject({ type: "error", reason: "aborted" });

    expect((await collect(chat.streamTurn("provider failure"))).at(-1))
      .toMatchObject({
        type: "error",
        error: { message: "provider failed" },
      });
    expect((await collect(chat.streamTurn("success"))).at(-1))
      .toMatchObject({ type: "done", reason: "stop" });
    expect((await collect(chat.streamTurn("after success"))).at(-1))
      .toMatchObject({ type: "done", reason: "stop" });
    expect(providerCalls).toBe(3);
  });

  test("does not execute a mutating tool when its assistant checkpoint append fails", async () => {
    const { rootDir, store } = await createStore("checkpoint-failure");
    const session = new Session(store);
    let toolExecutions = 0;
    const { registry } = createMutatingTool(() => {
      toolExecutions += 1;
    });
    const { runner } = createToolThenRunner("stop");
    const chat = new ChatSession(
      new AgentLoop(runner, registry),
      model,
      { session },
    );
    store.failMessageAppend("assistant", 1);

    const events = await collect(chat.streamTurn("write the file"));

    expect(toolExecutions).toBe(0);
    expect(events.at(-1)).toMatchObject({
      type: "error",
      error: { message: "assistant checkpoint persistence failed" },
    });
    expect((await reloadSession(rootDir, "checkpoint-failure")).session
      .getMessages()).toEqual([
      { role: "user", content: "write the file" },
    ]);
  });

  test("keeps the exact tool result when only the follow-up provider call fails", async () => {
    const { rootDir, store } = await createStore("provider-after-result");
    let toolExecutions = 0;
    const { registry } = createMutatingTool(() => {
      toolExecutions += 1;
    });
    const { runner, getProviderCalls } = createToolThenRunner("error");
    const chat = new ChatSession(
      new AgentLoop(runner, registry),
      model,
      { session: new Session(store) },
    );

    const events = await collect(chat.streamTurn("write the file"));
    const reloaded = await reloadSession(rootDir, "provider-after-result");

    expect(events.at(-1)).toMatchObject({
      type: "error",
      error: { message: "follow-up provider failed" },
    });
    expect(toolExecutions).toBe(1);
    expect(getProviderCalls()).toBe(2);
    expect(reloaded.session.getMessages()).toEqual([
      { role: "user", content: "write the file" },
      {
        role: "assistant",
        content: "",
        toolCalls: [
          {
            id: "call-1",
            name: "write-test",
            arguments: {},
          },
        ],
      },
      {
        role: "tool",
        toolCallId: "call-1",
        content: "written",
        isError: false,
      },
    ]);
    await expect(
      reloaded.session.recoverInterruptedToolCalls(),
    ).resolves.toEqual([]);
  });

  test("recovers an unknown outcome without rerunning after tool-result append fails", async () => {
    const { rootDir, store } = await createStore("result-failure");
    let toolExecutions = 0;
    const { registry } = createMutatingTool(() => {
      toolExecutions += 1;
    });
    const { runner, getProviderCalls } = createToolThenRunner("stop");
    const chat = new ChatSession(
      new AgentLoop(runner, registry),
      model,
      { session: new Session(store) },
    );
    store.failMessageAppend("tool", 1);

    const events = await collect(chat.streamTurn("write the file"));

    expect(events.at(-1)).toMatchObject({
      type: "error",
      error: { message: "tool result persistence failed" },
    });
    expect(events.some((event) => event.type === "tool-result")).toBe(false);
    expect(toolExecutions).toBe(1);
    expect(getProviderCalls()).toBe(1);

    const reloaded = await reloadSession(rootDir, "result-failure");
    await expect(reloaded.session.recoverInterruptedToolCalls())
      .resolves.toEqual([
        {
          role: "tool",
          toolCallId: "call-1",
          content: interruptedToolResultContent,
          isError: true,
        },
      ]);
    expect(toolExecutions).toBe(1);
    expect(reloaded.session.getMessages().at(-1)).toEqual({
      role: "tool",
      toolCallId: "call-1",
      content: interruptedToolResultContent,
      isError: true,
    });
  });

  test("does not execute a later tool after the first result append fails", async () => {
    const { store } = await createStore("result-failure-stops-batch");
    let toolExecutions = 0;
    const { registry } = createMutatingTool(() => {
      toolExecutions += 1;
    });
    const { runner, getProviderCalls } = createToolThenRunner("stop", 2);
    const chat = new ChatSession(
      new AgentLoop(runner, registry),
      model,
      { session: new Session(store) },
    );
    store.failMessageAppend("tool", 1);

    const events = await collect(chat.streamTurn("write both files"));

    expect(events.at(-1)).toMatchObject({
      type: "error",
      error: { message: "tool result persistence failed" },
    });
    expect(toolExecutions).toBe(1);
    expect(getProviderCalls()).toBe(1);
  });

  test("persists an ordinary user message before a provider failure", async () => {
    const { rootDir, store } = await createStore("ordinary-provider-failure");
    const runner: ModelStreamRunner = {
      async *stream(): AsyncIterable<StreamEvent> {
        yield { type: "start" };
        yield {
          type: "error",
          reason: "error",
          error: new Error("provider unavailable"),
        };
      },
    };
    const chat = new ChatSession(
      new AgentLoop(runner, new ToolRegistry()),
      model,
      { session: new Session(store) },
    );

    const events = await collect(chat.streamTurn("keep this question"));

    expect(events.at(-1)).toMatchObject({
      type: "error",
      error: { message: "provider unavailable" },
    });
    expect((await reloadSession(rootDir, "ordinary-provider-failure"))
      .session.getMessages()).toEqual([
      { role: "user", content: "keep this question" },
    ]);
  });

  test("stops before the provider when the user append fails", async () => {
    const { rootDir, store } = await createStore("user-failure");
    let providerCalls = 0;
    const runner: ModelStreamRunner = {
      async *stream(): AsyncIterable<StreamEvent> {
        providerCalls += 1;
        yield { type: "start" };
        yield { type: "done", reason: "stop" };
      },
    };
    const chat = new ChatSession(
      new AgentLoop(runner, new ToolRegistry()),
      model,
      { session: new Session(store) },
    );
    store.failMessageAppend("user", 1);

    const events = await collect(chat.streamTurn("do not call provider"));

    expect(providerCalls).toBe(0);
    expect(events.at(-1)).toMatchObject({
      type: "error",
      error: { message: "user message persistence failed" },
    });
    expect((await reloadSession(rootDir, "user-failure")).session
      .getMessages()).toEqual([]);
  });

  test("does not emit done when the final assistant checkpoint append fails", async () => {
    const { rootDir, store } = await createStore("final-checkpoint-failure");
    const runner: ModelStreamRunner = {
      async *stream(): AsyncIterable<StreamEvent> {
        yield { type: "start" };
        yield { type: "text-delta", delta: "not durable" };
        yield { type: "done", reason: "stop" };
      },
    };
    const chat = new ChatSession(
      new AgentLoop(runner, new ToolRegistry()),
      model,
      { session: new Session(store) },
    );
    store.failMessageAppend("assistant", 1);

    const events = await collect(chat.streamTurn("answer me"));

    expect(events.some((event) => event.type === "done")).toBe(false);
    expect(events.at(-1)).toMatchObject({
      type: "error",
      error: { message: "assistant checkpoint persistence failed" },
    });
    expect((await reloadSession(rootDir, "final-checkpoint-failure"))
      .session.getMessages()).toEqual([
      { role: "user", content: "answer me" },
    ]);
  });

  test("journals a successful tool turn exactly once in execution order", async () => {
    const { rootDir, store } = await createStore("successful-tool-turn");
    const { registry } = createMutatingTool(() => undefined);
    const { runner } = createToolThenRunner("stop");
    const chat = new ChatSession(
      new AgentLoop(runner, registry),
      model,
      { session: new Session(store) },
    );

    const events = await collect(chat.streamTurn("write the file"));

    expect(events.at(-1)).toMatchObject({ type: "done", reason: "stop" });
    expect((await reloadSession(rootDir, "successful-tool-turn")).session
      .getMessages()).toEqual([
      { role: "user", content: "write the file" },
      {
        role: "assistant",
        content: "",
        toolCalls: [
          {
            id: "call-1",
            name: "write-test",
            arguments: {},
          },
        ],
      },
      {
        role: "tool",
        toolCallId: "call-1",
        content: "written",
        isError: false,
      },
      {
        role: "assistant",
        content: "finished",
        toolCalls: [],
      },
    ]);
  });

  test("persists provider state from the final assistant checkpoint", async () => {
    const { rootDir, store } = await createStore("provider-state-checkpoint");
    const providerState = {
      provider: "openai-codex" as const,
      value: {
        reasoningItems: [{ type: "reasoning", id: "rs_1" }],
        functionItemIds: {},
      },
    };
    const runner: ModelStreamRunner = {
      async *stream(): AsyncIterable<StreamEvent> {
        yield { type: "start" };
        yield { type: "done", reason: "stop", providerState };
      },
    };
    const chat = new ChatSession(
      new AgentLoop(runner, new ToolRegistry()),
      model,
      { session: new Session(store) },
    );

    await collect(chat.streamTurn("remember provider state"));

    expect((await reloadSession(rootDir, "provider-state-checkpoint"))
      .session.getMessages()).toEqual([
      { role: "user", content: "remember provider state" },
      {
        role: "assistant",
        content: "",
        toolCalls: [],
        providerState,
      },
    ]);
  });

  test("stops before a new user or provider call when recovery persistence fails", async () => {
    const { rootDir, store } = await createStore("recovery-failure");
    const session = new Session(store);
    await session.appendMessage({ role: "user", content: "write it" });
    await session.appendMessage({
      role: "assistant",
      content: "",
      toolCalls: [
        { id: "call-1", name: "write-test", arguments: {} },
      ],
    });
    let providerCalls = 0;
    const runner: ModelStreamRunner = {
      async *stream(): AsyncIterable<StreamEvent> {
        providerCalls += 1;
        yield { type: "start" };
        yield { type: "done", reason: "stop" };
      },
    };
    const chat = new ChatSession(
      new AgentLoop(runner, new ToolRegistry()),
      model,
      { session },
    );
    store.failMessageAppend("tool", 1);

    const events = await collect(chat.streamTurn("continue safely"));

    expect(events.at(-1)).toMatchObject({
      type: "error",
      error: { message: "tool result persistence failed" },
    });
    expect(providerCalls).toBe(0);
    expect((await reloadSession(rootDir, "recovery-failure")).session
      .getMessages()).toEqual([
      { role: "user", content: "write it" },
      {
        role: "assistant",
        content: "",
        toolCalls: [
          { id: "call-1", name: "write-test", arguments: {} },
        ],
      },
    ]);
  });

  test("reports each partial recovery exactly once across an append failure", async () => {
    const { store } = await createStore("partial-recovery-reporting");
    const session = new Session(store);
    await session.appendMessage({ role: "user", content: "run both" });
    await session.appendMessage({
      role: "assistant",
      content: "",
      toolCalls: [
        { id: "call-1", name: "write-test", arguments: {} },
        { id: "call-2", name: "write-test", arguments: {} },
      ],
    });
    let providerCalls = 0;
    const runner: ModelStreamRunner = {
      async *stream(): AsyncIterable<StreamEvent> {
        providerCalls += 1;
        yield { type: "start" };
        yield { type: "done", reason: "stop" };
      },
    };
    const chat = new ChatSession(
      new AgentLoop(runner, new ToolRegistry()),
      model,
      { session },
    );
    store.failMessageAppend("tool", 2);

    const firstAttempt = await collect(chat.streamTurn("blocked turn"));

    expect(firstAttempt).toEqual([
      {
        type: "session-recovery",
        recoveredToolCallIds: ["call-1"],
      },
      {
        type: "error",
        reason: "error",
        error: new Error("tool result persistence failed"),
      },
    ]);
    expect(providerCalls).toBe(0);

    const secondAttempt = await collect(chat.streamTurn("resume safely"));
    const thirdAttempt = await collect(chat.streamTurn("no duplicates"));
    const recoveryIds = [
      ...firstAttempt,
      ...secondAttempt,
      ...thirdAttempt,
    ].flatMap((event) =>
      event.type === "session-recovery"
        ? [...event.recoveredToolCallIds]
        : [],
    );

    expect(recoveryIds).toEqual(["call-1", "call-2"]);
    expect(providerCalls).toBe(2);
  });

  test("reports recovered call IDs before starting the next provider call", async () => {
    const { store } = await createStore("recovery-event");
    const session = new Session(store);
    await session.appendMessage({ role: "user", content: "write it" });
    await session.appendMessage({
      role: "assistant",
      content: "",
      toolCalls: [
        { id: "call-1", name: "write-test", arguments: {} },
      ],
    });
    let providerCalls = 0;
    const runner: ModelStreamRunner = {
      async *stream(): AsyncIterable<StreamEvent> {
        providerCalls += 1;
        yield { type: "start" };
        yield { type: "done", reason: "stop" };
      },
    };
    const chat = new ChatSession(
      new AgentLoop(runner, new ToolRegistry()),
      model,
      { session },
    );

    const iterator = chat.streamTurn("continue safely")[Symbol.asyncIterator]();

    await expect(iterator.next()).resolves.toEqual({
      done: false,
      value: {
        type: "session-recovery",
        recoveredToolCallIds: ["call-1"],
      },
    });
    expect(providerCalls).toBe(0);
    await collect({
      [Symbol.asyncIterator]() {
        return iterator;
      },
    });
    expect(providerCalls).toBe(1);
  });
});

class FailingJsonlSessionStore extends JsonlSessionStore {
  private failure:
    | {
        role: Message["role"];
        occurrence: number;
        seen: number;
      }
    | undefined;

  failMessageAppend(
    role: Message["role"],
    occurrence: number,
  ): void {
    this.failure = { role, occurrence, seen: 0 };
  }

  override async appendEntry(entry: SessionEntry): Promise<void> {
    if (
      this.failure &&
      entry.type === "message" &&
      entry.message.role === this.failure.role
    ) {
      this.failure.seen += 1;

      if (this.failure.seen === this.failure.occurrence) {
        const role = this.failure.role;
        this.failure = undefined;
        const label =
          role === "assistant"
            ? "assistant checkpoint"
            : role === "tool"
              ? "tool result"
              : "user message";
        throw new Error(`${label} persistence failed`);
      }
    }

    await super.appendEntry(entry);
  }
}
