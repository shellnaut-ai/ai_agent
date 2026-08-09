import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import type { Message, ToolResultMessage } from "../model/types.js";
import { JsonlSessionStore } from "./jsonl-store.js";
import { Session } from "./session.js";
import type {
  LoadedSession,
  SessionEntry,
  SessionStore,
} from "./types.js";

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

  test("clones the input message before passing it to the store", async () => {
    const store = new ReferenceRetainingSessionStore();
    const session = new Session(store);
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

    await session.appendMessage(message);
    const inputArguments = message.toolCalls[0]?.arguments;

    if (
      typeof inputArguments !== "object" ||
      inputArguments === null
    ) {
      throw new Error("Expected tool-call arguments to be an object.");
    }

    (inputArguments as { path: string }).path = "changed.txt";

    expect(store.getMessages()).toEqual([
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
    ]);
  });

  test("returns an entry cloned from the reference retained by the store", async () => {
    const store = new ReferenceRetainingSessionStore();
    const session = new Session(store);

    const returnedEntry = await session.appendMessage({
      role: "assistant",
      content: "",
      toolCalls: [
        {
          id: "call-1",
          name: "read",
          arguments: { path: "notes.txt" },
        },
      ],
    });
    const returnedArguments = returnedEntry.message.role === "assistant"
      ? returnedEntry.message.toolCalls[0]?.arguments
      : undefined;

    if (
      typeof returnedArguments !== "object" ||
      returnedArguments === null
    ) {
      throw new Error("Expected tool-call arguments to be an object.");
    }

    (returnedArguments as { path: string }).path = "changed.txt";

    expect(returnedEntry).not.toBe(store.getEntries()[0]);
    expect(store.getMessages()).toEqual([
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
    ]);
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

  test("rejects duplicate tool call IDs inside one assistant message", async () => {
    const { session } = await createSession("duplicate-tool-call-inline");

    await session.appendMessage({ role: "user", content: "Hello." });

    await expect(
      session.appendMessage({
        role: "assistant",
        content: "",
        toolCalls: [
          {
            id: "call-1",
            name: "read",
            arguments: { path: "a.txt" },
          },
          {
            id: "call-1",
            name: "read",
            arguments: { path: "b.txt" },
          },
        ],
      }),
    ).rejects.toThrow("call-1");
    expect(session.getMessages()).toEqual([
      { role: "user", content: "Hello." },
    ]);
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

  test("resumes after one recovery result persists and the next append fails", async () => {
    const store = new PartiallyFailingRecoveryStore();
    const session = new Session(store);
    await session.appendMessage({ role: "user", content: "Run both." });
    await session.appendMessage({
      role: "assistant",
      content: "",
      toolCalls: [
        { id: "call-2", name: "write", arguments: {} },
        { id: "call-1", name: "read", arguments: {} },
      ],
    });
    store.failSecondRecoveryResultOnce();

    await expect(session.recoverInterruptedToolCalls()).rejects.toThrow(
      "simulated recovery persistence failure",
    );
    expect(
      store.getMessages().filter((message) => message.role === "tool"),
    ).toEqual([
      {
        role: "tool",
        toolCallId: "call-2",
        content: interruptedToolResultContent,
        isError: true,
      },
    ]);

    await expect(session.recoverInterruptedToolCalls()).resolves.toEqual([
      {
        role: "tool",
        toolCallId: "call-1",
        content: interruptedToolResultContent,
        isError: true,
      },
    ]);
    expect(
      store.getMessages().filter((message) => message.role === "tool"),
    ).toEqual([
      {
        role: "tool",
        toolCallId: "call-2",
        content: interruptedToolResultContent,
        isError: true,
      },
      {
        role: "tool",
        toolCallId: "call-1",
        content: interruptedToolResultContent,
        isError: true,
      },
    ]);
    await expect(session.recoverInterruptedToolCalls()).resolves.toEqual([]);
  });
});

class ReferenceRetainingSessionStore implements SessionStore {
  readonly sessionId = "reference-retaining";
  readonly filePath = "reference-retaining.jsonl";

  private readonly entries: SessionEntry[] = [];
  private leafId: string | null = null;
  private nextId = 1;

  async load(): Promise<LoadedSession> {
    return {
      entries: this.entries,
      leafId: this.leafId,
      approvalKeys: new Set(),
    };
  }

  createEntryId(): string {
    const id = `entry-${this.nextId}`;
    this.nextId += 1;
    return id;
  }

  async appendEntry(entry: SessionEntry): Promise<void> {
    if (entry.parentId !== this.leafId) {
      throw new Error("Entry must use the current leaf as its parent.");
    }

    this.entries.push(entry);
    this.leafId = entry.type === "leaf" ? entry.targetId : entry.id;
  }

  async appendEntries(entries: readonly SessionEntry[]): Promise<void> {
    for (const entry of entries) {
      await this.appendEntry(entry);
    }
  }

  getEntry(id: string): SessionEntry | undefined {
    return this.entries.find((entry) => entry.id === id);
  }

  getEntries(): readonly SessionEntry[] {
    return this.entries;
  }

  getLeafId(): string | null {
    return this.leafId;
  }

  getPathToRoot(leafId?: string | null): readonly SessionEntry[] {
    const targetLeafId = leafId === undefined ? this.leafId : leafId;

    if (targetLeafId === null) {
      return [];
    }

    const entriesById = new Map(
      this.entries.map((entry) => [entry.id, entry]),
    );
    const path: SessionEntry[] = [];
    let currentId: string | null = targetLeafId;

    while (currentId !== null) {
      const entry = entriesById.get(currentId);

      if (!entry) {
        throw new Error(`Entry "${currentId}" was not found.`);
      }

      path.push(entry);
      currentId = entry.parentId;
    }

    return path.reverse();
  }

  async setLeafId(_leafId: string): Promise<void> {
    throw new Error("Branching is not supported by this test store.");
  }

  async appendApproval(_key: string): Promise<void> {}

  getMessages(): readonly Message[] {
    return this.getPathToRoot()
      .filter((entry) => entry.type === "message")
      .map((entry) => entry.message);
  }
}

class PartiallyFailingRecoveryStore extends ReferenceRetainingSessionStore {
  private recoveryResultCount = 0;
  private shouldFailSecondRecoveryResult = false;

  failSecondRecoveryResultOnce(): void {
    this.recoveryResultCount = 0;
    this.shouldFailSecondRecoveryResult = true;
  }

  override async appendEntry(entry: SessionEntry): Promise<void> {
    if (
      this.shouldFailSecondRecoveryResult &&
      entry.type === "message" &&
      entry.message.role === "tool" &&
      entry.message.isError
    ) {
      this.recoveryResultCount += 1;

      if (this.recoveryResultCount === 2) {
        this.shouldFailSecondRecoveryResult = false;
        throw new Error("simulated recovery persistence failure");
      }
    }

    await super.appendEntry(entry);
  }
}
