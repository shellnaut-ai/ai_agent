import { describe, expect, test } from "vitest";

import type { AgentLoopOptions } from "../agent/types.js";
import type { ChatEvent } from "../session/types.js";
import {
  runChat,
  type ChatIO,
  type ChatSessionLike,
} from "./chat.js";

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
});

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
