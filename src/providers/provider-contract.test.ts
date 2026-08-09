import { afterEach, describe, expect, test, vi } from "vitest";

import type { ModelRequest, StreamEvent } from "../model/types.js";
import { LlamaProvider } from "./llama/provider.js";
import { OpenAICodexProvider } from "./openai-codex-provider.js";
import { OpenAICompatibleProvider } from "./openai-compatible-provider.js";

function sseResponse(events: readonly unknown[]): Response {
  const encoder = new TextEncoder();
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const event of events) {
          const data = typeof event === "string" ? event : JSON.stringify(event);
          controller.enqueue(encoder.encode(`data: ${data}\n\n`));
        }
        controller.close();
      },
    }),
    { status: 200 },
  );
}

async function collect(stream: AsyncIterable<StreamEvent>): Promise<StreamEvent[]> {
  const events: StreamEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

function assertIncompleteCallWasNotExposed(events: readonly StreamEvent[]): void {
  expect(events).not.toContainEqual(expect.objectContaining({ type: "tool-call" }));
  expect(events.at(-1)).toMatchObject({
    type: "done",
    reason: "length",
    incompleteToolCall: true,
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("provider terminal contract", () => {
  test("llama.cpp marks a length-truncated tool fragment without exposing it", async () => {
    vi.stubGlobal("fetch", vi.fn<typeof globalThis.fetch>().mockResolvedValue(
      sseResponse([
        {
          choices: [{
            delta: {
              tool_calls: [{
                index: 0,
                id: "call-1",
                function: { name: "read", arguments: '{"path":"README' },
              }],
            },
            finish_reason: "length",
          }],
        },
        "[DONE]",
      ]),
    ));
    const provider = new LlamaProvider({
      serverUrl: "http://127.0.0.1:8080",
      modelId: "gemma",
      contextWindow: 8192,
      maxOutputTokens: 1024,
    });
    const model = (await provider.listModels())[0];
    if (model === undefined) throw new Error("Expected llama.cpp model");

    const events = await collect(provider.stream({
      model,
      messages: [{ role: "user", content: "read the file" }],
      tools: [],
    }));

    assertIncompleteCallWasNotExposed(events);
  });

  test("OpenAI-compatible marks a length-truncated tool fragment without exposing it", async () => {
    const model = {
      id: "ollama-gemma",
      name: "Ollama Gemma",
      provider: "openai-compatible" as const,
      contextWindow: 8192,
      maxOutputTokens: 1024,
    };
    const provider = new OpenAICompatibleProvider({
      baseUrl: "http://127.0.0.1:11434/v1",
      model,
      fetch: vi.fn<typeof globalThis.fetch>().mockResolvedValue(
        sseResponse([{
          choices: [{
            delta: {
              tool_calls: [{
                index: 0,
                id: "call-1",
                function: { name: "read", arguments: '{"path":"README' },
              }],
            },
            finish_reason: "length",
          }],
        }]),
      ),
    });

    const events = await collect(provider.stream({
      model,
      messages: [{ role: "user", content: "read the file" }],
      tools: [],
    }));

    assertIncompleteCallWasNotExposed(events);
  });

  test("Codex marks a length-truncated tool fragment without exposing it", async () => {
    const model = {
      id: "gpt-5.1-codex-mini",
      name: "Codex Mini",
      provider: "openai-codex" as const,
      contextWindow: 128_000,
      maxOutputTokens: 4096,
    };
    const provider = new OpenAICodexProvider({
      model,
      resolver: {
        async resolve() {
          return {
            accessToken: "test-access",
            refreshToken: "test-refresh",
            expiresAt: 9_999_999,
            accountId: "account-1",
          };
        },
      },
      fetch: vi.fn<typeof globalThis.fetch>().mockResolvedValue(
        sseResponse([
          {
            type: "response.output_item.added",
            output_index: 0,
            item: {
              type: "function_call",
              id: "fc-1",
              call_id: "call-1",
              name: "read",
              arguments: '{"path":"README',
            },
          },
          {
            type: "response.incomplete",
            response: {
              status: "incomplete",
              incomplete_details: { reason: "max_output_tokens" },
            },
          },
        ]),
      ),
    });
    const request: ModelRequest = {
      model,
      messages: [{ role: "user", content: "read the file" }],
      tools: [],
    };

    const events = await collect(provider.stream(request));

    assertIncompleteCallWasNotExposed(events);
  });
});
