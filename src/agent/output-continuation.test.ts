import { describe, expect, test } from "vitest";
import { Type } from "typebox";

import type { ModelStreamRunner } from "../model/runtime.js";
import type { ModelRequest, StreamEvent } from "../model/types.js";
import { ToolRegistry } from "../tools/registry.js";
import { AgentLoop } from "./loop.js";
import {
  ContinuationOverlapGuard,
  continuationTailHash,
  createOutputContinuationPolicy,
} from "./output-continuation.js";

const model = {
  id: "fake-model",
  name: "Fake",
  provider: "fake" as const,
  contextWindow: 16_384,
  maxOutputTokens: 16,
};

describe("output continuation", () => {
  test("continues two length terminals, removes overlap, and checkpoints segments", async () => {
    const requests: ModelRequest[] = [];
    const streams: StreamEvent[][] = [
      [
        { type: "text-delta", delta: "alpha beta " },
        { type: "done", reason: "length" },
      ],
      [
        { type: "text-delta", delta: "beta gamma " },
        { type: "done", reason: "length" },
      ],
      [
        { type: "text-delta", delta: "gamma delta" },
        { type: "done", reason: "stop" },
      ],
    ];
    const runner: ModelStreamRunner = {
      async *stream(request): AsyncIterable<StreamEvent> {
        requests.push(structuredClone(request));
        for (const event of streams[requests.length - 1] ?? []) yield event;
      },
    };

    const events = await collect(new AgentLoop(
      runner,
      new ToolRegistry(),
      undefined,
      undefined,
      createOutputContinuationPolicy(model),
    ).stream({
      model,
      messages: [{ role: "user", content: "write" }],
    }));

    expect(requests).toHaveLength(3);
    expect(requests.map((request) => request.continuation?.segmentIndex))
      .toEqual([undefined, 1, 2]);
    expect(events.filter((event) => event.type === "text-delta")
      .map((event) => event.delta).join(""))
      .toBe("alpha beta gamma delta");
    const checkpoints = events
      .filter((event) => event.type === "message-checkpoint")
      .map((event) => event.message);
    expect(checkpoints.map((message) => message.content))
      .toEqual(["alpha beta ", "gamma ", "delta"]);
    expect(checkpoints.map((message) => message.continuation?.status))
      .toEqual(["partial", "partial", "complete"]);
    expect(events.at(-1)).toMatchObject({ type: "done", reason: "stop" });
  });

  test("checkpoints the last partial before the continuation cap error", async () => {
    let calls = 0;
    const runner: ModelStreamRunner = {
      async *stream(): AsyncIterable<StreamEvent> {
        calls += 1;
        yield { type: "text-delta", delta: calls === 1 ? "first" : "second" };
        yield { type: "done", reason: "length" };
      },
    };
    const events = await collect(new AgentLoop(
      runner,
      new ToolRegistry(),
      undefined,
      undefined,
      createOutputContinuationPolicy(model, { maxContinuations: 1 }),
    ).stream({ model, messages: [] }));

    expect(calls).toBe(2);
    const checkpoints = events.filter(
      (event) => event.type === "message-checkpoint",
    );
    expect(checkpoints).toHaveLength(2);
    expect(checkpoints.at(-1)).toMatchObject({
      message: {
        continuation: { status: "partial", resumeAllowed: false },
      },
    });
    expect(events.at(-1)).toMatchObject({
      type: "error",
      error: { message: expect.stringMatching(/maximum continuation count/i) },
    });
  });

  test("rejects a restored continuation cap before another Provider call", async () => {
    let calls = 0;
    const logicalMessageId = "logical-cap";
    const firstTail = "first";
    const secondTail = "firstsecond";
    const runner: ModelStreamRunner = {
      async *stream(): AsyncIterable<StreamEvent> {
        calls += 1;
        yield { type: "text-delta", delta: "must not run" };
        yield { type: "done", reason: "stop" };
      },
    };
    const messages = [
      {
        role: "assistant" as const,
        content: "first",
        toolCalls: [],
        continuation: {
          logicalMessageId,
          segmentIndex: 0,
          status: "partial" as const,
          resumeAllowed: true,
          tailHash: continuationTailHash(firstTail),
          estimatedTotalOutputTokens: 2,
        },
      },
      {
        role: "assistant" as const,
        content: "second",
        toolCalls: [],
        continuation: {
          logicalMessageId,
          segmentIndex: 1,
          status: "partial" as const,
          resumeAllowed: true,
          tailHash: continuationTailHash(secondTail),
          estimatedTotalOutputTokens: 3,
        },
      },
    ];
    const events = await collect(new AgentLoop(
      runner,
      new ToolRegistry(),
      undefined,
      undefined,
      createOutputContinuationPolicy(model, { maxContinuations: 1 }),
    ).stream({
      model,
      messages,
      continuation: {
        kind: "assistant-output",
        logicalMessageId,
        segmentIndex: 2,
        previousTail: secondTail,
        previousTailHash: continuationTailHash(secondTail),
      },
    }));

    expect(calls).toBe(0);
    expect(events.at(-1)).toMatchObject({
      type: "error",
      error: { message: expect.stringMatching(/maximum continuation count/i) },
    });
  });

  test("rejects an empty novel continuation after removing repeated output", async () => {
    let calls = 0;
    const runner: ModelStreamRunner = {
      async *stream(): AsyncIterable<StreamEvent> {
        calls += 1;
        yield { type: "text-delta", delta: "repeat me" };
        yield { type: "done", reason: "length" };
      },
    };
    const events = await collect(new AgentLoop(
      runner,
      new ToolRegistry(),
    ).stream({ model, messages: [] }));

    expect(calls).toBe(2);
    expect(events.filter((event) => event.type === "message-checkpoint"))
      .toHaveLength(1);
    expect(events.at(-1)).toMatchObject({
      type: "error",
      error: { message: expect.stringMatching(/no novel output|no progress/i) },
    });
  });

  test("fails closed on length with an incomplete tool call", async () => {
    let calls = 0;
    const runner: ModelStreamRunner = {
      async *stream(): AsyncIterable<StreamEvent> {
        calls += 1;
        yield { type: "text-delta", delta: "visible partial" };
        yield {
          type: "done",
          reason: "length",
          incompleteToolCall: true,
          providerState: { provider: "fake", value: { opaque: "state" } },
        };
      },
    };
    const events = await collect(new AgentLoop(
      runner,
      new ToolRegistry(),
    ).stream({ model, messages: [] }));

    expect(calls).toBe(1);
    expect(events).toContainEqual(expect.objectContaining({
      type: "message-checkpoint",
      message: expect.objectContaining({
        content: "visible partial",
        continuation: expect.objectContaining({
          status: "partial",
          resumeAllowed: false,
        }),
      }),
    }));
    expect(events.at(-1)).toMatchObject({
      type: "error",
      error: { message: expect.stringMatching(/incomplete tool call/i) },
    });
  });

  test("checkpoints opaque Provider state when length has no visible text", async () => {
    const providerState = {
      provider: "openai-codex" as const,
      value: {
        reasoningItems: [{
          type: "reasoning",
          id: "rs_opaque",
          summary: [],
          encrypted_content: "encrypted",
        }],
        functionItemIds: {},
      },
    };
    const runner: ModelStreamRunner = {
      async *stream(): AsyncIterable<StreamEvent> {
        yield { type: "done", reason: "length", providerState };
      },
    };

    const events = await collect(new AgentLoop(
      runner,
      new ToolRegistry(),
    ).stream({ model, messages: [] }));

    expect(events).toContainEqual(expect.objectContaining({
      type: "message-checkpoint",
      message: expect.objectContaining({
        content: "",
        providerState,
        continuation: expect.objectContaining({
          status: "partial",
          resumeAllowed: false,
        }),
      }),
    }));
    expect(events.at(-1)).toMatchObject({
      type: "error",
      error: { message: expect.stringMatching(/no.*progress/i) },
    });
  });

  test("checkpoints zero-text incomplete tool Provider state", async () => {
    const providerState = {
      provider: "openai-codex" as const,
      value: { reasoningItems: [], functionItemIds: {} },
    };
    const runner: ModelStreamRunner = {
      async *stream(): AsyncIterable<StreamEvent> {
        yield {
          type: "done",
          reason: "length",
          incompleteToolCall: true,
          providerState,
        };
      },
    };

    const events = await collect(
      new AgentLoop(runner, new ToolRegistry()).stream({ model, messages: [] }),
    );

    expect(events).toContainEqual(expect.objectContaining({
      type: "message-checkpoint",
      message: expect.objectContaining({
        content: "",
        providerState,
        continuation: expect.objectContaining({ resumeAllowed: false }),
      }),
    }));
    expect(events.at(-1)).toMatchObject({
      type: "error",
      error: { message: expect.stringMatching(/incomplete tool call/i) },
    });
  });

  test("checkpoints visible text as non-resumable before a provider error", async () => {
    const runner: ModelStreamRunner = {
      async *stream(): AsyncIterable<StreamEvent> {
        yield { type: "text-delta", delta: "durable partial" };
        yield { type: "error", reason: "error", error: new Error("network lost") };
      },
    };
    const events = await collect(new AgentLoop(
      runner,
      new ToolRegistry(),
    ).stream({ model, messages: [] }));
    const checkpointIndex = events.findIndex(
      (event) => event.type === "message-checkpoint",
    );
    const errorIndex = events.findIndex((event) => event.type === "error");

    expect(checkpointIndex).toBeGreaterThan(-1);
    expect(checkpointIndex).toBeLessThan(errorIndex);
    expect(events[checkpointIndex]).toMatchObject({
      message: {
        content: "durable partial",
        continuation: { status: "partial", resumeAllowed: false },
      },
    });
  });

  test("checkpoints then stops before exceeding the total output allowance", async () => {
    let calls = 0;
    const runner: ModelStreamRunner = {
      async *stream(): AsyncIterable<StreamEvent> {
        calls += 1;
        yield { type: "text-delta", delta: "12345678" };
        yield { type: "done", reason: "length" };
      },
    };
    const events = await collect(new AgentLoop(
      runner,
      new ToolRegistry(),
      undefined,
      undefined,
      createOutputContinuationPolicy(model, { maxTotalOutputTokens: 3 }),
    ).stream({ model, messages: [] }));

    expect(calls).toBe(1);
    expect(events).toContainEqual(expect.objectContaining({
      type: "message-checkpoint",
      message: expect.objectContaining({ content: "12345678" }),
    }));
    expect(events.at(-1)).toMatchObject({
      type: "error",
      error: { message: expect.stringMatching(/total output token limit/i) },
    });
  });

  test("allows a tool call to complete a continuation without extra text", async () => {
    let providerCalls = 0;
    let toolExecutions = 0;
    const runner: ModelStreamRunner = {
      async *stream(): AsyncIterable<StreamEvent> {
        providerCalls += 1;
        if (providerCalls === 1) {
          yield { type: "text-delta", delta: "I will inspect." };
          yield { type: "done", reason: "length" };
          return;
        }
        if (providerCalls === 2) {
          yield {
            type: "tool-call",
            toolCall: { id: "call-1", name: "inspect", arguments: {} },
          };
          yield { type: "done", reason: "tool-call" };
          return;
        }
        yield { type: "text-delta", delta: "done" };
        yield { type: "done", reason: "stop" };
      },
    };
    const tools = new ToolRegistry();
    tools.register({
      approval: "never",
      definition: {
        name: "inspect",
        description: "Inspect.",
        inputSchema: Type.Object({}, { additionalProperties: false }),
      },
      async execute() {
        toolExecutions += 1;
        return { content: "ok", isError: false };
      },
    });
    const events = await collect(new AgentLoop(runner, tools).stream({
      model,
      messages: [],
    }));

    expect(providerCalls).toBe(3);
    expect(toolExecutions).toBe(1);
    expect(events.filter((event) => event.type === "message-checkpoint")
      .map((event) => event.message.continuation?.status))
      .toEqual(["partial", "complete", undefined]);
    expect(events.at(-1)).toMatchObject({ type: "done", reason: "stop" });
  });
});

describe("ContinuationOverlapGuard", () => {
  test("uses Unicode code points and never splits an emoji surrogate pair", () => {
    const guard = new ContinuationOverlapGuard("끝🙂", 1024);
    expect(guard.push("🙂새")).toBe("새");
    expect(guard.finish()).toBe("");
  });
});

async function collect<T>(stream: AsyncIterable<T>): Promise<T[]> {
  const events: T[] = [];
  for await (const event of stream) events.push(event);
  return events;
}
