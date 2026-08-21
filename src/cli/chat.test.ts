import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import { AgentLoop } from "../agent/loop.js";
import type { AgentLoopOptions } from "../agent/types.js";
import { ContextBudgetCalculator } from "../context/budget.js";
import { CompactionService } from "../context/compaction.js";
import { TokenEstimator } from "../context/token-estimator.js";
import type { ModelStreamRunner } from "../model/runtime.js";
import type { StreamEvent } from "../model/types.js";
import { ChatSession } from "../session/chat-session.js";
import { JsonlSessionStore } from "../session/jsonl-store.js";
import { SessionContextCoordinator } from "../session/session-context-coordinator.js";
import { Session } from "../session/session.js";
import type { ChatEvent } from "../session/types.js";
import { ToolRegistry } from "../tools/registry.js";
import {
  runChat,
  type ChatIO,
  type ChatSessionLike,
} from "./chat.js";

const cleanup: string[] = [];

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((path) =>
    rm(path, { recursive: true, force: true })
  ));
});

describe("runChat", () => {
  test("prompts to abandon a non-resumable partial before reading a new turn", async () => {
    const output: string[] = [];
    const prompts: string[] = [];
    let abandoned = 0;
    let pending = true;
    const inputs = ["a", "/exit"];
    const io = {
      async question(prompt: string): Promise<string | undefined> {
        prompts.push(prompt);
        return inputs.shift();
      },
      write(content: string): void { output.push(content); },
      writeError(content: string): void { output.push(content); },
      onEscape(): () => void { return () => undefined; },
      onInterrupt(): () => void { return () => undefined; },
    };
    const session: ChatSessionLike = {
      getPendingContinuation() {
        return pending ? {
          logicalMessageId: "logical",
          segmentIndex: 0,
          status: "partial",
          resumeAllowed: false,
          tailHash: "a".repeat(64),
          estimatedTotalOutputTokens: 2,
        } : undefined;
      },
      async abandonPendingContinuation() {
        abandoned += 1;
        pending = false;
      },
      async *streamTurn(): AsyncIterable<ChatEvent> {
        throw new Error("must not start a turn");
      },
    };

    await runChat(session, io);

    expect(abandoned).toBe(1);
    expect(prompts[0]).toMatch(/resume is unsafe/i);
    expect(output.join("")).toMatch(/continuation abandoned/i);
  });

  test("prints a partial recovery warning before its persistence error", async () => {
    const output: string[] = [];
    const errors: string[] = [];
    const inputs = ["continue", "/exit"];
    const io = {
      async question(): Promise<string | undefined> {
        return inputs.shift();
      },
      write(content: string): void {
        output.push(content);
      },
      writeError(content: string): void {
        errors.push(content);
      },
      onEscape(): () => void {
        return () => undefined;
      },
      onInterrupt(): () => void {
        return () => undefined;
      },
    };
    const session = {
      async *streamTurn(): AsyncIterable<ChatEvent> {
        yield {
          type: "session-recovery",
          recoveredToolCallIds: ["call-1"],
        };
        yield {
          type: "error",
          reason: "error",
          error: new Error("second recovery append failed"),
        };
      },
    };

    await runChat(session, io);

    expect(output.join("").match(/call-1 outcome is unknown/g))
      .toHaveLength(1);
    expect(errors.join("")).toContain("second recovery append failed");
  });

  test("reports each recovered tool call as an unknown outcome", async () => {
    const output: string[] = [];
    const inputs = ["continue", "/exit"];
    const io = {
      async question(): Promise<string | undefined> {
        return inputs.shift();
      },
      write(content: string): void {
        output.push(content);
      },
      writeError(content: string): void {
        output.push(content);
      },
      onEscape(): () => void {
        return () => undefined;
      },
      onInterrupt(): () => void {
        return () => undefined;
      },
    };
    const session = {
      async *streamTurn(): AsyncIterable<ChatEvent> {
        yield {
          type: "session-recovery",
          recoveredToolCallIds: ["call-1", "call-2"],
        };
        yield { type: "done", reason: "stop", newMessages: [] };
      },
    };

    await runChat(session, io);

    expect(output.join("")).toContain("call-1");
    expect(output.join("")).toContain("call-2");
    expect(output.join("").match(/outcome is unknown/g)).toHaveLength(2);
  });

  test("routes Ctrl+C to the active turn abort signal", async () => {
    const output: string[] = [];
    const inputs = ["hello", "/exit"];
    let interrupt: (() => void) | undefined;
    const io = {
      async question(): Promise<string | undefined> {
        return inputs.shift();
      },
      write(content: string): void {
        output.push(content);
      },
      writeError(content: string): void {
        output.push(content);
      },
      onEscape(): () => void {
        return () => undefined;
      },
      onInterrupt(listener: () => void): () => void {
        interrupt = listener;
        return () => {
          interrupt = undefined;
        };
      },
    };
    const session = {
      async *streamTurn(
        _content: string,
        options?: AgentLoopOptions,
      ): AsyncIterable<ChatEvent> {
        interrupt?.();
        expect(options?.signal?.aborted).toBe(true);
        yield {
          type: "error",
          reason: "aborted",
          error: new Error("aborted"),
        };
      },
    };

    await runChat(session, io);

    expect(output.join("")).toContain("Cancelling current turn");
    expect(output.join("")).toContain("Turn cancelled");
  });

  test("routes Escape to a resumed continuation abort signal", async () => {
    const output: string[] = [];
    const inputs = ["r", "/exit"];
    let pending = true;
    let escape: (() => void) | undefined;
    const io = {
      async question(): Promise<string | undefined> {
        return inputs.shift();
      },
      write(content: string): void { output.push(content); },
      writeError(content: string): void { output.push(content); },
      onEscape(listener: () => void): () => void {
        escape = listener;
        return () => { escape = undefined; };
      },
      onInterrupt(): () => void { return () => undefined; },
    };
    const session: ChatSessionLike = {
      getPendingContinuation() {
        return pending ? {
          logicalMessageId: "logical",
          segmentIndex: 0,
          status: "partial",
          resumeAllowed: true,
          tailHash: "a".repeat(64),
          estimatedTotalOutputTokens: 2,
        } : undefined;
      },
      async *streamContinuation(options): AsyncIterable<ChatEvent> {
        pending = false;
        escape?.();
        expect(options?.signal?.aborted).toBe(true);
        yield { type: "error", reason: "aborted", error: new Error("aborted") };
      },
      async *streamTurn(): AsyncIterable<ChatEvent> {
        throw new Error("must not start a turn");
      },
    };

    await runChat(session, io);

    expect(output.join("")).toContain("Cancelling current turn");
    expect(output.join("")).toContain("Turn cancelled");
  });

  test("routes /compact without appending a user turn", async () => {
    const calls: string[] = [];
    const session: ChatSessionLike = {
      async *streamTurn(content): AsyncIterable<ChatEvent> {
        calls.push(`turn:${content}`);
      },
      async *streamCompaction(): AsyncIterable<ChatEvent> {
        calls.push("compact");
        yield {
          type: "compaction-start",
          reason: "manual",
          tokensBefore: 200,
        };
        yield {
          type: "compaction-done",
          reason: "manual",
          tokensBefore: 200,
          tokensAfter: 80,
        };
      },
    };

    await runChat(session, scriptedIo(["/compact", "/exit"]));

    expect(calls).toEqual(["compact"]);
  });

  test("renders manual compaction events from the real session stack", async () => {
    let summaryCalls = 0;
    const fixture = await createRealCompactionFixture(
      "cli-real-manual-compaction",
      {
        async *stream(): AsyncIterable<StreamEvent> {
          summaryCalls += 1;
          yield { type: "text-delta", delta: "CLI compact summary" };
          yield { type: "done", reason: "stop" };
        },
      },
    );
    const output: string[] = [];
    const io = capturingIo(["/compact", "/exit"], output);

    await runChat(fixture.chat, io);

    expect(summaryCalls).toBe(1);
    expect(fixture.getAgentCalls()).toBe(0);
    expect(output.join("")).toMatch(
      /\[Compaction: manual\] Summarizing \d+ tokens/,
    );
    expect(output.join("")).toMatch(
      /\[Compaction: manual\] Context reduced from \d+ to \d+ tokens/,
    );
    expect(fixture.store.getEntries()).toContainEqual(
      expect.objectContaining({ type: "compaction" }),
    );
    expect(fixture.session.getMessages()).not.toContainEqual({
      role: "user",
      content: "/compact",
    });
  });

  test("aborts /compact before model or journal side effects", async () => {
    let summaryCalls = 0;
    const fixture = await createRealCompactionFixture(
      "cli-real-compact-abort",
      {
        async *stream(): AsyncIterable<StreamEvent> {
          summaryCalls += 1;
          throw new Error("Summary model must not run after early abort.");
        },
      },
    );
    const output: string[] = [];
    const remaining = ["/compact", "/exit"];
    let escapeRegistered = false;
    const io: ChatIO = {
      async question(): Promise<string | undefined> {
        return remaining.shift();
      },
      write(content): void {
        output.push(content);
      },
      writeError(content): void {
        output.push(content);
      },
      onEscape(listener): () => void {
        escapeRegistered = true;
        listener();
        return () => undefined;
      },
      onInterrupt(): () => void {
        return () => undefined;
      },
    };

    await runChat(fixture.chat, io);

    expect(escapeRegistered).toBe(true);
    expect(summaryCalls).toBe(0);
    expect(fixture.getAgentCalls()).toBe(0);
    expect(fixture.store.getEntries().some((entry) => entry.type === "compaction"))
      .toBe(false);
    expect(output.join("")).toContain("Cancelling compaction");
    expect(output.join("")).toContain("Compaction cancelled");
  });
});

