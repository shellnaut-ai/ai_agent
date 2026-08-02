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
