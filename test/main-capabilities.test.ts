import { Type } from "typebox";
import { describe, expect, test } from "vitest";

import { AgentLoop } from "../src/agent/loop.js";
import { ModelRuntime, type ModelStreamRunner } from "../src/model/runtime.js";
import type { ModelRequest, StreamEvent } from "../src/model/types.js";
import { ProviderRegistry } from "../src/model/registry.js";
import { ToolRegistry } from "../src/tools/registry.js";
import type { Tool } from "../src/tools/types.js";

async function collect<T>(events: AsyncIterable<T>): Promise<T[]> {
  const collected: T[] = [];

  for await (const event of events) {
    collected.push(event);
  }

  return collected;
}

const model = {
  id: "missing-model",
  name: "Missing Model",
  provider: "fake" as const,
  contextWindow: 4096,
  maxOutputTokens: 512,
};

describe("main capability baseline", () => {
  test("an unknown provider produces one terminal error event", async () => {
    const runtime = new ModelRuntime(new ProviderRegistry());

    const events = await collect(
      runtime.stream({
        model,
        messages: [],
        tools: [],
      }),
    );

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "error",
      reason: "error",
    });
  });

  test("an approval-required tool is denied before execution", async () => {
    let providerCall = 0;
    let executed = false;

    const runner: ModelStreamRunner = {
      async *stream(_request: ModelRequest): AsyncIterable<StreamEvent> {
        providerCall += 1;
        yield { type: "start" };

        if (providerCall === 1) {
          yield {
            type: "tool-call",
            toolCall: {
              id: "write-1",
              name: "write-test",
              arguments: {},
            },
          };
          yield { type: "done", reason: "tool-call" };
          return;
        }

        yield { type: "text-delta", delta: "finished" };
        yield { type: "done", reason: "stop" };
      },
    };

    const tool: Tool = {
      approval: "always",
      definition: {
        name: "write-test",
        description: "Records whether an approved mutation ran.",
        inputSchema: Type.Object({}, { additionalProperties: false }),
      },
      async execute() {
        executed = true;
        return { content: "executed", isError: false };
      },
    };
    const tools = new ToolRegistry();
    tools.register(tool);

    const events = await collect(
      new AgentLoop(runner, tools).stream({ model, messages: [] }),
    );

    expect(executed).toBe(false);
    expect(events).toContainEqual({
      type: "tool-result",
      result: {
        toolCallId: "write-1",
        content: 'Tool "write-test" was denied by the user.',
        isError: true,
      },
      message: {
        role: "tool",
        toolCallId: "write-1",
        content: 'Tool "write-test" was denied by the user.',
        isError: true,
      },
    });
    expect(events.at(-1)).toMatchObject({
      type: "done",
      reason: "stop",
    });
  });
});
