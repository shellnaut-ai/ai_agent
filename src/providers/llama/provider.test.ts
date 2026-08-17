import { afterEach, describe, expect, test, vi } from "vitest";

import type { ModelRequest, StreamEvent } from "../../model/types.js";
import { LlamaProvider } from "./provider.js";

const baseUrl = "http://127.0.0.1:8080";
const inputTokensUrl = `${baseUrl}/v1/chat/completions/input_tokens`;

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
    serverUrl: baseUrl,
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
      if (captured.url === inputTokensUrl) {
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

    expect(requests[0]?.url).toBe(inputTokensUrl);
    expect(countBody).not.toHaveProperty("stream");
    expect(countBody).toEqual(withoutStream(streamBody));
  });

  test.each([
    ["negative", -1],
    ["fractional", 1.5],
    ["string", "321"],
    ["missing", undefined],
  ])("rejects a %s input_tokens value", async (_caseId, inputTokens) => {
    vi.stubGlobal("fetch", async () => Response.json(
      inputTokens === undefined ? {} : { input_tokens: inputTokens },
    ));

    await expect(createProvider().countInputTokens(request)).rejects.toThrow(
      "invalid input token count",
    );
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
      error: {
        name: "ContextOverflowError",
        message: "llama.cpp context window exceeded.",
      },
    });
  });

  test("maps a structured SSE overflow to a fixed generic error", async () => {
    vi.stubGlobal("fetch", async () => sseResponse([
      {
        error: {
          message:
            "context_length_exceeded Bearer overflow-secret " +
            "access_token=overflow-access",
        },
      },
    ]));

    const events = await collect(createProvider().stream(request));

    expect(events.at(-1)).toMatchObject({
      type: "error",
      error: {
        name: "ContextOverflowError",
        message: "llama.cpp context window exceeded.",
      },
    });
  });

  test("does not classify an unstructured HTTP body as context overflow", async () => {
    vi.stubGlobal("fetch", async () => new Response(
      "proxy debug context_length_exceeded",
      { status: 502 },
    ));

    const events = await collect(createProvider().stream(request));

    expect(events.at(-1)).toMatchObject({
      type: "error",
      error: {
        name: "ModelHttpError",
        status: 502,
        message: "llama.cpp request failed (502)",
      },
    });
  });

  test("keeps an ordinary structured HTTP error non-overflow and sanitized", async () => {
    const secretValues = [
      "bearer-secret",
      "eyJabc.def.ghi",
      "sk-secret-value",
      "opaque-access",
      "opaque-refresh",
      "opaque-cookie",
    ];
    vi.stubGlobal("fetch", async () => Response.json({
      error: {
        message:
          "ordinary\u0000 failure\n" +
          "Bearer bearer-secret eyJabc.def.ghi sk-secret-value " +
          "access_token=opaque-access refresh_token=opaque-refresh " +
          "Cookie: opaque-cookie " +
          "x".repeat(1_000),
        debug: "context_length_exceeded",
      },
      raw: "must-not-appear",
    }, { status: 400 }));

    const events = await collect(createProvider().stream(request));
    const terminal = events.at(-1);
    if (terminal?.type !== "error") {
      throw new Error("Expected a terminal llama.cpp HTTP error.");
    }

    expect(terminal.error).toMatchObject({
      name: "ModelHttpError",
      status: 400,
    });
    expect(terminal.error.message).toContain("ordinary failure");
    expect(terminal.error.message).not.toContain("must-not-appear");
    expect(terminal.error.message).not.toMatch(/[\u0000-\u001f\u007f-\u009f]/u);
    for (const secret of secretValues) {
      expect(terminal.error.message).not.toContain(secret);
    }
    expect(terminal.error.message.length).toBeLessThanOrEqual(340);
  });

  test("sanitizes structured token-endpoint errors without leaking raw fields", async () => {
    vi.stubGlobal("fetch", async () => Response.json({
      error: {
        message:
          "tokenizer offline refresh_token=token-refresh " +
          "Cookie: token-cookie",
      },
      diagnostics: "token-endpoint-private-diagnostics",
    }, { status: 503 }));

    const error = await createProvider().countInputTokens(request).then(
      () => undefined,
      (cause: unknown) => cause,
    );

    expect(error).toMatchObject({
      name: "ModelHttpError",
      status: 503,
      message: expect.stringContaining("tokenizer offline"),
    });
    expect((error as Error).message).not.toMatch(
      /token-refresh|token-cookie|token-endpoint-private-diagnostics/,
    );
  });

  test("sanitizes structured SSE errors without exposing credentials", async () => {
    vi.stubGlobal("fetch", async () => sseResponse([
      {
        error: {
          message:
            "backend\nfailed Bearer stream-secret " +
            "access_token=stream-access Cookie: stream-cookie",
          debug: "sse-private-debug",
        },
      },
    ]));

    const events = await collect(createProvider().stream(request));
    const terminal = events.at(-1);
    if (terminal?.type !== "error") {
      throw new Error("Expected a terminal llama.cpp SSE error.");
    }

    expect(terminal.error).toMatchObject({
      name: "Error",
      message: expect.stringContaining("backend failed"),
    });
    expect(terminal.error.message).not.toMatch(
      /stream-secret|stream-access|stream-cookie|sse-private-debug/,
    );
    expect(terminal.error.message.length).toBeLessThanOrEqual(340);
  });
});
