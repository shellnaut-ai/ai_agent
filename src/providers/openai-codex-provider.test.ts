import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test, vi } from "vitest";

import { AuthRequiredError } from "../auth/oauth-resolver.js";
import type { OAuthCredential } from "../auth/oauth-contracts.js";
import type {
  AssistantMessage,
  ModelRequest,
  StreamEvent,
} from "../model/types.js";
import type { ToolCall } from "../tools/types.js";
import { JsonlSessionStore } from "../session/jsonl-store.js";
import { Session } from "../session/session.js";
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

function replayResponse(): Response {
  return sseResponse([
    JSON.stringify({
      type: "response.output_item.added",
      output_index: 1,
      item: {
        type: "function_call",
        id: "fc_1",
        call_id: "call-1",
        name: "read",
        arguments: '{"path":"a.txt"}',
      },
    }),
    JSON.stringify({
      type: "response.output_item.done",
      output_index: 0,
      item: {
        type: "reasoning",
        id: "rs_1",
        summary: [],
        encrypted_content: "encrypted",
      },
    }),
    JSON.stringify({
      type: "response.completed",
      response: { status: "completed" },
    }),
  ]);
}

function terminalResponse(): Response {
  return sseResponse([
    JSON.stringify({
      type: "response.completed",
      response: { status: "completed" },
    }),
  ]);
}

function assistantFrom(events: readonly StreamEvent[]): AssistantMessage {
  let content = "";
  const toolCalls: ToolCall[] = [];
  let terminal: Extract<StreamEvent, { type: "done" }> | undefined;

  for (const event of events) {
    if (event.type === "text-delta") content += event.delta;
    if (event.type === "tool-call") toolCalls.push(event.toolCall);
    if (event.type === "done") terminal = event;
  }
  if (terminal === undefined) throw new Error("Expected a terminal event");

  return {
    role: "assistant",
    content,
    toolCalls,
    ...(terminal.providerState === undefined
      ? {}
      : { providerState: terminal.providerState }),
  };
}

