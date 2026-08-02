import { describe, expect, test } from "vitest";

import {
  AgentLoop,
  JsonlSessionStore,
  OpenAICodexProvider,
  OpenAICompatibleProvider,
  ToolRegistry,
  WorkspacePaths,
} from "./index.js";

describe("public package entry", () => {
  test("exports the unified runtime boundaries", () => {
    expect([
      AgentLoop,
      JsonlSessionStore,
      OpenAICodexProvider,
      OpenAICompatibleProvider,
      ToolRegistry,
      WorkspacePaths,
    ]).not.toContain(undefined);
  });
});
