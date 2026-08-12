import { createHash } from "node:crypto";

import { afterEach, describe, expect, test, vi } from "vitest";

import {
  CONTINUATION_INSTRUCTION,
  type Model,
  type ModelRequest,
  type StreamEvent,
} from "../model/types.js";
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

describe("provider continuation wire contract", () => {
  test("llama.cpp adds the shared wire-only continuation instruction", async () => {
    let captured: Request | undefined;
    vi.stubGlobal("fetch", vi.fn<typeof globalThis.fetch>(async (input, init) => {
      captured = new Request(input, init);
      return sseResponse([
        { choices: [{ delta: {}, finish_reason: "stop" }] },
        "[DONE]",
      ]);
    }));
    const provider = new LlamaProvider({
      serverUrl: "http://127.0.0.1:8080",
      modelId: "gemma",
      contextWindow: 8192,
      maxOutputTokens: 1024,
    });
    const model = (await provider.listModels())[0]!;

    await collect(provider.stream(continuationRequest(model)));

    const body = await captured?.json() as { messages?: unknown[] };
    expect(body.messages?.at(-1)).toEqual({
      role: "user",
      content: CONTINUATION_INSTRUCTION,
    });
  });

  test("OpenAI-compatible adds the shared wire-only continuation instruction", async () => {
    let captured: Request | undefined;
    const model = continuationModel("openai-compatible");
    const provider = new OpenAICompatibleProvider({
      baseUrl: "http://127.0.0.1:11434/v1",
      model,
      fetch: async (input, init) => {
        captured = new Request(input, init);
        return sseResponse([{
          choices: [{ delta: {}, finish_reason: "stop" }],
        }]);
      },
    });

    await collect(provider.stream(continuationRequest(model)));

    const body = await captured?.json() as { messages?: unknown[] };
    expect(body.messages?.at(-1)).toEqual({
      role: "user",
      content: CONTINUATION_INSTRUCTION,
    });
  });

  test("Codex replays encrypted state before the shared continuation instruction", async () => {
    let captured: Request | undefined;
    const model = continuationModel("openai-codex");
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
      fetch: async (input, init) => {
        captured = new Request(input, init);
        return sseResponse([{
          type: "response.completed",
          response: { status: "completed" },
        }]);
      },
    });
    const request = continuationRequest(model);
    request.messages[1] = {
      ...request.messages[1] as Extract<typeof request.messages[number], { role: "assistant" }>,
      providerState: {
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
      },
    };

    await collect(provider.stream(request));

    const body = await captured?.json() as { input?: unknown[] };
    expect(body.input).toContainEqual(expect.objectContaining({
      type: "reasoning",
      encrypted_content: "encrypted",
    }));
    expect(body.input?.at(-1)).toEqual({
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: CONTINUATION_INSTRUCTION }],
    });
  });

  test("rejects a continuation whose last assistant segment has another logical ID", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    const model = continuationModel("openai-compatible");
    const provider = new OpenAICompatibleProvider({
      baseUrl: "http://127.0.0.1:11434/v1",
      model,
      fetch,
    });
    const validRequest = continuationRequest(model);
    const request: ModelRequest = {
      ...validRequest,
      continuation: {
        ...validRequest.continuation!,
        logicalMessageId: "another-logical-message",
      },
    };

    const events = await collect(provider.stream(request));

    expect(fetch).not.toHaveBeenCalled();
    expect(events.at(-1)).toMatchObject({
      type: "error",
      error: { message: expect.stringMatching(/continuation.*logical/i) },
    });
  });
});

function continuationModel(provider: Model["provider"]): Model {
  return {
    id: "continuation-model",
    name: "Continuation",
    provider,
    contextWindow: 8192,
    maxOutputTokens: 1024,
  };
}

function continuationRequest(model: Model): ModelRequest {
  const tailHash = createHash("sha256").update("partial", "utf8").digest("hex");
  return {
    model,
    messages: [
      { role: "user", content: "write" },
      {
        role: "assistant",
        content: "partial",
        toolCalls: [],
        continuation: {
          logicalMessageId: "logical-message",
          segmentIndex: 0,
          status: "partial",
          resumeAllowed: true,
          tailHash,
          estimatedTotalOutputTokens: 4,
        },
      },
    ],
    tools: [],
    continuation: {
      kind: "assistant-output",
      logicalMessageId: "logical-message",
      segmentIndex: 1,
      previousTail: "partial",
      previousTailHash: tailHash,
    },
  };
}
