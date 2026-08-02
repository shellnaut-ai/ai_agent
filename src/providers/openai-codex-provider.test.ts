import { describe, expect, it } from "vitest";

import { AuthRequiredError } from "../auth/oauth-resolver.js";
import type { OAuthCredential } from "../auth/oauth-contracts.js";
import type { ModelRequest, ModelStreamEvent } from "../core/contracts.js";
import { OpenAICodexProvider } from "./openai-codex-provider.js";

const credential: OAuthCredential = {
  accessToken: "test-access",
  refreshToken: "test-refresh",
  expiresAt: 9_999_999,
  accountId: "account-1",
};

async function collect(stream: AsyncIterable<ModelStreamEvent>): Promise<ModelStreamEvent[]> {
  const events: ModelStreamEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

function sseResponse(chunks: readonly string[]): Response {
  const encoder = new TextEncoder();
  return new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  }), {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

function request(): ModelRequest {
  return {
    model: "gpt-5.1-codex-mini",
    messages: [
      {
        id: "user-1",
        role: "user",
        content: "a.txt를 읽어",
        createdAt: "2026-07-27T00:00:00.000Z",
      },
      {
        id: "assistant-1",
        role: "assistant",
        content: "파일을 확인하겠습니다.",
        toolCalls: [{ id: "call-old", name: "read", argumentsJson: "{\"path\":\"a.txt\"}" }],
        createdAt: "2026-07-27T00:00:01.000Z",
      },
      {
        id: "tool-1",
        role: "tool",
        toolCallId: "call-old",
        toolName: "read",
        ok: true,
        content: "A",
        createdAt: "2026-07-27T00:00:02.000Z",
      },
    ],
    tools: [{
      name: "read",
      description: "작업공간 파일을 읽는다",
      inputSchema: {
        type: "object",
        properties: { path: { type: "string" } },
        required: ["path"],
      },
    }],
  };
}

describe("OpenAICodexProvider", () => {
  it("does not send a model request when the resolver requires login", async () => {
    let fetchCalls = 0;
    const provider = new OpenAICodexProvider({
      resolver: {
        async resolve() {
          throw new AuthRequiredError("missing");
        },
      },
      fetch: async () => {
        fetchCalls += 1;
        throw new Error("network must not be called");
      },
    });

    await expect(collect(provider.stream(request()))).rejects.toMatchObject({
      name: "AuthRequiredError",
      reason: "missing",
    });
    expect(fetchCalls).toBe(0);
  });

  it("serializes Responses input and normalizes text plus function-call SSE events", async () => {
    let captured: Request | undefined;
    const provider = new OpenAICodexProvider({
      resolver: { resolve: async () => credential },
      fetch: async (input, init) => {
        captured = new Request(input, init);
        return sseResponse([
          "event: response.output_text.delta\r\n",
          "data: {\"type\":\"response.output_text.delta\",\"delta\":\"확인\"}\r\n\r\n",
          "data: {\"type\":\"response.output_item.added\",\"output_index\":1,\"item\":{\"type\":\"function_call\",\"call_id\":\"call-1\",\"name\":\"read\",\"arguments\":\"\"}}\n\n",
          "data: {\"type\":\"response.function_call_arguments.delta\",\"output_index\":1,\"delta\":\"{\\\"path\\\":\"}\n\n",
          "data: {\"type\":\"response.function_call_arguments.delta\",\"output_index\":1,\"delta\":\"\\\"b.txt\\\"}\"}\n\n",
          "data: {\"type\":\"response.completed\",\"response\":{\"status\":\"completed\"}}\n\n",
        ]);
      },
      instructions: "도구가 필요하면 호출하세요.",
    });

    await expect(collect(provider.stream(request()))).resolves.toEqual([
      { type: "text_delta", delta: "확인" },
      { type: "tool_call_delta", index: 1, id: "call-1", name: "read" },
      { type: "tool_call_delta", index: 1, argumentsDelta: "{\"path\":" },
      { type: "tool_call_delta", index: 1, argumentsDelta: "\"b.txt\"}" },
      { type: "finish", reason: "tool_calls" },
    ]);

    expect(captured?.url).toBe("https://chatgpt.com/backend-api/codex/responses");
    expect(captured?.headers.get("authorization")).toBe("Bearer test-access");
    expect(captured?.headers.get("chatgpt-account-id")).toBe("account-1");
    expect(captured?.headers.get("originator")).toBe("pi");
    expect(captured?.headers.get("accept")).toBe("text/event-stream");
    expect(captured?.headers.get("openai-beta")).toBe("responses=experimental");
    await expect(captured?.json()).resolves.toEqual({
      model: "gpt-5.1-codex-mini",
      instructions: "도구가 필요하면 호출하세요.",
      input: [
        {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "a.txt를 읽어" }],
        },
        {
          type: "message",
          role: "assistant",
          content: [{
            type: "output_text",
            text: "파일을 확인하겠습니다.",
            annotations: [],
          }],
        },
        {
          type: "function_call",
          call_id: "call-old",
          name: "read",
          arguments: "{\"path\":\"a.txt\"}",
        },
        {
          type: "function_call_output",
          call_id: "call-old",
          output: "A",
        },
      ],
      tools: [{
        type: "function",
        name: "read",
        description: "작업공간 파일을 읽는다",
        parameters: {
          type: "object",
          properties: { path: { type: "string" } },
          required: ["path"],
        },
        strict: false,
      }],
      tool_choice: "auto",
      parallel_tool_calls: true,
      stream: true,
      store: false,
      include: ["reasoning.encrypted_content"],
    });
  });

  it("finishes a text-only response with stop", async () => {
    const provider = new OpenAICodexProvider({
      resolver: { resolve: async () => credential },
      fetch: async () => sseResponse([
        "data: {\"type\":\"response.output_text.delta\",\"delta\":\"안녕\"}\n\n",
        "data: {\"type\":\"response.completed\",\"response\":{\"status\":\"completed\"}}\n\n",
      ]),
    });

    await expect(collect(provider.stream({
      model: "gpt-test",
      messages: [],
      tools: [],
    }))).resolves.toEqual([
      { type: "text_delta", delta: "안녕" },
      { type: "finish", reason: "stop" },
    ]);
  });

  it("replays encrypted reasoning before a text assistant on the next user turn", async () => {
    const capturedBodies: Array<Record<string, unknown>> = [];
    const responses = [
      sseResponse([
        "data: {\"type\":\"response.output_item.done\",\"output_index\":0,\"item\":{\"type\":\"reasoning\",\"id\":\"rs_text\",\"summary\":[],\"encrypted_content\":\"encrypted-text\"}}\n\n",
        "data: {\"type\":\"response.output_text.delta\",\"delta\":\"첫 답변\"}\n\n",
        "data: {\"type\":\"response.completed\",\"response\":{\"status\":\"completed\"}}\n\n",
      ]),
      sseResponse([
        "data: {\"type\":\"response.output_text.delta\",\"delta\":\"둘째 답변\"}\n\n",
        "data: {\"type\":\"response.completed\",\"response\":{\"status\":\"completed\"}}\n\n",
      ]),
    ];
    const provider = new OpenAICodexProvider({
      resolver: { resolve: async () => credential },
      fetch: async (input, init) => {
        const requestValue = new Request(input, init);
        capturedBodies.push(await requestValue.json() as Record<string, unknown>);
        const response = responses.shift();
        if (response === undefined) throw new Error("unexpected request");
        return response;
      },
    });

    await collect(provider.stream({
      model: "gpt-test",
      messages: [{
        id: "user-1",
        role: "user",
        content: "첫 질문",
        createdAt: "now",
      }],
      tools: [],
    }));
    await collect(provider.stream({
      model: "gpt-test",
      messages: [
        {
          id: "user-1",
          role: "user",
          content: "첫 질문",
          createdAt: "now",
        },
        {
          id: "assistant-1",
          role: "assistant",
          content: "첫 답변",
          toolCalls: [],
          createdAt: "now",
        },
        {
          id: "user-2",
          role: "user",
          content: "둘째 질문",
          createdAt: "now",
        },
      ],
      tools: [],
    }));

    expect(capturedBodies[1]?.input).toEqual([
      {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "첫 질문" }],
      },
      {
        type: "reasoning",
        id: "rs_text",
        summary: [],
        encrypted_content: "encrypted-text",
      },
      {
        type: "message",
        role: "assistant",
        content: [{
          type: "output_text",
          text: "첫 답변",
          annotations: [],
        }],
      },
      {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "둘째 질문" }],
      },
    ]);
  });

  it("keeps empty replay turns so identical assistant text preserves order", async () => {
    const capturedBodies: Array<Record<string, unknown>> = [];
    const responses = [
      sseResponse([
        "data: {\"type\":\"response.output_text.delta\",\"delta\":\"OK\"}\n\n",
        "data: {\"type\":\"response.completed\",\"response\":{\"status\":\"completed\"}}\n\n",
      ]),
      sseResponse([
        "data: {\"type\":\"response.output_item.done\",\"output_index\":0,\"item\":{\"type\":\"reasoning\",\"id\":\"rs_second\",\"summary\":[],\"encrypted_content\":\"encrypted-second\"}}\n\n",
        "data: {\"type\":\"response.output_text.delta\",\"delta\":\"OK\"}\n\n",
        "data: {\"type\":\"response.completed\",\"response\":{\"status\":\"completed\"}}\n\n",
      ]),
      sseResponse([
        "data: {\"type\":\"response.output_text.delta\",\"delta\":\"끝\"}\n\n",
        "data: {\"type\":\"response.completed\",\"response\":{\"status\":\"completed\"}}\n\n",
      ]),
    ];
    const provider = new OpenAICodexProvider({
      resolver: { resolve: async () => credential },
      fetch: async (input, init) => {
        const requestValue = new Request(input, init);
        capturedBodies.push(await requestValue.json() as Record<string, unknown>);
        const response = responses.shift();
        if (response === undefined) throw new Error("unexpected request");
        return response;
      },
    });
    const user = (id: string, content: string) => ({
      id,
      role: "user" as const,
      content,
      createdAt: "now",
    });
    const assistant = (id: string) => ({
      id,
      role: "assistant" as const,
      content: "OK",
      toolCalls: [],
      createdAt: "now",
    });

    await collect(provider.stream({
      model: "gpt-test",
      messages: [user("user-1", "첫 질문")],
      tools: [],
    }));
    await collect(provider.stream({
      model: "gpt-test",
      messages: [
        user("user-1", "첫 질문"),
        assistant("assistant-1"),
        user("user-2", "둘째 질문"),
      ],
      tools: [],
    }));
    await collect(provider.stream({
      model: "gpt-test",
      messages: [
        user("user-1", "첫 질문"),
        assistant("assistant-1"),
        user("user-2", "둘째 질문"),
        assistant("assistant-2"),
        user("user-3", "셋째 질문"),
      ],
      tools: [],
    }));

    const thirdInput = capturedBodies[2]?.input as Array<Record<string, unknown>>;
    expect(thirdInput.map((item) => item.type)).toEqual([
      "message",
      "message",
      "message",
      "reasoning",
      "message",
      "message",
    ]);
    expect(thirdInput[3]).toMatchObject({
      id: "rs_second",
      encrypted_content: "encrypted-second",
    });
  });

  it("does not attach new replay to identical text in pre-existing history", async () => {
    const capturedBodies: Array<Record<string, unknown>> = [];
    const responses = [
      sseResponse([
        "data: {\"type\":\"response.output_item.done\",\"output_index\":0,\"item\":{\"type\":\"reasoning\",\"id\":\"rs_new\",\"summary\":[],\"encrypted_content\":\"encrypted-new\"}}\n\n",
        "data: {\"type\":\"response.output_text.delta\",\"delta\":\"OK\"}\n\n",
        "data: {\"type\":\"response.completed\",\"response\":{\"status\":\"completed\"}}\n\n",
      ]),
      sseResponse([
        "data: {\"type\":\"response.output_text.delta\",\"delta\":\"끝\"}\n\n",
        "data: {\"type\":\"response.completed\",\"response\":{\"status\":\"completed\"}}\n\n",
      ]),
    ];
    const provider = new OpenAICodexProvider({
      resolver: { resolve: async () => credential },
      fetch: async (input, init) => {
        const requestValue = new Request(input, init);
        capturedBodies.push(await requestValue.json() as Record<string, unknown>);
        const response = responses.shift();
        if (response === undefined) throw new Error("unexpected request");
        return response;
      },
    });
    const history = [
      {
        id: "user-old",
        role: "user" as const,
        content: "예전 질문",
        createdAt: "now",
      },
      {
        id: "assistant-old",
        role: "assistant" as const,
        content: "OK",
        toolCalls: [],
        createdAt: "now",
      },
      {
        id: "user-new",
        role: "user" as const,
        content: "새 질문",
        createdAt: "now",
      },
    ];

    await collect(provider.stream({
      model: "gpt-test",
      messages: history,
      tools: [],
    }));
    await collect(provider.stream({
      model: "gpt-test",
      messages: [
        ...history,
        {
          id: "assistant-new",
          role: "assistant",
          content: "OK",
          toolCalls: [],
          createdAt: "now",
        },
        {
          id: "user-next",
          role: "user",
          content: "다음 질문",
          createdAt: "now",
        },
      ],
      tools: [],
    }));

    const secondInput = capturedBodies[1]?.input as Array<Record<string, unknown>>;
    expect(secondInput.map((item) => item.type)).toEqual([
      "message",
      "message",
      "message",
      "reasoning",
      "message",
      "message",
    ]);
    expect(secondInput[3]).toMatchObject({ id: "rs_new" });
  });

  it("replays encrypted reasoning and the function item id on the tool-result turn", async () => {
    const capturedBodies: unknown[] = [];
    const responses = [
      sseResponse([
        "data: {\"type\":\"response.output_item.done\",\"output_index\":0,\"item\":{\"type\":\"reasoning\",\"id\":\"rs_1\",\"summary\":[],\"encrypted_content\":\"encrypted-1\"}}\n\n",
        "data: {\"type\":\"response.output_item.added\",\"output_index\":1,\"item\":{\"type\":\"function_call\",\"id\":\"fc_1\",\"call_id\":\"call-1\",\"name\":\"read\",\"arguments\":\"{}\"}}\n\n",
        "data: {\"type\":\"response.completed\",\"response\":{\"status\":\"completed\"}}\n\n",
      ]),
      sseResponse([
        "data: {\"type\":\"response.output_text.delta\",\"delta\":\"완료\"}\n\n",
        "data: {\"type\":\"response.completed\",\"response\":{\"status\":\"completed\"}}\n\n",
      ]),
    ];
    const provider = new OpenAICodexProvider({
      resolver: { resolve: async () => credential },
      fetch: async (input, init) => {
        const requestValue = new Request(input, init);
        capturedBodies.push(await requestValue.json());
        const response = responses.shift();
        if (response === undefined) throw new Error("unexpected request");
        return response;
      },
    });

    await collect(provider.stream({
      model: "gpt-test",
      messages: [{
        id: "user-1",
        role: "user",
        content: "파일을 읽어",
        createdAt: "now",
      }],
      tools: [],
    }));
    await collect(provider.stream({
      model: "gpt-test",
      messages: [
        {
          id: "user-1",
          role: "user",
          content: "파일을 읽어",
          createdAt: "now",
        },
        {
          id: "assistant-1",
          role: "assistant",
          content: "",
          toolCalls: [{ id: "call-1", name: "read", argumentsJson: "{}" }],
          createdAt: "now",
        },
        {
          id: "result-1",
          role: "tool",
          toolCallId: "call-1",
          toolName: "read",
          ok: true,
          content: "A",
          createdAt: "now",
        },
      ],
      tools: [],
    }));

    expect(capturedBodies[1]).toMatchObject({
      input: [
        {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "파일을 읽어" }],
        },
        {
          type: "reasoning",
          id: "rs_1",
          summary: [],
          encrypted_content: "encrypted-1",
        },
        {
          type: "function_call",
          id: "fc_1",
          call_id: "call-1",
          name: "read",
          arguments: "{}",
        },
        {
          type: "function_call_output",
          call_id: "call-1",
          output: "A",
        },
      ],
    });
  });

  it("rejects EOF before a terminal Responses event", async () => {
    const provider = new OpenAICodexProvider({
      resolver: { resolve: async () => credential },
      fetch: async () => sseResponse([
        "data: {\"type\":\"response.output_text.delta\",\"delta\":\"부분 응답\"}\n\n",
      ]),
    });

    await expect(collect(provider.stream(request()))).rejects.toThrow(
      "OpenAI Codex provider stream ended before a terminal event",
    );
  });

  it("rejects malformed events and sanitizes HTTP failures", async () => {
    const malformed = new OpenAICodexProvider({
      resolver: { resolve: async () => credential },
      fetch: async () => sseResponse([
        "data: {\"type\":\"response.output_text.delta\",\"delta\":42}\n\n",
      ]),
    });
    await expect(collect(malformed.stream(request()))).rejects.toThrow(
      "OpenAI Codex provider returned a malformed event",
    );

    const rejected = new OpenAICodexProvider({
      resolver: { resolve: async () => credential },
      fetch: async () => new Response("secret server detail", { status: 401 }),
    });
    const error = await collect(rejected.stream(request())).catch((value: unknown) => value);
    expect(String(error)).toContain("OpenAI Codex provider request failed (401)");
    expect(String(error)).not.toContain("secret server detail");
    expect(String(error)).not.toContain("test-access");
  });

  it("shows a safe model hint for the known ChatGPT unsupported-model error", async () => {
    const provider = new OpenAICodexProvider({
      resolver: { resolve: async () => credential },
      fetch: async () => new Response(JSON.stringify({
        error: {
          type: "invalid_request_error",
          message:
            "The 'gpt-old' model is not supported when using Codex with a ChatGPT account.",
          internal_detail: "must-not-leak",
        },
      }), { status: 400 }),
    });

    const error = await collect(provider.stream({
      model: "gpt-old",
      messages: [],
      tools: [],
    })).catch((value: unknown) => value);

    expect(String(error)).toContain('model "gpt-old" is not supported');
    expect(String(error)).not.toContain("must-not-leak");
    expect(String(error)).not.toContain("test-access");
  });
});
