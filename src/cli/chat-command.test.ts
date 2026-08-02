import { describe, expect, it } from "vitest";

import { AuthRequiredError } from "../auth/oauth-resolver.js";
import type { AgentEvent, AgentEventListener, Message } from "../core/contracts.js";
import {
  runChatCommand,
  type ChatAgent,
  type ChatCommandDependencies,
  type ChatIo,
} from "./chat-command.js";

describe("chat CLI command", () => {
  it("prints the login command when the Provider requires authentication", async () => {
    const output: string[] = [];
    const deps = dependencies(["안녕"], output, {
      subscribe: () => () => undefined,
      async prompt() {
        throw new AuthRequiredError("missing");
      },
    });

    await expect(runChatCommand(["chat"], deps)).resolves.toBe(true);

    expect(output.join("")).toContain("로그인이 필요합니다");
    expect(output.join("")).toContain("npm run cli -- login");
  });

  it("streams Agent events and keeps prompting until the user exits", async () => {
    const output: string[] = [];
    const listeners = new Set<AgentEventListener>();
    const prompts: string[] = [];
    const agent: ChatAgent = {
      subscribe(listener) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      async prompt(content) {
        prompts.push(content);
        for (const listener of listeners) {
          listener({ type: "text_delta", messageId: "assistant-1", delta: "응답" });
        }
        return [] as readonly Message[];
      },
    };
    const deps = dependencies(["질문", "/exit"], output, agent);

    await expect(runChatCommand(["chat"], deps)).resolves.toBe(true);

    expect(prompts).toEqual(["질문"]);
    expect(output.join("")).toContain("응답");
    expect(output.join("")).toContain("대화를 종료합니다");
    expect(listeners.size).toBe(0);
  });
});

function dependencies(
  inputs: string[],
  output: string[],
  agent: ChatAgent,
): ChatCommandDependencies {
  const io: ChatIo = {
    write(line) {
      output.push(`${line}\n`);
    },
    writeChunk(chunk) {
      output.push(chunk);
    },
    async prompt() {
      return inputs.shift();
    },
  };
  return {
    io,
    createAgent: async () => agent,
    defaultModel: "gpt-test",
  };
}
