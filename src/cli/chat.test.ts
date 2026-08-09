import { describe, expect, test } from "vitest";

import type { AgentLoopOptions } from "../agent/types.js";
import type { ChatEvent } from "../session/types.js";
import { runChat } from "./chat.js";

describe("runChat", () => {
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
});
