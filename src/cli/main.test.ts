import { describe, expect, test } from "vitest";

import { parseChatOptions } from "./main.js";

describe("CLI chat options", () => {
  test("selects a Provider, model, and session explicitly", () => {
    expect(parseChatOptions([
      "chat",
      "--provider",
      "openai-codex",
      "--model",
      "gpt-5.5",
      "--session",
      "review-session",
    ])).toEqual({
      provider: "openai-codex",
      model: "gpt-5.5",
      sessionId: "review-session",
    });
  });

  test("rejects an unsupported Provider before creating runtime resources", () => {
    expect(() => parseChatOptions([
      "chat",
      "--provider",
      "unknown",
    ])).toThrow('Unsupported provider "unknown"');
  });
});
