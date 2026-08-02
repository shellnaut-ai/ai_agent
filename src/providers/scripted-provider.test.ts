import { describe, expect, it } from "vitest";

import type { ModelRequest, ModelStreamEvent } from "../core/contracts.js";
import { ScriptedProvider } from "./scripted-provider.js";

const request: ModelRequest = {
  model: "teaching-model",
  messages: [
    {
      id: "user-1",
      role: "user",
      content: "안녕",
      createdAt: "2026-07-26T00:00:00.000Z",
    },
  ],
  tools: [],
};

async function collect(stream: AsyncIterable<ModelStreamEvent>): Promise<ModelStreamEvent[]> {
  const events: ModelStreamEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

describe("ScriptedProvider", () => {
  it("replays each scripted response and preserves requests in call order", async () => {
    const provider = new ScriptedProvider([
      [{ type: "text_delta", delta: "첫" }, { type: "finish", reason: "stop" }],
      [{ type: "text_delta", delta: "둘" }, { type: "finish", reason: "length" }],
    ]);

    await expect(collect(provider.stream(request))).resolves.toEqual([
      { type: "text_delta", delta: "첫" },
      { type: "finish", reason: "stop" },
    ]);
    await expect(collect(provider.stream({ ...request, model: "second-model" }))).resolves.toEqual([
      { type: "text_delta", delta: "둘" },
      { type: "finish", reason: "length" },
    ]);

    expect(provider.requests).toEqual([request, { ...request, model: "second-model" }]);
  });

  it("fails explicitly when its scripts are exhausted", async () => {
    const provider = new ScriptedProvider([]);

    await expect(collect(provider.stream(request))).rejects.toThrow("ScriptedProvider has no script for call 0");
  });
});
