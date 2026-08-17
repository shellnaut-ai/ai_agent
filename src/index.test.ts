import { describe, expect, test } from "vitest";

import {
  AgentLoop,
  CODEX_DEFAULT_MODEL_ID,
  ContextBudgetCalculator,
  FileReadCursorKeyStore,
  JsonlSessionStore,
  ModelHttpError,
  OpenAICodexProvider,
  OpenAICompatibleProvider,
  createCodexModel,
  ToolRegistry,
  SessionContextCoordinator,
  WorkspacePaths,
  type JsonValue,
  type ProviderMessageState,
} from "./index.js";

describe("public package entry", () => {
  test("exports the unified runtime boundaries", () => {
    expect([
      AgentLoop,
      ContextBudgetCalculator,
      FileReadCursorKeyStore,
      JsonlSessionStore,
      OpenAICodexProvider,
      OpenAICompatibleProvider,
      ToolRegistry,
      SessionContextCoordinator,
      WorkspacePaths,
    ]).not.toContain(undefined);
  });

  test("exports current Codex model and HTTP error contracts", () => {
    expect(CODEX_DEFAULT_MODEL_ID).toBe("gpt-5.6-sol");
    expect(createCodexModel("gpt-5.6-luna")).toMatchObject({
      id: "gpt-5.6-luna",
      contextWindow: 272_000,
    });
    expect(new ModelHttpError(400, "bad request")).toMatchObject({
      status: 400,
      retryable: false,
    });
  });

  test("exports the provider message state contract", () => {
    const state: ProviderMessageState = {
      provider: "openai-codex",
      value: {
        reasoningItems: [{ type: "reasoning", id: "rs_1" }],
      },
    };
    const value: JsonValue = state.value;

    expect(value).toEqual({
      reasoningItems: [{ type: "reasoning", id: "rs_1" }],
    });
  });
});
