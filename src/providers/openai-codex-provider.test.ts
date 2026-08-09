import { describe, expect, test, vi } from "vitest";

import { AuthRequiredError } from "../auth/oauth-resolver.js";
import type { OAuthCredential } from "../auth/oauth-contracts.js";
import type { ModelRequest } from "../model/types.js";
import { OpenAICodexProvider } from "./openai-codex-provider.js";

const credential: OAuthCredential = {
  accessToken: "test-access",
  refreshToken: "test-refresh",
  expiresAt: 9_999_999,
  accountId: "account-1",
};

const model = {
  id: "gpt-5.1-codex-mini",
  name: "Codex Mini",
  provider: "openai-codex" as const,
  contextWindow: 128_000,
  maxOutputTokens: 4096,
};

function request(): ModelRequest {
  return {
    model,
    messages: [
      { role: "user", content: "read a.txt" },
      {
        role: "assistant",
        content: "reading",
        toolCalls: [{
          id: "old-call",
          name: "read",
          arguments: { path: "a.txt" },
        }],
      },
      {
        role: "tool",
        toolCallId: "old-call",
        content: "A",
        isError: false,
      },
    ],
    tools: [],
  };
}

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

async function collect<T>(stream: AsyncIterable<T>): Promise<T[]> {
  const events: T[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

describe("OpenAICodexProvider", () => {
  test("does not call the model endpoint when login is required", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    const provider = new OpenAICodexProvider({
      model,
      resolver: {
        async resolve() {
          throw new AuthRequiredError("missing");
        },
      },
      fetch,
    });

    const events = await collect(provider.stream(request()));

    expect(fetch).not.toHaveBeenCalled();
    expect(events[0]).toEqual({ type: "start" });
    expect(events[1]).toMatchObject({ type: "error", reason: "error" });
  });

  test("serializes Responses input and assembles one function call", async () => {
    let captured: Request | undefined;
    const provider = new OpenAICodexProvider({
      model,
      resolver: { resolve: async () => credential },
      instructions: "Base coding policy.",
      fetch: async (input, init) => {
        captured = new Request(input, init);
        return sseResponse([
          JSON.stringify({
            type: "response.output_text.delta",
            delta: "checking",
          }),
          JSON.stringify({
            type: "response.output_item.added",
            output_index: 1,
            item: {
              type: "function_call",
              call_id: "call-1",
              name: "read",
              arguments: "",
            },
          }),
          JSON.stringify({
            type: "response.function_call_arguments.delta",
            output_index: 1,
            delta: '{"path":"b.txt"}',
          }),
          JSON.stringify({
            type: "response.completed",
            response: { status: "completed" },
          }),
        ]);
      },
    });

    const events = await collect(provider.stream({
      ...request(),
      systemPrompt: "Summarize only the supplied conversation.",
      maxOutputTokens: 321,
    }));

    expect(events).toEqual([
      { type: "start" },
      { type: "text-delta", delta: "checking" },
      {
        type: "tool-call",
        toolCall: {
          id: "call-1",
          name: "read",
          arguments: { path: "b.txt" },
        },
      },
      { type: "done", reason: "tool-call" },
    ]);
    expect(captured?.headers.get("authorization")).toBe("Bearer test-access");
    expect(captured?.headers.get("chatgpt-account-id")).toBe("account-1");
    await expect(captured?.json()).resolves.toMatchObject({
      model: "gpt-5.1-codex-mini",
      instructions:
        "Base coding policy.\n\nSummarize only the supplied conversation.",
      max_output_tokens: 321,
      stream: true,
      store: false,
    });
  });
});
