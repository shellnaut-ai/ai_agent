import { describe, expect, test, vi } from "vitest";

import type { ModelRequest } from "../model/types.js";
import { OpenAICompatibleProvider } from "./openai-compatible-provider.js";

function sseResponse(events: readonly string[]): Response {
  const encoder = new TextEncoder();

  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const event of events) {
          controller.enqueue(encoder.encode(`data: ${event}\n\n`));
        }
        controller.close();
      },
    }),
    { status: 200 },
  );
}

const request: ModelRequest = {
  model: {
    id: "local-model",
    name: "Local Model",
    provider: "openai-compatible",
    contextWindow: 8192,
    maxOutputTokens: 1024,
  },
  messages: [{ role: "user", content: "inspect" }],
  tools: [],
};

async function collect<T>(events: AsyncIterable<T>): Promise<T[]> {
  const collected: T[] = [];
  for await (const event of events) collected.push(event);
  return collected;
}

describe("OpenAICompatibleProvider", () => {
  test("normalizes text and emits exactly one terminal event", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(
      sseResponse([
        JSON.stringify({ choices: [{ delta: { content: "hel" } }] }),
        JSON.stringify({
          choices: [{ delta: { content: "lo" }, finish_reason: "stop" }],
        }),
        "[DONE]",
      ]),
    );
    const provider = new OpenAICompatibleProvider({
      baseUrl: "http://127.0.0.1:11434/v1/",
      fetch,
      model: request.model,
    });

    const events = await collect(provider.stream(request));

    expect(events).toEqual([
      { type: "start" },
      { type: "text-delta", delta: "hel" },
      { type: "text-delta", delta: "lo" },
      { type: "done", reason: "stop" },
    ]);
    expect(fetch).toHaveBeenCalledOnce();
  });

  test("assembles fragmented tool arguments in source order", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(
      sseResponse([
        JSON.stringify({
          choices: [{
            delta: {
              tool_calls: [{
                index: 0,
                id: "call-1",
                function: { name: "read", arguments: '{"path"' },
              }],
            },
          }],
        }),
        JSON.stringify({
          choices: [{
            delta: {
              tool_calls: [{
                index: 0,
                function: { arguments: ':"README.md"}' },
              }],
            },
            finish_reason: "tool_calls",
          }],
        }),
        "[DONE]",
      ]),
    );
    const provider = new OpenAICompatibleProvider({
      baseUrl: "http://localhost:8080/v1",
      fetch,
      model: request.model,
    });

    const events = await collect(provider.stream(request));

    expect(events).toEqual([
      { type: "start" },
      {
        type: "tool-call",
        toolCall: {
          id: "call-1",
          name: "read",
          arguments: { path: "README.md" },
        },
      },
      { type: "done", reason: "tool-call" },
    ]);
  });

  test("turns malformed chunks into one terminal error event", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(
      sseResponse([JSON.stringify({ choices: "not-an-array" })]),
    );
    const provider = new OpenAICompatibleProvider({
      baseUrl: "http://localhost:8080/v1",
      fetch,
      model: request.model,
    });

    const events = await collect(provider.stream(request));

    expect(events[0]).toEqual({ type: "start" });
    expect(events[1]).toMatchObject({ type: "error", reason: "error" });
    expect(events).toHaveLength(2);
  });
});
