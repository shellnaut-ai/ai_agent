import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Type } from "typebox";
import { afterEach, describe, expect, test, vi } from "vitest";

import { AgentLoop } from "../agent/loop.js";
import type { ModelStreamRunner } from "../model/runtime.js";
import type { JsonValue, StreamEvent } from "../model/types.js";
import { ToolRegistry } from "../tools/registry.js";
import type { Tool } from "../tools/types.js";
import { ChatSession } from "./chat-session.js";
import { JsonlSessionStore } from "./jsonl-store.js";
import { Session } from "./session.js";

const fileIo = vi.hoisted(() => ({
  appendAttempts: 0,
  failAt: undefined as number | undefined,
  truncateFails: false,
  waitAt: undefined as number | undefined,
  announceAppend: undefined as (() => void) | undefined,
  waitForRelease: undefined as Promise<void> | undefined,
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  const appendFile = actual.appendFile as unknown as (
    ...args: unknown[]
  ) => Promise<void>;
  const truncate = actual.truncate as unknown as (
    ...args: unknown[]
  ) => Promise<void>;

  return {
    ...actual,
    async appendFile(...args: unknown[]): Promise<void> {
      fileIo.appendAttempts += 1;
      const attempt = fileIo.appendAttempts;

      if (fileIo.waitAt === attempt) {
        fileIo.announceAppend?.();
        await fileIo.waitForRelease;
      }

      if (fileIo.failAt === attempt) {
        const data = args[1];

        if (typeof data !== "string") {
          throw new Error("Expected the JSONL append to use string data.");
        }

        const partialArgs = [...args];
        partialArgs[1] = data.slice(0, Math.max(1, Math.floor(data.length / 2)));
        await appendFile(...partialArgs);
        throw new Error("simulated partial append failure");
      }

      await appendFile(...args);
    },
    async truncate(...args: unknown[]): Promise<void> {
      if (fileIo.truncateFails) {
        throw new Error("simulated rollback failure");
      }

      await truncate(...args);
    },
  };
});

const cleanup: string[] = [];
const model = {
  id: "fake-model",
  name: "Fake",
  provider: "fake" as const,
  contextWindow: 4096,
  maxOutputTokens: 1024,
};

afterEach(async () => {
  fileIo.appendAttempts = 0;
  fileIo.failAt = undefined;
  fileIo.truncateFails = false;
  fileIo.waitAt = undefined;
  fileIo.announceAppend = undefined;
  fileIo.waitForRelease = undefined;
  await Promise.all(
    cleanup.splice(0).map((path) =>
      rm(path, { recursive: true, force: true }),
    ),
  );
});

async function createStores(sessionId: string): Promise<{
  rootDir: string;
  first: JsonlSessionStore;
  second: JsonlSessionStore;
}> {
  const rootDir = await mkdtemp(join(tmpdir(), "ai-agent-jsonl-store-"));
  cleanup.push(rootDir);
  const first = new JsonlSessionStore({ rootDir, sessionId, model });
  await first.load();
  const second = new JsonlSessionStore({ rootDir, sessionId, model });
  await second.load();
  fileIo.appendAttempts = 0;
  return { rootDir, first, second };
}

async function collect<T>(stream: AsyncIterable<T>): Promise<T[]> {
  const values: T[] = [];

  for await (const value of stream) {
    values.push(value);
  }

  return values;
}

describe("JSONL store consistency", () => {
  test("rolls a rejected partial append back to the committed EOF", async () => {
    const { rootDir, first } = await createStores("partial-rollback");
    const before = await readFile(first.filePath, "utf8");
    fileIo.failAt = 1;

    await expect(
      new Session(first).appendMessage({ role: "user", content: "lost" }),
    ).rejects.toThrow("simulated partial append failure");

    expect(await readFile(first.filePath, "utf8")).toBe(before);
    fileIo.failAt = undefined;
    await new Session(first).appendMessage({
      role: "user",
      content: "durable",
    });

    const reloaded = new JsonlSessionStore({
      rootDir,
      sessionId: "partial-rollback",
      model,
    });
    await reloaded.load();
    expect(new Session(reloaded).getMessages()).toEqual([
      { role: "user", content: "durable" },
    ]);
  });

  test("poisons the store when partial-append rollback fails", async () => {
    const { first } = await createStores("rollback-poison");
    fileIo.failAt = 1;
    fileIo.truncateFails = true;

    await expect(
      new Session(first).appendMessage({ role: "user", content: "lost" }),
    ).rejects.toThrow(/poisoned/i);
    const poisonedBytes = await readFile(first.filePath, "utf8");
    fileIo.failAt = undefined;
    fileIo.truncateFails = false;

    await expect(
      new Session(first).appendMessage({ role: "user", content: "blocked" }),
    ).rejects.toThrow(/poisoned/i);
    expect(await readFile(first.filePath, "utf8")).toBe(poisonedBytes);
  });

  test("fences writes that were queued before rollback poisoned the store", async () => {
    const { first } = await createStores("queued-poison");
    let announceFirst: (() => void) | undefined;
    let releaseFirst: (() => void) | undefined;
    const firstEntered = new Promise<void>((resolve) => {
      announceFirst = resolve;
    });
    const firstMayFinish = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    fileIo.waitAt = 1;
    fileIo.failAt = 1;
    fileIo.truncateFails = true;
    fileIo.announceAppend = announceFirst;
    fileIo.waitForRelease = firstMayFinish;
    const session = new Session(first);
    const firstAppend = session.appendMessage({ role: "user", content: "first" });
    const firstFailure = firstAppend.then(
      () => undefined,
      (error: unknown) => error,
    );
    await firstEntered;
    const queuedAppend = session.appendMessage({ role: "user", content: "second" });
    const queuedFailure = queuedAppend.then(
      () => undefined,
      (error: unknown) => error,
    );
    releaseFirst?.();

    expect(await firstFailure).toMatchObject({ message: expect.stringMatching(/poisoned/i) });
    expect(await queuedFailure).toMatchObject({ message: expect.stringMatching(/poisoned/i) });
    expect(fileIo.appendAttempts).toBe(1);
  });

  test("rolls a partial multi-entry append back to the exact prior bytes", async () => {
    const { first } = await createStores("batch-rollback");
    const before = await readFile(first.filePath, "utf8");
    fileIo.failAt = 1;

    await expect(
      new Session(first).appendMessages([
        { role: "user", content: "first batch record" },
        { role: "assistant", content: "second batch record", toolCalls: [] },
      ]),
    ).rejects.toThrow("simulated partial append failure");
    expect(await readFile(first.filePath, "utf8")).toBe(before);
  });

  test("rolls a rejected partial approval append back to the committed EOF", async () => {
    const { first } = await createStores("approval-rollback");
    const before = await readFile(first.filePath, "utf8");
    fileIo.failAt = 1;

    await expect(first.appendApproval("approval-key")).rejects.toThrow(
      "simulated partial append failure",
    );
    expect(await readFile(first.filePath, "utf8")).toBe(before);
  });

  test("rejects undefined tool arguments before changing durable bytes", async () => {
    const { first } = await createStores("undefined-tool-arguments");
    const before = await readFile(first.filePath, "utf8");

    await expect(new Session(first).appendMessage({
      role: "assistant",
      content: "",
      toolCalls: [{
        id: "call-undefined",
        name: "read",
        arguments: undefined,
      }],
    })).rejects.toThrow("Invalid ToolCall in session file.");

    expect(await readFile(first.filePath, "utf8")).toBe(before);
  });

  test("a poisoned checkpoint prevents tool side effects and later provider calls", async () => {
    const { first } = await createStores("poison-side-effect-gate");
    let providerCalls = 0;
    let toolExecutions = 0;
    const runner: ModelStreamRunner = {
      async *stream(): AsyncIterable<StreamEvent> {
        providerCalls += 1;
        yield { type: "start" };
        yield {
          type: "tool-call",
          toolCall: { id: "call-1", name: "mutate", arguments: {} },
        };
        yield { type: "done", reason: "tool-call" };
      },
    };
    const tool: Tool = {
      approval: "never",
      definition: {
        name: "mutate",
        description: "Mutates observable test state.",
        inputSchema: Type.Object({}, { additionalProperties: false }),
      },
      async execute() {
        toolExecutions += 1;
        return { content: "mutated", isError: false };
      },
    };
    const registry = new ToolRegistry();
    registry.register(tool);
    const chat = new ChatSession(
      new AgentLoop(runner, registry),
      model,
      { session: new Session(first) },
    );
    fileIo.failAt = 2;
    fileIo.truncateFails = true;

    const firstTurn = await collect(chat.streamTurn("run it"));
    expect(firstTurn.at(-1)).toMatchObject({ type: "error" });
    expect(toolExecutions).toBe(0);
    expect(providerCalls).toBe(1);

    fileIo.failAt = undefined;
    fileIo.truncateFails = false;
    const secondTurn = await collect(chat.streamTurn("try again"));
    expect(secondTurn.at(-1)).toMatchObject({ type: "error" });
    expect(toolExecutions).toBe(0);
    expect(providerCalls).toBe(1);
  });

  test("re-reads the current leaf under the writer lock", async () => {
    const { first, second } = await createStores("stale-leaf");
    await new Session(first).appendMessage({ role: "user", content: "first" });

    await expect(
      new Session(second).appendMessage({ role: "user", content: "stale" }),
    ).rejects.toThrow(/current leaf/i);
  });

  test("serializes store instances and releases the lock after append failure", async () => {
    const { first, second } = await createStores("lock-release");
    let announceFirst: (() => void) | undefined;
    let releaseFirst: (() => void) | undefined;
    const firstEntered = new Promise<void>((resolve) => {
      announceFirst = resolve;
    });
    const firstMayFinish = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    fileIo.waitAt = 1;
    fileIo.failAt = 1;
    fileIo.announceAppend = announceFirst;
    fileIo.waitForRelease = firstMayFinish;
    const firstAppend = new Session(first).appendMessage({
      role: "user",
      content: "fails",
    });
    const firstFailure = firstAppend.then(
      () => undefined,
      (error: unknown) => error,
    );
    await firstEntered;
    const secondAppend = new Session(second).appendMessage({
      role: "user",
      content: "wins after release",
    });

    try {
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(fileIo.appendAttempts).toBe(1);
    } finally {
      releaseFirst?.();
    }

    expect(await firstFailure).toMatchObject({
      message: "simulated partial append failure",
    });
    await expect(secondAppend).resolves.toBeDefined();
  });

  test("rejects sparse provider-state arrays before committing them", async () => {
    const { first } = await createStores("sparse-provider-state");
    const sparse: JsonValue[] = [];
    sparse.length = 1;

    await expect(
      new Session(first).appendMessage({
        role: "assistant",
        content: "",
        toolCalls: [],
        providerState: {
          provider: "openai-codex",
          value: sparse,
        },
      }),
    ).rejects.toThrow(/sparse/i);
  });
});
