import { Type } from "typebox";
import { describe, expect, test } from "vitest";

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
});
