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

  test("does not emit a partial mutating call from response.incomplete", async () => {
    const provider = new OpenAICodexProvider({
      model,
      resolver: { resolve: async () => credential },
      fetch: async () => sseResponse([
        JSON.stringify({
          type: "response.output_item.added",
          output_index: 0,
          item: {
            type: "function_call",
            call_id: "call-1",
            name: "write",
            arguments: '{"path":"partial',
          },
        }),
        JSON.stringify({
          type: "response.incomplete",
          response: {
            status: "incomplete",
            incomplete_details: { reason: "max_output_tokens" },
          },
        }),
      ]),
    });

    const events = await collect(provider.stream(request()));

    expect(events.some((event) => event.type === "tool-call")).toBe(false);
    expect(events.at(-1)).toMatchObject({ type: "done", reason: "length" });
  });

  test("fails content_filter incomplete responses explicitly", async () => {
    const provider = new OpenAICodexProvider({
      model,
      resolver: { resolve: async () => credential },
      fetch: async () => sseResponse([
        JSON.stringify({
          type: "response.incomplete",
          response: {
            status: "incomplete",
            incomplete_details: { reason: "content_filter" },
          },
        }),
      ]),
    });

    const events = await collect(provider.stream(request()));

    expect(events.some((event) => event.type === "tool-call")).toBe(false);
    expect(events.some((event) => event.type === "done")).toBe(false);
    expect(events.at(-1)).toMatchObject({
      type: "error",
      error: { message: expect.stringMatching(/content_filter/i) },
    });
  });

  test("uses final function arguments when only the done event contains them", async () => {
    const provider = new OpenAICodexProvider({
      model,
      resolver: { resolve: async () => credential },
      fetch: async () => sseResponse([
        JSON.stringify({
          type: "response.output_item.added",
          output_index: 0,
          item: {
            type: "function_call",
            id: "fc-1",
            call_id: "call-1",
            name: "read",
            arguments: "",
          },
        }),
        JSON.stringify({
          type: "response.function_call_arguments.done",
          output_index: 0,
          arguments: '{"path":"final.txt"}',
        }),
        JSON.stringify({
          type: "response.completed",
          response: { status: "completed" },
        }),
      ]),
    });

    const events = await collect(provider.stream(request()));

    expect(events).toContainEqual({
      type: "tool-call",
      toolCall: {
        id: "call-1",
        name: "read",
        arguments: { path: "final.txt" },
      },
    });
  });

  test("prefers canonical final arguments over provisional deltas", async () => {
    const provider = new OpenAICodexProvider({
      model,
      resolver: { resolve: async () => credential },
      fetch: async () => sseResponse([
        JSON.stringify({
          type: "response.output_item.added",
          output_index: 0,
          item: {
            type: "function_call",
            call_id: "call-1",
            name: "read",
            arguments: '{"path":"provisional.txt"}',
          },
        }),
        JSON.stringify({
          type: "response.function_call_arguments.done",
          output_index: 0,
          arguments: '{"path":"canonical.txt"}',
        }),
        JSON.stringify({
          type: "response.completed",
          response: { status: "completed" },
        }),
      ]),
    });

    const events = await collect(provider.stream(request()));
    const call = events.find((event) => event.type === "tool-call");

    expect(call).toMatchObject({
      type: "tool-call",
      toolCall: { arguments: { path: "canonical.txt" } },
    });
  });

  test("rejects malformed canonical final arguments before emitting a call", async () => {
    const provider = new OpenAICodexProvider({
      model,
      resolver: { resolve: async () => credential },
      fetch: async () => sseResponse([
        JSON.stringify({
          type: "response.output_item.added",
          output_index: 0,
          item: {
            type: "function_call",
            call_id: "call-1",
            name: "read",
            arguments: "{}",
          },
        }),
        JSON.stringify({
          type: "response.function_call_arguments.done",
          output_index: 0,
          arguments: "{",
        }),
        JSON.stringify({
          type: "response.completed",
          response: { status: "completed" },
        }),
      ]),
    });

    const events = await collect(provider.stream(request()));

    expect(events.some((event) => event.type === "tool-call")).toBe(false);
    expect(events.at(-1)).toMatchObject({ type: "error" });
  });

  test("validates the complete final call batch before emitting any call", async () => {
    const provider = new OpenAICodexProvider({
      model,
      resolver: { resolve: async () => credential },
      fetch: async () => sseResponse([
        JSON.stringify({
          type: "response.output_item.added",
          output_index: 0,
          item: {
            type: "function_call",
            id: "fc-good",
            call_id: "call-good",
            name: "read",
            arguments: '{"path":"good.txt"}',
          },
        }),
        JSON.stringify({
          type: "response.output_item.added",
          output_index: 1,
          item: {
            type: "function_call",
            id: "fc-bad",
            call_id: "call-bad",
            name: "read",
            arguments: "{",
          },
        }),
        JSON.stringify({
          type: "response.completed",
          response: { status: "completed" },
        }),
      ]),
    });

    const events = await collect(provider.stream(request()));

    expect(events.filter((event) => event.type === "tool-call")).toEqual([]);
    expect(events.some((event) => event.type === "done")).toBe(false);
    expect(events.at(-1)).toMatchObject({
      type: "error",
      error: { message: expect.stringMatching(/invalid arguments/i) },
    });
  });

  test("uses a final function item without provisional events", async () => {
    const provider = new OpenAICodexProvider({
      model,
      resolver: { resolve: async () => credential },
      fetch: async () => sseResponse([
        JSON.stringify({
          type: "response.completed",
          response: {
            status: "completed",
            output: [{
              type: "function_call",
              id: "fc-final",
              call_id: "call-final",
              name: "read",
              arguments: '{"path":"final-only.txt"}',
            }],
          },
        }),
      ]),
    });

    const events = await collect(provider.stream(request()));

    expect(events).toContainEqual({
      type: "tool-call",
      toolCall: {
        id: "call-final",
        name: "read",
        arguments: { path: "final-only.txt" },
      },
    });
    expect(events.at(-1)).toMatchObject({ type: "done", reason: "tool-call" });
  });

  test("maps reversed final function item IDs by call ID", async () => {
    const provider = new OpenAICodexProvider({
      model,
      resolver: { resolve: async () => credential },
      fetch: async () => sseResponse([
        JSON.stringify({
          type: "response.output_item.added",
          output_index: 0,
          item: {
            type: "function_call",
            call_id: "call-1",
            name: "read",
            arguments: "",
          },
        }),
        JSON.stringify({
          type: "response.output_item.added",
          output_index: 1,
          item: {
            type: "function_call",
            call_id: "call-2",
            name: "read",
            arguments: "",
          },
        }),
        JSON.stringify({
          type: "response.output_item.done",
          output_index: 1,
          item: {
            type: "function_call",
            id: "fc-2",
            call_id: "call-2",
            name: "read",
            arguments: '{"path":"two.txt"}',
          },
        }),
        JSON.stringify({
          type: "response.output_item.done",
          output_index: 0,
          item: {
            type: "function_call",
            id: "fc-1",
            call_id: "call-1",
            name: "read",
            arguments: '{"path":"one.txt"}',
          },
        }),
        JSON.stringify({
          type: "response.completed",
          response: { status: "completed" },
        }),
      ]),
    });

    const events = await collect(provider.stream(request()));
    const done = events.find((event) => event.type === "done");

    expect(done).toMatchObject({
      providerState: {
        value: {
          functionItemIds: { "call-1": "fc-1", "call-2": "fc-2" },
        },
      },
    });
    expect(
      events
        .filter((event) => event.type === "tool-call")
        .map((event) => event.toolCall.id),
    ).toEqual(["call-1", "call-2"]);
  });

  test("rejects duplicate Codex call IDs before emitting tools", async () => {
    const provider = new OpenAICodexProvider({
      model,
      resolver: { resolve: async () => credential },
      fetch: async () => sseResponse([
        JSON.stringify({
          type: "response.output_item.added",
          output_index: 0,
          item: {
            type: "function_call",
            call_id: "duplicate",
            name: "read",
            arguments: "{}",
          },
        }),
        JSON.stringify({
          type: "response.output_item.added",
          output_index: 1,
          item: {
            type: "function_call",
            call_id: "duplicate",
            name: "read",
            arguments: "{}",
          },
        }),
      ]),
    });

    const events = await collect(provider.stream(request()));

    expect(events.some((event) => event.type === "tool-call")).toBe(false);
    expect(events.at(-1)).toMatchObject({
      type: "error",
      error: { message: expect.stringMatching(/duplicate/i) },
    });
  });

  test("fails before fetch when replay state belongs to another provider", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    const resolveCredential = vi.fn(async () => credential);
    const provider = new OpenAICodexProvider({
      model,
      resolver: { resolve: resolveCredential },
      fetch,
    });
    const assistant: AssistantMessage = {
      role: "assistant",
      content: "",
      toolCalls: [{
        id: "call-1",
        name: "read",
        arguments: { path: "a.txt" },
      }],
      providerState: {
        provider: "fake",
        value: { foreign: true },
      },
    };

    const events = await collect(provider.stream({
      model,
      messages: [assistant],
      tools: [],
    }));

    expect(events.at(-1)).toMatchObject({ type: "error" });
    expect(resolveCredential).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  test("fails before credentials or fetch when replay arguments are undefined", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    const resolveCredential = vi.fn(async () => credential);
    const provider = new OpenAICodexProvider({
      model,
      resolver: { resolve: resolveCredential },
      fetch,
    });
    const assistant: AssistantMessage = {
      role: "assistant",
      content: "",
      toolCalls: [{
        id: "call-undefined",
        name: "read",
        arguments: undefined,
      }],
    };

    const events = await collect(provider.stream({
      model,
      messages: [assistant],
      tools: [],
    }));

    expect(events.at(-1)).toMatchObject({
      type: "error",
      error: {
        message: 'Tool call "call-undefined" arguments must not be undefined.',
      },
    });
    expect(resolveCredential).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  test("fails before fetch when persisted Codex replay state is malformed", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    const resolveCredential = vi.fn(async () => credential);
    const provider = new OpenAICodexProvider({
      model,
      resolver: { resolve: resolveCredential },
      fetch,
    });
    const assistant: AssistantMessage = {
      role: "assistant",
      content: "",
      toolCalls: [],
      providerState: {
        provider: "openai-codex",
        value: {
          reasoningItems: "not-an-array",
          functionItemIds: { "call-1": "untrusted-fc" },
        },
      },
    };

    const events = await collect(provider.stream({
      model,
      messages: [assistant],
      tools: [],
    }));

    expect(events.at(-1)).toMatchObject({ type: "error" });
    expect(resolveCredential).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  test("accepts legacy assistant messages with no provider state", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => terminalResponse());
    const provider = new OpenAICodexProvider({
      model,
      resolver: { resolve: async () => credential },
      fetch,
    });

    const events = await collect(provider.stream({
      model,
      messages: [{ role: "assistant", content: "legacy", toolCalls: [] }],
      tools: [],
    }));

    expect(events.at(-1)).toMatchObject({ type: "done", reason: "stop" });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
