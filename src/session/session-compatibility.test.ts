import { appendFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import type { Message } from "../model/types.js";
import { JsonlSessionStore } from "./jsonl-store.js";
import { Session } from "./session.js";
import type { LoadedSession, SessionEntry, SessionStore } from "./types.js";

const cleanup: string[] = [];

afterEach(async () => {
  await Promise.all(
    cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

const model = {
  id: "fake-model",
  name: "Fake",
  provider: "fake" as const,
  contextWindow: 4096,
  maxOutputTokens: 1024,
};

describe("session compatibility", () => {
  test("preserves JSON-safe provider state from a version-2 assistant record", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "ai-agent-session-"));
    cleanup.push(rootDir);
    const store = new JsonlSessionStore({
      rootDir,
      sessionId: "provider-state",
      model,
    });
    await store.load();
    await appendFile(
      store.filePath,
      `${JSON.stringify({
        type: "message",
        id: "assistant-1",
        parentId: null,
        timestamp: "2026-08-09T00:00:00.000Z",
        message: {
          role: "assistant",
          content: "I considered the request.",
          toolCalls: [],
          providerState: {
            provider: "openai-codex",
            value: {
              reasoningItems: [{ type: "reasoning", id: "rs_1" }],
              functionItemIds: { "call-1": "fc_1" },
            },
          },
        },
      })}\n`,
      "utf8",
    );

    const loaded = await new JsonlSessionStore({
      rootDir,
      sessionId: "provider-state",
      model,
    }).load();

    expect(loaded.entries).toEqual([
      {
        type: "message",
        id: "assistant-1",
        parentId: null,
        timestamp: "2026-08-09T00:00:00.000Z",
        message: {
          role: "assistant",
          content: "I considered the request.",
          toolCalls: [],
          providerState: {
            provider: "openai-codex",
            value: {
              reasoningItems: [{ type: "reasoning", id: "rs_1" }],
              functionItemIds: { "call-1": "fc_1" },
            },
          },
        },
      },
    ]);
  });

  test("preserves an own __proto__ key in JSON-safe provider state", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "ai-agent-session-"));
    cleanup.push(rootDir);
    const store = new JsonlSessionStore({
      rootDir,
      sessionId: "provider-state-proto-key",
      model,
    });
    await store.load();
    await appendFile(
      store.filePath,
      "{\"type\":\"message\",\"id\":\"assistant-1\",\"parentId\":null,\"timestamp\":\"2026-08-09T00:00:00.000Z\",\"message\":{\"role\":\"assistant\",\"content\":\"I considered the request.\",\"toolCalls\":[],\"providerState\":{\"provider\":\"openai-codex\",\"value\":{\"__proto__\":{\"type\":\"reasoning\",\"id\":\"rs_1\"}}}}}\n",
      "utf8",
    );

    const loaded = await new JsonlSessionStore({
      rootDir,
      sessionId: "provider-state-proto-key",
      model,
    }).load();
    const entry = loaded.entries[0];

    if (
      !entry ||
      entry.type !== "message" ||
      entry.message.role !== "assistant" ||
      !entry.message.providerState
    ) {
      throw new Error("Expected an assistant message with provider state.");
    }

    const value = entry.message.providerState.value;

    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("Expected provider state to be a JSON object.");
    }

    expect(Object.getPrototypeOf(value)).toBe(Object.prototype);
    expect(Object.hasOwn(value, "__proto__")).toBe(true);
    expect(value).toEqual(
      JSON.parse('{"__proto__":{"type":"reasoning","id":"rs_1"}}'),
    );
  });

  test("reloads a version-2 assistant record without provider state", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "ai-agent-session-"));
    cleanup.push(rootDir);
    const store = new JsonlSessionStore({
      rootDir,
      sessionId: "legacy-assistant-message",
      model,
    });
    await store.load();
    await appendFile(
      store.filePath,
      `${JSON.stringify({
        type: "message",
        id: "assistant-1",
        parentId: null,
        timestamp: "2026-08-09T00:00:00.000Z",
        message: {
          role: "assistant",
          content: "I considered the request.",
          toolCalls: [],
        },
      })}\n`,
      "utf8",
    );

    const loaded = await new JsonlSessionStore({
      rootDir,
      sessionId: "legacy-assistant-message",
      model,
    }).load();

    expect(loaded.entries[0]).toMatchObject({
      type: "message",
      message: {
        role: "assistant",
        content: "I considered the request.",
        toolCalls: [],
      },
    });
    expect(
      (loaded.entries[0] as { message: object }).message,
    ).not.toHaveProperty("providerState");
  });

  test("rejects an unsupported provider state provider with its JSONL line number", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "ai-agent-session-"));
    cleanup.push(rootDir);
    const store = new JsonlSessionStore({
      rootDir,
      sessionId: "unsupported-provider-state",
      model,
    });
    await store.load();
    await appendFile(
      store.filePath,
      `${JSON.stringify({
        type: "message",
        id: "assistant-1",
        parentId: null,
        timestamp: "2026-08-09T00:00:00.000Z",
        message: {
          role: "assistant",
          content: "I considered the request.",
          toolCalls: [],
          providerState: {
            provider: "unsupported-provider",
            value: null,
          },
        },
      })}\n`,
      "utf8",
    );

    await expect(
      new JsonlSessionStore({
        rootDir,
        sessionId: "unsupported-provider-state",
        model,
      }).load(),
    ).rejects.toThrow("line 2");
  });

  test("rejects non-finite provider state with its JSONL line number", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "ai-agent-session-"));
    cleanup.push(rootDir);
    const store = new JsonlSessionStore({
      rootDir,
      sessionId: "non-finite-provider-state",
      model,
    });
    await store.load();
    await appendFile(
      store.filePath,
      `${JSON.stringify({
        type: "message",
        id: "assistant-1",
        parentId: null,
        timestamp: "2026-08-09T00:00:00.000Z",
        message: {
          role: "assistant",
          content: "I considered the request.",
          toolCalls: [],
          providerState: {
            provider: "openai-codex",
            value: 0,
          },
        },
      }).replace('"value":0', '"value":1e999')}\n`,
      "utf8",
    );

    await expect(
      new JsonlSessionStore({
        rootDir,
        sessionId: "non-finite-provider-state",
        model,
      }).load(),
    ).rejects.toThrow("line 2");
  });

  test("rejects a structurally invalid JSONL record with its line number", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "ai-agent-session-"));
    cleanup.push(rootDir);
    const store = new JsonlSessionStore({
      rootDir,
      sessionId: "invalid-record",
      model,
    });
    await store.load();
    await appendFile(
      store.filePath,
      `${JSON.stringify({ type: "message", id: 42 })}\n`,
      "utf8",
    );

    await expect(
      new JsonlSessionStore({
        rootDir,
        sessionId: "invalid-record",
        model,
      }).load(),
    ).rejects.toThrow("line 2");
  });

  test("does not expose messages when persistence fails", async () => {
    const store = new FailingSessionStore();
    const session = new Session(store);
    const messages: Message[] = [
      { role: "user", content: "hello" },
      { role: "assistant", content: "hi", toolCalls: [] },
    ];

    await expect(session.appendMessages(messages)).rejects.toThrow(
      "persistence failed",
    );
    expect(session.getMessages()).toEqual([]);
  });

  test("does not advance the journal when single-message persistence fails", async () => {
    const store = new FailingSessionStore();
    const session = new Session(store);

    await expect(
      session.appendMessage({ role: "user", content: "hello" }),
    ).rejects.toThrow("persistence failed");
    expect(store.getLeafId()).toBeNull();
    expect(session.getMessages()).toEqual([]);
  });
});

class FailingSessionStore implements SessionStore {
  readonly sessionId = "failing";
  readonly filePath = "failing.jsonl";

  async load(): Promise<LoadedSession> {
    return { entries: [], leafId: null, approvalKeys: new Set() };
  }

  createEntryId(): string {
    return "entry-1";
  }

  async appendEntry(_entry: SessionEntry): Promise<void> {
    throw new Error("persistence failed");
  }

  async appendEntries(_entries: readonly SessionEntry[]): Promise<void> {
    throw new Error("persistence failed");
  }

  getEntry(_id: string): SessionEntry | undefined {
    return undefined;
  }

  getEntries(): readonly SessionEntry[] {
    return [];
  }

  getLeafId(): string | null {
    return null;
  }

  getPathToRoot(_leafId?: string | null): readonly SessionEntry[] {
    return [];
  }

  async setLeafId(_leafId: string): Promise<void> {
    throw new Error("persistence failed");
  }

  async appendApproval(_key: string): Promise<void> {
    throw new Error("persistence failed");
  }
}
