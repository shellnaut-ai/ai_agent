import { describe, expect, it } from "vitest";

import { DEFAULT_CODEX_MODEL } from "./main.js";

describe("CLI composition defaults", () => {
  it("uses the current Pi openai-codex default supported by ChatGPT OAuth", () => {
    expect(DEFAULT_CODEX_MODEL).toBe("gpt-5.5");
  });
});
