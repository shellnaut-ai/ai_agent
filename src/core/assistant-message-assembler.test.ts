import { describe, expect, it } from "vitest";

import { AssistantMessageAssembler } from "./assistant-message-assembler.js";

describe("AssistantMessageAssembler", () => {
  it("assembles text and interleaved tool-call deltas in source order", () => {
    const assembler = new AssistantMessageAssembler({
      id: "assistant-1",
      createdAt: "2026-07-26T00:00:00.000Z",
    });

    assembler.apply({ type: "text_delta", delta: "파일을 읽겠습니다." });
    assembler.apply({
      type: "tool_call_delta",
      index: 1,
      id: "call-b",
      name: "read",
      argumentsDelta: "{\"path\":",
    });
    assembler.apply({
      type: "tool_call_delta",
      index: 0,
      id: "call-a",
      name: "read",
      argumentsDelta: "{\"path\":\"a.txt\"}",
    });
    assembler.apply({
      type: "tool_call_delta",
      index: 1,
      argumentsDelta: "\"b.txt\"}",
    });
    assembler.apply({ type: "finish", reason: "tool_calls" });

    expect(assembler.finalize()).toEqual({
      id: "assistant-1",
      role: "assistant",
      content: "파일을 읽겠습니다.",
      toolCalls: [
        {
          id: "call-a",
          name: "read",
          argumentsJson: "{\"path\":\"a.txt\"}",
        },
        {
          id: "call-b",
          name: "read",
          argumentsJson: "{\"path\":\"b.txt\"}",
        },
      ],
      createdAt: "2026-07-26T00:00:00.000Z",
    });
  });

  it("rejects an incomplete tool call instead of executing a draft", () => {
    const assembler = new AssistantMessageAssembler({
      id: "assistant-2",
      createdAt: "2026-07-26T00:00:00.000Z",
    });

    assembler.apply({
      type: "tool_call_delta",
      index: 0,
      id: "call-without-name",
      argumentsDelta: "{}",
    });

    expect(() => assembler.finalize()).toThrow(
      "Tool call at index 0 is missing an id or name",
    );
  });
});

