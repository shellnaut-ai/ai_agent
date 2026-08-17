import { afterEach, describe, expect, test, vi } from "vitest";

import type { ModelRequest, StreamEvent } from "../../model/types.js";
import { LlamaProvider } from "./provider.js";

function sseResponse(events: readonly unknown[]): Response {
  const encoder = new TextEncoder();

  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const event of events) {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
        }
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        controller.close();
      },
    }),
    { status: 200 },
  );
}

async function collect<T>(stream: AsyncIterable<T>): Promise<T[]> {
  const events: T[] = [];

  for await (const event of stream) {
    events.push(event);
  }

  return events;
}

function withoutStream(body: Record<string, unknown>): Record<string, unknown> {
  const { stream: _stream, ...withoutStream } = body;
  return withoutStream;
}

const request: ModelRequest = {
  model: {
    id: "llama-test",
    name: "Llama Test",
    provider: "llama",
    contextWindow: 8_192,
    maxOutputTokens: 1_024,
  },
  messages: [{ role: "user", content: "hello" }],
  tools: [],
};

function createProvider(): LlamaProvider {
  return new LlamaProvider({
    serverUrl: "http://127.0.0.1:8080",
    modelId: request.model.id,
    modelName: request.model.name,
    contextWindow: request.model.contextWindow,
    maxOutputTokens: request.model.maxOutputTokens,
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("LlamaProvider", () => {
  test("counts input tokens with the same request payload as streaming", async () => {
    const requests: Request[] = [];
    const fetchFake = async (input: RequestInfo | URL, init?: RequestInit) => {
      const captured = new Request(input, init);
      requests.push(captured);
      if (captured.url.endsWith("/input_tokens")) {
        return Response.json({ input_tokens: 321 });
      }
      return sseResponse([
        { choices: [{ delta: { content: "ok" }, finish_reason: "stop" }] },
      ]);
    };
    vi.stubGlobal("fetch", fetchFake);
    const provider = createProvider();

    await expect(provider.countInputTokens(request)).resolves.toBe(321);
    await collect(provider.stream(request));
    const countBody = await requests[0]!.json() as Record<string, unknown>;
    const streamBody = await requests[1]!.json() as Record<string, unknown>;

    expect(countBody).not.toHaveProperty("stream");
    expect(countBody).toEqual(withoutStream(streamBody));
  });

  test.each([
    [400, { error: { message: "context_length_exceeded" } }],
    [500, { message: "exceeds the available context size" }],
  ])("maps HTTP %i context overflow", async (status, body) => {
    vi.stubGlobal("fetch", async () => Response.json(body, { status }));
    const provider = createProvider();

    const events = await collect(provider.stream(request));

    expect(events.at(-1)).toMatchObject({
      type: "error",
      error: { name: "ContextOverflowError" },
    });
  });
});
