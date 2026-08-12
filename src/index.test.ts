import { describe, expect, test } from "vitest";

import {
  AgentLoop,
  ContextBudgetCalculator,
  FileReadCursorKeyStore,
  JsonlSessionStore,
  OpenAICodexProvider,
  OpenAICompatibleProvider,
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
