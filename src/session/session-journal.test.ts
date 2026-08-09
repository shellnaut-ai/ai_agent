import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import type { Message, ToolResultMessage } from "../model/types.js";
import { JsonlSessionStore } from "./jsonl-store.js";
import { Session } from "./session.js";

const cleanup: string[] = [];

afterEach(async () => {
  await Promise.all(
    cleanup.splice(0).map((path) =>
      rm(path, { recursive: true, force: true }),
    ),
  );
});

const model = {
  id: "fake-model",
  name: "Fake",
  provider: "fake" as const,
  contextWindow: 4096,
  maxOutputTokens: 1024,
};

const interruptedToolResultContent =
  "Tool execution was interrupted before its result was recorded. " +
  "The outcome is unknown. Inspect workspace state before retrying " +
  "this operation.";

async function createSession(sessionId: string) {
  const rootDir = await mkdtemp(join(tmpdir(), "ai-agent-session-"));
  cleanup.push(rootDir);
  const store = new JsonlSessionStore({ rootDir, sessionId, model });
  await store.load();

  return { rootDir, session: new Session(store), store };
}

async function reloadMessages(rootDir: string, sessionId: string) {
  const reloadedStore = new JsonlSessionStore({
    rootDir,
    sessionId,
    model,
  });
  await reloadedStore.load();

  return new Session(reloadedStore).getMessages();
}

describe("session message journal", () => {
  test("appends user, assistant tool-call, and tool result messages in order", async () => {
    const { rootDir, session } = await createSession("message-order");
    const messages: Message[] = [
      { role: "user", content: "Read the file." },
      {
        role: "assistant",
        content: "",
        toolCalls: [
          {
            id: "call-1",
            name: "read",
            arguments: { path: "notes.txt" },
          },
        ],
      },
      {
        role: "tool",
        toolCallId: "call-1",
        content: "hello",
        isError: false,
      },
    ];

    for (const message of messages) {
      await session.appendMessage(message);
    }

    expect(await reloadMessages(rootDir, "message-order")).toEqual(messages);
  });

  test("returns entries isolated from the input message and stored journal", async () => {
    const { session } = await createSession("message-clone");
    const message: Message = {
      role: "assistant",
      content: "",
      toolCalls: [
        {
          id: "call-1",
          name: "read",
          arguments: { path: "notes.txt" },
        },
      ],
    };

    const entry = await session.appendMessage(message);
    const returnedArguments = entry.message.role === "assistant"
      ? entry.message.toolCalls[0]?.arguments
      : undefined;

    expect(entry.message).not.toBe(message);
    expect(returnedArguments).not.toBe(message.toolCalls[0]?.arguments);

    if (
      typeof returnedArguments !== "object" ||
      returnedArguments === null
    ) {
      throw new Error("Expected tool-call arguments to be an object.");
    }

    (returnedArguments as { path: string }).path = "changed.txt";

    expect(session.getMessages()).toEqual([message]);
  });

  test("rejects a tool result without a pending call on the active branch", async () => {
    const { session } = await createSession("missing-tool-call");

    await session.appendMessage({ role: "user", content: "Hello." });

    await expect(
      session.appendMessage({
        role: "tool",
        toolCallId: "missing-call",
        content: "unexpected",
        isError: false,
      }),
    ).rejects.toThrow("missing-call");
    expect(session.getMessages()).toEqual([
      { role: "user", content: "Hello." },
    ]);
  });

  test("rejects a duplicate assistant tool call ID on the active branch", async () => {
    const { session } = await createSession("duplicate-tool-call");

    await session.appendMessage({ role: "user", content: "Hello." });
    await session.appendMessage({
      role: "assistant",
      content: "",
      toolCalls: [
        { id: "call-1", name: "read", arguments: { path: "a.txt" } },
      ],
    });

    await expect(
      session.appendMessage({
        role: "assistant",
        content: "",
        toolCalls: [
          {
            id: "call-1",
            name: "read",
            arguments: { path: "b.txt" },
          },
        ],
      }),
    ).rejects.toThrow("call-1");
  });

  test("allows the same call ID on a different branch", async () => {
    const { session, store } = await createSession("branched-tool-call");
    const userEntry = await session.appendMessage({
      role: "user",
      content: "Hello.",
    });
    await session.appendMessage({
      role: "assistant",
      content: "",
      toolCalls: [
        { id: "call-1", name: "read", arguments: { path: "a.txt" } },
      ],
    });

    await store.setLeafId(userEntry.id);
    await expect(
      session.appendMessage({
        role: "assistant",
        content: "",
        toolCalls: [
          {
            id: "call-1",
            name: "read",
            arguments: { path: "b.txt" },
          },
        ],
      }),
    ).resolves.toMatchObject({
      type: "message",
      message: {
        role: "assistant",
        toolCalls: [{ id: "call-1" }],
      },
    });
  });
});

describe("interrupted tool-call recovery", () => {
  test("appends one unknown-outcome error for an unmatched call and is idempotent", async () => {
    const { rootDir, session, store } = await createSession(
      "interrupted-call",
    );
    await session.appendMessage({ role: "user", content: "Run both." });
    await session.appendMessage({
      role: "assistant",
      content: "",
      toolCalls: [
        { id: "call-1", name: "read", arguments: { path: "a.txt" } },
        { id: "call-2", name: "write", arguments: { path: "b.txt" } },
      ],
    });
    await session.appendMessage({
      role: "tool",
      toolCallId: "call-1",
      content: "a",
      isError: false,
    });
    const expected: ToolResultMessage = {
      role: "tool",
      toolCallId: "call-2",
      content: interruptedToolResultContent,
      isError: true,
    };

    await expect(session.recoverInterruptedToolCalls()).resolves.toEqual([
      expected,
    ]);
    const entryCountAfterRecovery = store.getEntries().length;

    await expect(session.recoverInterruptedToolCalls()).resolves.toEqual([]);
    expect(store.getEntries()).toHaveLength(entryCountAfterRecovery);
    expect(await reloadMessages(rootDir, "interrupted-call")).toEqual([
      { role: "user", content: "Run both." },
      {
        role: "assistant",
        content: "",
        toolCalls: [
          {
            id: "call-1",
            name: "read",
            arguments: { path: "a.txt" },
          },
          {
            id: "call-2",
            name: "write",
            arguments: { path: "b.txt" },
          },
        ],
      },
      {
        role: "tool",
        toolCallId: "call-1",
        content: "a",
        isError: false,
      },
      expected,
    ]);
  });

  test("recovers unmatched calls in assistant source order", async () => {
    const { session } = await createSession("interrupted-call-order");
    await session.appendMessage({ role: "user", content: "Run both." });
    await session.appendMessage({
      role: "assistant",
      content: "",
      toolCalls: [
        { id: "call-2", name: "write", arguments: {} },
        { id: "call-1", name: "read", arguments: {} },
      ],
    });

    const recovered = await session.recoverInterruptedToolCalls();

    expect(recovered.map((message) => message.toolCallId)).toEqual([
      "call-2",
      "call-1",
    ]);
  });
});
