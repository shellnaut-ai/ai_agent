import { Type } from "typebox";
import { describe, expect, test } from "vitest";

import type { ToolApprovalHandler } from "../approval/types.js";
import type { ModelStreamRunner } from "../model/runtime.js";
import type {
  ModelRequest,
  ProviderMessageState,
  StreamEvent,
} from "../model/types.js";
import { ToolRegistry } from "../tools/registry.js";
import type { Tool } from "../tools/types.js";
import { AgentLoop } from "./loop.js";

async function collect<T>(stream: AsyncIterable<T>): Promise<T[]> {
  const events: T[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

const model = {
  id: "fake-model",
  name: "Fake",
  provider: "fake" as const,
  contextWindow: 4096,
  maxOutputTokens: 1024,
};

describe("AgentLoop integration policies", () => {
  test("isolates internal working messages from Provider request mutation", async () => {
    let providerCalls = 0;
    let followUpRequest: ModelRequest | undefined;
    const runner: ModelStreamRunner = {
      async *stream(request: ModelRequest): AsyncIterable<StreamEvent> {
        providerCalls += 1;
        yield { type: "start" };

        if (providerCalls === 1) {
          const firstMessage = request.messages[0];

          if (firstMessage?.role === "user") {
            (firstMessage as { content: string }).content = "mutated";
          }

          request.messages.push({ role: "user", content: "injected" });
          yield {
            type: "tool-call",
            toolCall: {
              id: "call-1",
              name: "missing-tool",
              arguments: {},
            },
          };
          yield { type: "done", reason: "tool-call" };
          return;
        }

        followUpRequest = structuredClone(request);
        yield { type: "done", reason: "stop" };
      },
    };

    await collect(
      new AgentLoop(runner, new ToolRegistry()).stream({
        model,
        messages: [{ role: "user", content: "original" }],
      }),
    );

    expect(followUpRequest?.messages).toEqual([
      { role: "user", content: "original" },
      {
        role: "assistant",
        content: "",
        toolCalls: [
          {
            id: "call-1",
            name: "missing-tool",
            arguments: {},
          },
        ],
      },
      {
        role: "tool",
        toolCallId: "call-1",
        content: 'Tool "missing-tool" is not registered.',
        isError: true,
      },
    ]);
  });

  test("isolates executable tool arguments from approval callback mutation", async () => {
    let providerCalls = 0;
    let executedPath: string | undefined;
    const runner: ModelStreamRunner = {
      async *stream(): AsyncIterable<StreamEvent> {
        providerCalls += 1;
        yield { type: "start" };

        if (providerCalls === 1) {
          yield {
            type: "tool-call",
            toolCall: {
              id: "call-1",
              name: "write-test",
              arguments: { path: "original.txt" },
            },
          };
          yield { type: "done", reason: "tool-call" };
          return;
        }

        yield { type: "done", reason: "stop" };
      },
    };
    const tool: Tool = {
      approval: "always",
      definition: {
        name: "write-test",
        description: "Records approved arguments.",
        inputSchema: Type.Object(
          { path: Type.String() },
          { additionalProperties: false },
        ),
      },
      async execute(input) {
        executedPath = (input as { path: string }).path;
        return { content: "written", isError: false };
      },
    };
    const approvalHandler: ToolApprovalHandler = {
      async requestApproval(request) {
        (request.toolCall.arguments as { path: string }).path =
          "approval-mutation.txt";
        return "allow-once";
      },
    };
    const registry = new ToolRegistry();
    registry.register(tool);

    await collect(
      new AgentLoop(runner, registry, approvalHandler).stream({
        model,
        messages: [],
      }),
    );

    expect(executedPath).toBe("original.txt");
  });

  test("isolates durable tool intent and results from outward event mutation", async () => {
    let providerCalls = 0;
    let executedPath: string | undefined;
    let followUpRequest: ModelRequest | undefined;
    const runner: ModelStreamRunner = {
      async *stream(request: ModelRequest): AsyncIterable<StreamEvent> {
        providerCalls += 1;
        yield { type: "start" };

        if (providerCalls === 1) {
          yield {
            type: "tool-call",
            toolCall: {
              id: "call-1",
              name: "write-test",
              arguments: { path: "original.txt" },
            },
          };
          yield { type: "done", reason: "tool-call" };
          return;
        }

        followUpRequest = structuredClone(request);
        yield { type: "done", reason: "stop" };
      },
    };
    const tool: Tool = {
      approval: "never",
      definition: {
        name: "write-test",
        description: "Records the path that would be mutated.",
        inputSchema: Type.Object(
          { path: Type.String() },
          { additionalProperties: false },
        ),
      },
      async execute(input) {
        executedPath = (input as { path: string }).path;
        return { content: "written", isError: false };
      },
    };
    const registry = new ToolRegistry();
    registry.register(tool);
    const iterator = new AgentLoop(runner, registry)
      .stream({ model, messages: [] })[Symbol.asyncIterator]();

    await iterator.next();
    const toolCallEvent = await iterator.next();

    if (toolCallEvent.done || toolCallEvent.value.type !== "tool-call") {
      throw new Error("Expected an outward tool-call event.");
    }

    (toolCallEvent.value.toolCall.arguments as { path: string }).path =
      "tool-event-mutation.txt";

    const checkpointEvent = await iterator.next();

    if (
      checkpointEvent.done ||
      checkpointEvent.value.type !== "message-checkpoint"
    ) {
      throw new Error("Expected an assistant checkpoint event.");
    }

    expect(checkpointEvent.value.message.toolCalls[0]?.arguments).toEqual({
      path: "original.txt",
    });
    (
      checkpointEvent.value.message.toolCalls[0]?.arguments as {
        path: string;
      }
    ).path = "checkpoint-mutation.txt";

    const resultEvent = await iterator.next();

    if (resultEvent.done || resultEvent.value.type !== "tool-result") {
      throw new Error("Expected a tool-result event.");
    }

    expect(executedPath).toBe("original.txt");
    (resultEvent.value.message as { content: string }).content =
      "result-event mutation";

    await iterator.next();

    expect(followUpRequest?.messages).toEqual([
      {
        role: "assistant",
        content: "",
        toolCalls: [
          {
            id: "call-1",
            name: "write-test",
            arguments: { path: "original.txt" },
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
    await iterator.return?.();
  });

  test("pauses at an assistant checkpoint before executing a requested tool", async () => {
    let providerCalls = 0;
    let toolExecutions = 0;
    const runner: ModelStreamRunner = {
      async *stream(): AsyncIterable<StreamEvent> {
        providerCalls += 1;
        yield { type: "start" };

        if (providerCalls === 1) {
          yield {
            type: "tool-call",
            toolCall: {
              id: "call-1",
              name: "write-test",
              arguments: {},
            },
          };
          yield { type: "done", reason: "tool-call" };
          return;
        }

        yield { type: "done", reason: "stop" };
      },
    };
    const tool: Tool = {
      approval: "never",
      definition: {
        name: "write-test",
        description: "Mutates test state.",
        inputSchema: Type.Object({}, { additionalProperties: false }),
      },
      async execute() {
        toolExecutions += 1;
        return { content: "written", isError: false };
      },
    };
    const registry = new ToolRegistry();
    registry.register(tool);
    const iterator = new AgentLoop(runner, registry)
      .stream({ model, messages: [] })[Symbol.asyncIterator]();

    await expect(iterator.next()).resolves.toEqual({
      done: false,
      value: { type: "start" },
    });
    await expect(iterator.next()).resolves.toMatchObject({
      done: false,
      value: { type: "tool-call", toolCall: { id: "call-1" } },
    });
    await expect(iterator.next()).resolves.toEqual({
      done: false,
      value: {
        type: "message-checkpoint",
        message: {
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
      },
    });
    expect(toolExecutions).toBe(0);

    await expect(iterator.next()).resolves.toEqual({
      done: false,
      value: {
        type: "tool-result",
        result: {
          toolCallId: "call-1",
          content: "written",
          isError: false,
        },
        message: {
          role: "tool",
          toolCallId: "call-1",
          content: "written",
          isError: false,
        },
      },
    });
    expect(toolExecutions).toBe(1);
    await iterator.return?.();
  });

  test("emits a final assistant checkpoint before done", async () => {
    const runner: ModelStreamRunner = {
      async *stream(): AsyncIterable<StreamEvent> {
        yield { type: "start" };
        yield { type: "text-delta", delta: "answer" };
        yield { type: "done", reason: "stop" };
      },
    };

    const events = await collect(
      new AgentLoop(runner, new ToolRegistry()).stream({
        model,
        messages: [{ role: "user", content: "question" }],
      }),
    );

    expect(events.slice(-2)).toEqual([
      {
        type: "message-checkpoint",
        message: {
          role: "assistant",
          content: "answer",
          toolCalls: [],
        },
      },
      {
        type: "done",
        reason: "stop",
        newMessages: [
          {
            role: "assistant",
            content: "answer",
            toolCalls: [],
          },
        ],
      },
    ]);
  });

  test("snapshots terminal provider state before provider cleanup mutation", async () => {
    const providerState: ProviderMessageState = {
      provider: "openai-codex",
      value: { replayId: "original" },
    };
    const runner: ModelStreamRunner = {
      async *stream(): AsyncIterable<StreamEvent> {
        try {
          yield { type: "start" };
          yield { type: "done", reason: "stop", providerState };
        } finally {
          (providerState.value as { replayId: string }).replayId = "mutated";
        }
      },
    };

    const events = await collect(
      new AgentLoop(runner, new ToolRegistry()).stream({
        model,
        messages: [],
      }),
    );

    expect(events.slice(-2)).toEqual([
      {
        type: "message-checkpoint",
        message: {
          role: "assistant",
          content: "",
          toolCalls: [],
          providerState: {
            provider: "openai-codex",
            value: { replayId: "original" },
          },
        },
      },
      {
        type: "done",
        reason: "stop",
        newMessages: [
          {
            role: "assistant",
            content: "",
            toolCalls: [],
            providerState: {
              provider: "openai-codex",
              value: { replayId: "original" },
            },
          },
        ],
      },
    ]);
  });

  test("copies terminal provider state onto the completed assistant message", async () => {
    const providerState: ProviderMessageState = {
      provider: "openai-codex",
      value: {
        reasoningItems: [{
          type: "reasoning",
          id: "rs_1",
          summary: [],
          encrypted_content: "encrypted",
        }],
        functionItemIds: {},
      },
    };
    const runner: ModelStreamRunner = {
      async *stream(): AsyncIterable<StreamEvent> {
        yield { type: "start" };
        yield { type: "text-delta", delta: "answer" };
        yield { type: "done", reason: "stop", providerState };
      },
    };

    const events = await collect(
      new AgentLoop(runner, new ToolRegistry()).stream({
        model,
        messages: [{ role: "user", content: "question" }],
      }),
    );

    expect(events).toContainEqual({
      type: "message-checkpoint",
      message: {
        role: "assistant",
        content: "answer",
        toolCalls: [],
        providerState,
      },
    });
    expect(events.at(-1)).toEqual({
      type: "done",
      reason: "stop",
      newMessages: [{
        role: "assistant",
        content: "answer",
        toolCalls: [],
        providerState,
      }],
    });
  });

  test("maxToolBatches rejects a second model-requested batch", async () => {
    let providerCalls = 0;
    let toolExecutions = 0;

    const runner: ModelStreamRunner = {
      async *stream(_request: ModelRequest): AsyncIterable<StreamEvent> {
        providerCalls += 1;
        yield { type: "start" };
        yield {
          type: "tool-call",
          toolCall: {
            id: `call-${providerCalls}`,
            name: "read-test",
            arguments: {},
          },
        };
        yield { type: "done", reason: "tool-call" };
      },
    };
    const tool: Tool = {
      approval: "never",
      definition: {
        name: "read-test",
        description: "Counts executions.",
        inputSchema: Type.Object({}, { additionalProperties: false }),
      },
      async execute() {
        toolExecutions += 1;
        return { content: "ok", isError: false };
      },
    };
    const registry = new ToolRegistry();
    registry.register(tool);

    const events = await collect(
      new AgentLoop(runner, registry).stream(
        { model, messages: [] },
        { maxSteps: 8, maxToolBatches: 1 },
      ),
    );

    expect(providerCalls).toBe(2);
    expect(toolExecutions).toBe(1);
    expect(events.at(-1)).toMatchObject({ type: "error", reason: "error" });
  });

  test("isolates later provider requests from definition mutation", async () => {
    let providerCalls = 0;
    let followUpTools: ModelRequest["tools"] | undefined;
    const runner: ModelStreamRunner = {
      async *stream(request): AsyncIterable<StreamEvent> {
        providerCalls += 1;
        yield { type: "start" };

        if (providerCalls === 1) {
          const definition = request.tools[0];

          if (definition !== undefined) {
            (definition as { description: string }).description = "mutated";
            const properties = (definition.inputSchema as {
              properties: Record<string, unknown>;
            }).properties;
            properties.path = Type.Number();
          }

          yield {
            type: "tool-call",
            toolCall: {
              id: "call-1",
              name: "read-test",
              arguments: { path: "a.txt" },
            },
          };
          yield { type: "done", reason: "tool-call" };
          return;
        }

        followUpTools = request.tools;
        yield { type: "done", reason: "stop" };
      },
    };
    const registry = new ToolRegistry();
    registry.register({
      approval: "never",
      definition: {
        name: "read-test",
        description: "Read a path.",
        inputSchema: Type.Object({ path: Type.String() }),
      },
      async execute() {
        return { content: "ok", isError: false };
      },
    });

    await collect(new AgentLoop(runner, registry).stream({ model, messages: [] }));

    expect(followUpTools?.[0]?.description).toBe("Read a path.");
    expect(
      (followUpTools?.[0]?.inputSchema as {
        properties: { path: { type: string } };
      }).properties.path.type,
    ).toBe("string");
    expect(registry.listDefinitions()[0]?.description).toBe("Read a path.");
  });

  test("isolates the registry and later requests from approval definition mutation", async () => {
    let providerCalls = 0;
    let toolExecutions = 0;
    let followUpDescription: string | undefined;
    const runner: ModelStreamRunner = {
      async *stream(request): AsyncIterable<StreamEvent> {
        providerCalls += 1;
        yield { type: "start" };

        if (providerCalls === 1) {
          yield {
            type: "tool-call",
            toolCall: {
              id: "call-1",
              name: "write-test",
              arguments: { path: "a.txt" },
            },
          };
          yield { type: "done", reason: "tool-call" };
          return;
        }

        followUpDescription = request.tools[0]?.description;
        yield { type: "done", reason: "stop" };
      },
    };
    const approvalHandler: ToolApprovalHandler = {
      async requestApproval(request) {
        (request.definition as { description: string }).description =
          "approval mutation";
        const properties = (request.definition.inputSchema as {
          properties: Record<string, unknown>;
        }).properties;
        properties.path = Type.Number();
        return "allow-once";
      },
    };
    const registry = new ToolRegistry();
    registry.register({
      approval: "always",
      definition: {
        name: "write-test",
        description: "Write a path.",
        inputSchema: Type.Object({ path: Type.String() }),
      },
      async execute() {
        toolExecutions += 1;
        return { content: "ok", isError: false };
      },
    });

    await collect(
      new AgentLoop(runner, registry, approvalHandler).stream({
        model,
        messages: [],
      }),
    );

    expect(toolExecutions).toBe(1);
    expect(followUpDescription).toBe("Write a path.");
    expect(registry.listDefinitions()[0]?.description).toBe("Write a path.");
  });

  test("rejects duplicate tool call IDs before checkpoint or execution", async () => {
    let toolExecutions = 0;
    const runner: ModelStreamRunner = {
      async *stream(): AsyncIterable<StreamEvent> {
        yield { type: "start" };
        yield {
          type: "tool-call",
          toolCall: { id: "duplicate", name: "read-test", arguments: {} },
        };
        yield {
          type: "tool-call",
          toolCall: { id: "duplicate", name: "read-test", arguments: {} },
        };
        yield { type: "done", reason: "tool-call" };
      },
    };
    const registry = new ToolRegistry();
    registry.register({
      approval: "never",
      definition: {
        name: "read-test",
        description: "Counts executions.",
        inputSchema: Type.Object({}, { additionalProperties: false }),
      },
      async execute() {
        toolExecutions += 1;
        return { content: "ok", isError: false };
      },
    });

    const events = await collect(
      new AgentLoop(runner, registry).stream({ model, messages: [] }),
    );

    expect(toolExecutions).toBe(0);
    expect(events.some((event) => event.type === "message-checkpoint")).toBe(false);
    expect(events.at(-1)).toMatchObject({
      type: "error",
      error: { message: expect.stringMatching(/duplicate.*tool call/i) },
    });
  });
});