async function createRealCompactionFixture(
  sessionId: string,
  summaryRunner: ModelStreamRunner,
): Promise<{
  chat: ChatSession;
  session: Session;
  store: JsonlSessionStore;
  getAgentCalls(): number;
}> {
  const rootDir = await mkdtemp(join(tmpdir(), "ai-agent-cli-compaction-"));
  cleanup.push(rootDir);
  const model = {
    id: "fake-model",
    name: "Fake",
    provider: "fake" as const,
    contextWindow: 4_000,
    maxOutputTokens: 100,
  };
  const store = new JsonlSessionStore({ rootDir, sessionId, model });
  await store.load();
  const session = new Session(store);
  for (let index = 0; index < 2; index += 1) {
    await session.appendMessages([
      { role: "user", content: `small question ${index}` },
      { role: "assistant", content: `small answer ${index}`, toolCalls: [] },
    ]);
  }
  const compaction = new CompactionService(summaryRunner, {
    reserveTokens: 100,
    keepRecentTokens: 10_000,
    charsPerToken: 1,
    maxSummaryOutputTokens: 100,
    toolResultMaxChars: 100,
  });
  const coordinator = new SessionContextCoordinator(
    session,
    compaction,
    new ContextBudgetCalculator(new TokenEstimator(1)),
  );
  let agentCalls = 0;
  const agentRunner: ModelStreamRunner = {
    async *stream(): AsyncIterable<StreamEvent> {
      agentCalls += 1;
      throw new Error("Agent model must not run for /compact.");
    },
  };

  return {
    chat: new ChatSession(
      new AgentLoop(agentRunner, new ToolRegistry()),
      model,
      { session, contextCoordinator: coordinator },
    ),
    session,
    store,
    getAgentCalls: () => agentCalls,
  };
}

function capturingIo(inputs: string[], output: string[]): ChatIO {
  const remaining = [...inputs];

  return {
    async question(): Promise<string | undefined> {
      return remaining.shift();
    },
    write(content): void {
      output.push(content);
    },
    writeError(content): void {
      output.push(content);
    },
    onEscape(): () => void {
      return () => undefined;
    },
    onInterrupt(): () => void {
      return () => undefined;
    },
  };
}

function scriptedIo(inputs: string[]): ChatIO {
  const remaining = [...inputs];

  return {
    async question(): Promise<string | undefined> {
      return remaining.shift();
    },
    write(): void {},
    writeError(): void {},
    onEscape(): () => void {
      return () => undefined;
    },
    onInterrupt(): () => void {
      return () => undefined;
    },
  };
}
