import { describe, expect, test } from "vitest";

import {
  CODEX_DEFAULT_MODEL_ID,
  CODEX_SUPPORTED_MODEL_IDS,
  codexWireModelId,
  createCodexModel,
} from "./openai-codex-models.js";

describe("ChatGPT Codex model catalog", () => {
  test("creates current Codex models with the backend context contract", () => {
    expect(CODEX_DEFAULT_MODEL_ID).toBe("gpt-5.6-sol");
    expect(CODEX_SUPPORTED_MODEL_IDS).toEqual([
      "gpt-5.6-sol",
      "gpt-5.6-terra",
      "gpt-5.6-luna",
      "gpt-5.5",
      "gpt-5.6",
    ]);

    for (const id of CODEX_SUPPORTED_MODEL_IDS) {
      expect(createCodexModel(id)).toEqual({
        id,
        name: id,
        provider: "openai-codex",
        contextWindow: 272_000,
        maxOutputTokens: 4_096,
      });
    }
  });

  test("maps only the legacy GPT-5.6 session alias to Sol on the wire", () => {
    expect(codexWireModelId("gpt-5.6")).toBe("gpt-5.6-sol");
    expect(codexWireModelId("gpt-5.6-sol")).toBe("gpt-5.6-sol");
    expect(codexWireModelId("gpt-5.6-terra")).toBe("gpt-5.6-terra");
    expect(codexWireModelId("gpt-5.6-luna")).toBe("gpt-5.6-luna");
    expect(codexWireModelId("gpt-5.5")).toBe("gpt-5.5");
  });

  test("rejects unknown Codex models with the supported IDs", () => {
    expect(() => createCodexModel("gpt-9")).toThrow(
      /gpt-5\.6-sol.*gpt-5\.6-terra.*gpt-5\.6-luna.*gpt-5\.5.*gpt-5\.6/s,
    );
  });
});
