import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { OAuthCredential } from "../auth/oauth-contracts.js";
import { createAgentRuntime } from "./runtime.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { force: true, recursive: true })),
  );
});

describe("direct Codex Agent runtime", () => {
  it("executes read, reinjects its result, and makes exactly one follow-up request", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "pi-clone-runtime-"));
    temporaryDirectories.push(workspace);
    await writeFile(join(workspace, "a.txt"), "A", "utf8");
    const sessionPath = join(workspace, "sessions", "session.jsonl");
    const requests: Request[] = [];
    const responses = [
      sseResponse([
        event({
          type: "response.output_item.added",
          output_index: 0,
          item: { type: "function_call", call_id: "call-1", name: "read", arguments: "" },
        }),
        event({
          type: "response.function_call_arguments.delta",
          output_index: 0,
          delta: "{\"path\":\"a.txt\"}",
        }),
        event({ type: "response.completed", response: { status: "completed" } }),
      ]),
      sseResponse([
        event({ type: "response.output_text.delta", delta: "파일 내용은 A입니다." }),
        event({ type: "response.completed", response: { status: "completed" } }),
      ]),
    ];
    const credential: OAuthCredential = {
      accessToken: "access",
      refreshToken: "refresh",
      expiresAt: 10_000,
      accountId: "account-1",
    };
    const agent = await createAgentRuntime({
      workspace,
      sessionPath,
      sessionId: "session-1",
      model: "gpt-test",
      resolver: { resolve: async () => credential },
      fetch: async (input, init) => {
        requests.push(new Request(input, init));
        const response = responses.shift();
        if (response === undefined) throw new Error("unexpected provider turn");
        return response;
      },
      createMessageId: (() => {
        const ids = ["user-1", "assistant-1", "assistant-2"];
        return () => ids.shift() ?? "unexpected";
      })(),
      createToolResultId: () => "tool-result-1",
      now: () => "2026-07-27T00:00:00.000Z",
    });

    const messages = await agent.prompt("a.txt를 읽어");

    expect(requests).toHaveLength(2);
    expect(messages.map((message) => message.role)).toEqual([
      "user",
      "assistant",
      "tool",
      "assistant",
    ]);
    expect(messages.at(-1)).toMatchObject({ content: "파일 내용은 A입니다." });
    const firstBody = await requests[0]?.json() as {
      tools?: Array<{ name?: string }>;
    };
    expect(firstBody.tools?.map((tool) => tool.name)).toEqual([
      "read",
      "write",
      "edit",
      "bash",
    ]);
    const secondBody = await requests[1]?.json() as { input?: unknown[] };
    expect(secondBody.input).toContainEqual({
      type: "function_call_output",
      call_id: "call-1",
      output: "A",
    });
    expect((await readFile(sessionPath, "utf8")).trim().split("\n")).toHaveLength(6);
  });

  it("executes write, edit, and read sequentially before exactly one provider follow-up", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "pi-clone-runtime-batch-"));
    temporaryDirectories.push(workspace);
    const sessionPath = join(workspace, "sessions", "session.jsonl");
    const requests: Request[] = [];
    const responses = [
      sseResponse([
        toolCallAdded(0, "call-write", "write"),
        toolArguments(0, { path: "notes.txt", content: "before" }),
        toolCallAdded(1, "call-edit", "edit"),
        toolArguments(1, { path: "notes.txt", oldText: "before", newText: "after" }),
        toolCallAdded(2, "call-read", "read"),
        toolArguments(2, { path: "notes.txt" }),
        event({ type: "response.completed", response: { status: "completed" } }),
      ]),
      sseResponse([
        event({ type: "response.output_text.delta", delta: "파일을 만들고 수정했습니다." }),
        event({ type: "response.completed", response: { status: "completed" } }),
      ]),
    ];
    const credential: OAuthCredential = {
      accessToken: "access",
      refreshToken: "refresh",
      expiresAt: 10_000,
      accountId: "account-1",
    };
    const resultIds = ["result-write", "result-edit", "result-read"];
    const agent = await createAgentRuntime({
      workspace,
      sessionPath,
      sessionId: "session-batch",
      model: "gpt-test",
      resolver: { resolve: async () => credential },
      fetch: async (input, init) => {
        requests.push(new Request(input, init));
        const response = responses.shift();
        if (response === undefined) throw new Error("unexpected provider turn");
        return response;
      },
      createMessageId: (() => {
        const ids = ["user-1", "assistant-1", "assistant-2"];
        return () => ids.shift() ?? "unexpected";
      })(),
      createToolResultId: () => resultIds.shift() ?? "unexpected-result",
      now: () => "2026-07-27T00:00:00.000Z",
    });

    const messages = await agent.prompt("notes.txt를 만들고 before를 after로 바꾼 뒤 읽어");

    expect(requests).toHaveLength(2);
    expect(messages.filter((message) => message.role === "tool").map((message) => message.toolName))
      .toEqual(["write", "edit", "read"]);
    await expect(readFile(join(workspace, "notes.txt"), "utf8")).resolves.toBe("after");
    const secondBody = await requests[1]?.json() as {
      input?: Array<Record<string, unknown>>;
    };
    expect(secondBody.input?.filter((item) => item.type === "function_call_output")).toEqual([
      {
        type: "function_call_output",
        call_id: "call-write",
        output: "Wrote 6 bytes to notes.txt",
      },
      {
        type: "function_call_output",
        call_id: "call-edit",
        output: "Edited notes.txt",
      },
      {
        type: "function_call_output",
        call_id: "call-read",
        output: "after",
      },
    ]);
    expect(messages.at(-1)).toMatchObject({ content: "파일을 만들고 수정했습니다." });
  });
});

function event(value: unknown): string {
  return `data: ${JSON.stringify(value)}\n\n`;
}

function toolCallAdded(index: number, callId: string, name: string): string {
  return event({
    type: "response.output_item.added",
    output_index: index,
    item: { type: "function_call", call_id: callId, name, arguments: "" },
  });
}

function toolArguments(index: number, argumentsValue: Record<string, string>): string {
  return event({
    type: "response.function_call_arguments.delta",
    output_index: index,
    delta: JSON.stringify(argumentsValue),
  });
}

function sseResponse(chunks: readonly string[]): Response {
  const encoder = new TextEncoder();
  return new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  }), { status: 200 });
}
