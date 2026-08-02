import { describe, expect, it } from "vitest";

import type { ModelStreamEvent } from "../core/contracts.js";
import { OpenAICompatibleProvider } from "./openai-compatible-provider.js";

async function collect(stream: AsyncIterable<ModelStreamEvent>): Promise<ModelStreamEvent[]> {
  const events: ModelStreamEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

function sseResponse(chunks: readonly string[]): Response {
  const encoder = new TextEncoder();
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
        controller.close();
      },
    }),
    { status: 200, headers: { "content-type": "text/event-stream" } },
  );
}

describe("OpenAICompatibleProvider", () => {
  it("serializes common messages and tools, then normalizes split SSE chat chunks", async () => {
    let captured: Request | undefined;
    const fetchImpl: typeof fetch = async (input) => {
      captured = input instanceof Request ? input : new Request(input);
      return sseResponse([
        "da",
        "ta: {\"choi",
        "ces\":[{\"delta\":{\"content\":\"안\"}}]}\n\n",
        "data: {\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":0,\"id\":\"call_1\",\"function\":{\"name\":\"read\",\"arguments\":\"{\\\"path\\\":\"}}]}}]}\n\n",
        "data: {\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":0,\"function\":{\"arguments\":\"\\\"a.txt\\\"}\"}}]}}]}\n\n",
        "data: {\"choices\":[{\"finish_reason\":\"tool_calls\"}]}\n\ndata: [DO",
        "NE]\n\n",
      ]);
    };
    const provider = new OpenAICompatibleProvider({
      baseUrl: "https://example.test/v1",
      apiKey: "test-key",
      fetch: fetchImpl,
    });

    await expect(collect(provider.stream({
      model: "gpt-test",
      messages: [
        { id: "u1", role: "user", content: "파일 읽어", createdAt: "2026-07-26T00:00:00.000Z" },
        { id: "t1", role: "tool", toolCallId: "old-call", toolName: "read", ok: true, content: "내용", createdAt: "2026-07-26T00:00:01.000Z" },
      ],
      tools: [{ name: "read", description: "Read a file", inputSchema: { type: "object", properties: { path: { type: "string" } } } }],
    }))).resolves.toEqual([
      { type: "text_delta", delta: "안" },
      { type: "tool_call_delta", index: 0, id: "call_1", name: "read", argumentsDelta: "{\"path\":" },
      { type: "tool_call_delta", index: 0, argumentsDelta: "\"a.txt\"}" },
      { type: "finish", reason: "tool_calls" },
    ]);

    expect(captured?.url).toBe("https://example.test/v1/chat/completions");
    expect(captured?.method).toBe("POST");
    expect(captured?.headers.get("authorization")).toBe("Bearer test-key");
    await expect(captured?.json()).resolves.toEqual({
      model: "gpt-test",
      stream: true,
      messages: [
        { role: "user", content: "파일 읽어" },
        { role: "tool", tool_call_id: "old-call", content: "내용" },
      ],
      tools: [{ type: "function", function: { name: "read", description: "Read a file", parameters: { type: "object", properties: { path: { type: "string" } } } } }],
    });
  });

  it("throws a provider error for non-success responses", async () => {
    const provider = new OpenAICompatibleProvider({
      baseUrl: "https://example.test/v1/",
      fetch: async () => new Response("bad credentials", { status: 401, statusText: "Unauthorized" }),
    });

    await expect(collect(provider.stream({ model: "x", messages: [], tools: [] }))).rejects.toThrow(
      "OpenAI-compatible provider request failed: 401 Unauthorized: bad credentials",
    );
  });

  it("frames CRLF SSE events, ignores comments, and joins multiple data fields", async () => {
    const provider = new OpenAICompatibleProvider({
      baseUrl: "https://example.test/v1",
      fetch: async () => sseResponse([
        ": keep-alive\r\n",
        "data: {\"choices\":\r\n",
        "data: [{\"delta\":{\"content\":null,\"tool_calls\":[{\"index\":0,\"id\":\"call_1\",\"function\":{\"name\":\"read\",\"arguments\":\"{}\"}}]}}]}\r\n",
        "\r\n",
        "data: {\"choices\":[{\"finish_reason\":\"tool_calls\"}]}\r\n\r\n",
        "data: [DONE]\r\n\r\n",
      ]),
    });

    await expect(collect(provider.stream({
      model: "gpt-test",
      messages: [],
      tools: [],
    }))).resolves.toEqual([
      { type: "tool_call_delta", index: 0, id: "call_1", name: "read", argumentsDelta: "{}" },
      { type: "finish", reason: "tool_calls" },
    ]);
  });

  it("rejects chunks whose JSON shape does not match the provider boundary", async () => {
    const provider = new OpenAICompatibleProvider({
      baseUrl: "https://example.test/v1",
      fetch: async () => sseResponse([
        "data: {\"choices\":[{\"delta\":{\"content\":42}}]}\n\n",
      ]),
    });

    await expect(collect(provider.stream({
      model: "gpt-test",
      messages: [],
      tools: [],
    }))).rejects.toThrow(
      "OpenAI-compatible provider returned a malformed chunk: choice.delta.content must be a string or null",
    );
  });
});
