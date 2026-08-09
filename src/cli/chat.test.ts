import { describe, expect, test } from "vitest";

import type { AgentLoopOptions } from "../agent/types.js";
import type { ChatEvent } from "../session/types.js";
import { runChat } from "./chat.js";

describe("runChat", () => {
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