async function requestInput(captured: Request | undefined): Promise<unknown[]> {
  if (captured === undefined) throw new Error("Expected a captured request");
  const body = await captured.json() as { input?: unknown };
  if (!Array.isArray(body.input)) throw new Error("Expected request input");
  return body.input;
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
      {
        type: "done",
        reason: "tool-call",
        providerState: {
          provider: "openai-codex",
          value: {
            reasoningItems: [],
            functionItemIds: {},
          },
        },
      },
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

  test("replays encrypted reasoning and function item IDs after a fresh provider instance", async () => {
    const firstProvider = new OpenAICodexProvider({
      model,
      resolver: { resolve: async () => credential },
      fetch: async () => replayResponse(),
    });
    const firstEvents = await collect(firstProvider.stream({
      model,
      messages: [{ role: "user", content: "read a.txt" }],
      tools: [],
    }));
    const assistant = assistantFrom(firstEvents);

    let captured: Request | undefined;
    const restoredProvider = new OpenAICodexProvider({
      model,
      resolver: { resolve: async () => credential },
      fetch: async (input, init) => {
        captured = new Request(input, init);
        return terminalResponse();
      },
    });
    await collect(restoredProvider.stream({
      model,
      messages: [
        { role: "user", content: "read a.txt" },
        assistant,
      ],
      tools: [],
    }));

    const input = await requestInput(captured);
    expect(input).toContainEqual({
      type: "reasoning",
      id: "rs_1",
      summary: [],
      encrypted_content: "encrypted",
    });
    expect(input).toContainEqual(expect.objectContaining({
      type: "function_call",
      id: "fc_1",
      call_id: "call-1",
    }));
  });

  test("replays durable Codex state after restart recovery of a missing tool result", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "pi-clone-codex-recovery-"));

    try {
      const firstProvider = new OpenAICodexProvider({
        model,
        resolver: { resolve: async () => credential },
        fetch: async () => replayResponse(),
      });
      const firstEvents = await collect(firstProvider.stream({
        model,
        messages: [{ role: "user", content: "read a.txt" }],
        tools: [],
      }));
      const assistant = assistantFrom(firstEvents);

      const initialStore = new JsonlSessionStore({
        rootDir,
        sessionId: "restart-recovery",
        model,
      });
      await initialStore.load();
      const initialSession = new Session(initialStore);
      await initialSession.appendMessage({
        role: "user",
        content: "read a.txt",
      });
      await initialSession.appendMessage(assistant);

      const restartedStore = new JsonlSessionStore({
        rootDir,
        sessionId: "restart-recovery",
        model,
      });
      await restartedStore.load();
      const restartedSession = new Session(restartedStore);
      await expect(restartedSession.recoverInterruptedToolCalls())
        .resolves.toEqual([
          expect.objectContaining({
            role: "tool",
            toolCallId: "call-1",
            isError: true,
          }),
        ]);

      let captured: Request | undefined;
      const restoredProvider = new OpenAICodexProvider({
        model,
        resolver: { resolve: async () => credential },
        fetch: async (input, init) => {
          captured = new Request(input, init);
          return terminalResponse();
        },
      });
      await collect(restoredProvider.stream({
        model,
        messages: [...restartedSession.buildActiveMessages()],
        tools: [],
      }));

      const input = await requestInput(captured);
      expect(input).toContainEqual({
        type: "reasoning",
        id: "rs_1",
        summary: [],
        encrypted_content: "encrypted",
      });
      expect(input).toContainEqual(expect.objectContaining({
        type: "function_call",
        id: "fc_1",
        call_id: "call-1",
      }));
      expect(input).toContainEqual(expect.objectContaining({
        type: "function_call_output",
        call_id: "call-1",
        output: expect.stringContaining("outcome is unknown"),
      }));
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  test("replays Codex metadata when compaction shifts the assistant message index", async () => {
    let requestCount = 0;
    let captured: Request | undefined;
    const provider = new OpenAICodexProvider({
      model,
      resolver: { resolve: async () => credential },
      fetch: async (input, init) => {
        requestCount += 1;
        if (requestCount === 1) return replayResponse();
        captured = new Request(input, init);
        return terminalResponse();
      },
    });
    const firstEvents = await collect(provider.stream({
      model,
      messages: [{ role: "user", content: "read a.txt" }],
      tools: [],
    }));
    const assistant = assistantFrom(firstEvents);

    await collect(provider.stream({
      model,
      messages: [
        { role: "user", content: "read a.txt" },
        { role: "user", content: "Summary of the compacted prefix." },
        assistant,
      ],
      tools: [],
    }));

    const input = await requestInput(captured);
    expect(input).toContainEqual({
      type: "reasoning",
      id: "rs_1",
      summary: [],
      encrypted_content: "encrypted",
    });
    expect(input).toContainEqual(expect.objectContaining({
      type: "function_call",
      id: "fc_1",
      call_id: "call-1",
    }));
  });

  test("does not consume replay state owned by another provider", async () => {
    let requestCount = 0;
    let captured: Request | undefined;
    const provider = new OpenAICodexProvider({
      model,
      resolver: { resolve: async () => credential },
      fetch: async (input, init) => {
        requestCount += 1;
        if (requestCount === 1) return replayResponse();
        captured = new Request(input, init);
        return terminalResponse();
      },
    });
    const firstEvents = await collect(provider.stream({
      model,
      messages: [{ role: "user", content: "read a.txt" }],
      tools: [],
    }));
    const assistant: AssistantMessage = {
      ...assistantFrom(firstEvents),
      providerState: {
        provider: "fake",
        value: {
          reasoningItems: [{
            type: "reasoning",
            id: "foreign-rs",
            summary: [],
            encrypted_content: "foreign-encrypted",
          }],
          functionItemIds: { "call-1": "foreign-fc" },
        },
      },
    };

    await collect(provider.stream({
      model,
      messages: [
        { role: "user", content: "read a.txt" },
        assistant,
      ],
      tools: [],
    }));

    const input = await requestInput(captured);
    expect(input).not.toContainEqual(expect.objectContaining({
      type: "reasoning",
    }));
    expect(input).toContainEqual(expect.objectContaining({
      type: "function_call",
      call_id: "call-1",
    }));
    expect(input).not.toContainEqual(expect.objectContaining({
      type: "function_call",
      id: expect.any(String),
      call_id: "call-1",
    }));
  });

  test("ignores malformed Codex replay state as one invalid value", async () => {
    let requestCount = 0;
    let captured: Request | undefined;
    const provider = new OpenAICodexProvider({
      model,
      resolver: { resolve: async () => credential },
      fetch: async (input, init) => {
        requestCount += 1;
        if (requestCount === 1) return replayResponse();
        captured = new Request(input, init);
        return terminalResponse();
      },
    });
    const firstEvents = await collect(provider.stream({
      model,
      messages: [{ role: "user", content: "read a.txt" }],
      tools: [],
    }));
    const assistant: AssistantMessage = {
      ...assistantFrom(firstEvents),
      providerState: {
        provider: "openai-codex",
        value: {
          reasoningItems: "not-an-array",
          functionItemIds: { "call-1": "untrusted-fc" },
        },
      },
    };

    await collect(provider.stream({
      model,
      messages: [
        { role: "user", content: "read a.txt" },
        assistant,
      ],
      tools: [],
    }));

    const input = await requestInput(captured);
    expect(input).not.toContainEqual(expect.objectContaining({
      type: "reasoning",
    }));
    expect(input).not.toContainEqual(expect.objectContaining({
      type: "function_call",
      id: expect.any(String),
      call_id: "call-1",
    }));
  });
});
