import { describe, expect, test } from "vitest";

import { AgentLoop } from "../agent/loop.js";
import type { ToolApprovalHandler } from "../approval/types.js";
import type { ModelStreamRunner } from "../model/runtime.js";
import type { StreamEvent } from "../model/types.js";
import { BashTool } from "./bash.js";
import { ToolRegistry } from "./registry.js";

const model = {
  id: "fake-model",
  name: "Fake",
  provider: "fake" as const,
  contextWindow: 4_096,
  maxOutputTokens: 1_024,
};

async function collect<T>(stream: AsyncIterable<T>): Promise<T[]> {
  const values: T[] = [];

  for await (const value of stream) {
    values.push(value);
  }

  return values;
}

describe("BashTool command validation", () => {
  test("rejects NUL before requesting approval", async () => {
    let providerCalls = 0;
    let approvalRequests = 0;
    const runner: ModelStreamRunner = {
      async *stream(): AsyncIterable<StreamEvent> {
        providerCalls += 1;
        yield { type: "start" };

        if (providerCalls === 1) {
          yield {
            type: "tool-call",
            toolCall: {
              id: "call-nul",
              name: "bash",
              arguments: { command: "printf before\0printf after" },
            },
          };
          yield { type: "done", reason: "tool-call" };
          return;
        }

        yield { type: "done", reason: "stop" };
      },
    };
    const approvalHandler: ToolApprovalHandler = {
      async requestApproval() {
        approvalRequests += 1;
        return "deny";
      },
    };
    const registry = new ToolRegistry();
    registry.register(new BashTool({ rootDir: "guaranteed-missing-root" }));

    const events = await collect(
      new AgentLoop(runner, registry, approvalHandler).stream({
        model,
        messages: [],
      }),
    );
    const result = events.find((event) => event.type === "tool-result");

    expect(approvalRequests).toBe(0);
    expect(result).toMatchObject({
      type: "tool-result",
      result: {
        isError: true,
        content: expect.stringMatching(/validation/i),
      },
    });
  });

  test("rejects NUL before resolving the workspace or spawning", async () => {
    const tool = new BashTool({ rootDir: "guaranteed-missing-root" });

    await expect(tool.execute({
      command: "printf before\0printf after",
    })).resolves.toEqual({
      content: "bash.command must not contain NUL characters.",
      isError: true,
    });
  });
});
