import { Type } from "typebox";
import { describe, expect, test } from "vitest";

import type { ModelStreamRunner } from "./runtime.js";
import { RetryingModelRuntime } from "./retry.js";
import type { ModelRequest, StreamEvent } from "./types.js";

async function collect<T>(stream: AsyncIterable<T>): Promise<T[]> {
  const events: T[] = [];

  for await (const event of stream) {
    events.push(event);
  }

  return events;
}

describe("RetryingModelRuntime", () => {
  test("clones the complete ModelRequest independently for every attempt", async () => {
    const original: ModelRequest = {
      model: {
        id: "model-1",
        name: "Model One",
        provider: "fake",
        contextWindow: 8_192,
        maxOutputTokens: 1_024,
      },
      systemPrompt: "Keep the request pristine.",
      messages: [
        { role: "user", content: "original" },
        {
          role: "assistant",
          content: "calling",
          toolCalls: [
            { id: "call-1", name: "read", arguments: { path: "a.txt" } },
          ],
          providerState: {
            provider: "openai-codex",
            value: { nested: { replay: "original" } },
          },
        },
      ],
      tools: [
        {
          name: "read",
          description: "Read one file.",
          inputSchema: Type.Object({ path: Type.String() }),
        },
      ],
      maxOutputTokens: 512,
    };
    const attempts: ModelRequest[] = [];
    const runner: ModelStreamRunner = {
      async *stream(request): AsyncIterable<StreamEvent> {
        attempts.push(request);
        yield { type: "start" };

        if (attempts.length === 1) {
          request.model.id = "mutated-model";
          request.messages[0] = { role: "user", content: "mutated" };
          const assistant = request.messages[1];

          if (assistant?.role === "assistant") {
            (assistant.toolCalls[0]!.arguments as { path: string }).path =
              "mutated.txt";
            const state = assistant.providerState?.value as {
              nested: { replay: string };
            };
            state.nested.replay = "mutated";
          }

          (request.tools[0] as { description: string }).description = "mutated";
          (request as { systemPrompt?: string }).systemPrompt = "mutated";
          (request as { maxOutputTokens?: number }).maxOutputTokens = 1;
          yield {
            type: "error",
            reason: "error",
            error: new Error("retry me"),
          };
          return;
        }

        yield { type: "done", reason: "stop" };
      },
    };

    const events = await collect(
      new RetryingModelRuntime(runner, {
        maxRetries: 1,
        initialDelayMs: 0,
      }).stream(original),
    );

    expect(events.at(-1)).toEqual({ type: "done", reason: "stop" });
    expect(attempts).toHaveLength(2);
    expect(attempts[0]).not.toBe(attempts[1]);
    expect(attempts[1]).not.toBe(original);
    expect(attempts[1]).toEqual(original);
    expect(original.model.id).toBe("model-1");
    expect(original.messages[0]).toEqual({ role: "user", content: "original" });
    expect(original.tools[0]?.description).toBe("Read one file.");
  });
});
