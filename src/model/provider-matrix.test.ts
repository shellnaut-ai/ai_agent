import { describe, expect, test } from "vitest";

import { OpenAICodexProvider } from "../providers/openai-codex-provider.js";
import { OpenAICompatibleProvider } from "../providers/openai-compatible-provider.js";
import { LlamaProvider } from "../providers/llama/provider.js";
import { ProviderRegistry } from "./registry.js";

describe("provider matrix", () => {
  test("registers llama, OpenAI-compatible, and Codex models together", async () => {
    const registry = new ProviderRegistry();
    registry.register(new LlamaProvider({
      serverUrl: "http://127.0.0.1:8080",
      modelId: "gemma",
      contextWindow: 8192,
      maxOutputTokens: 1024,
    }));
    registry.register(new OpenAICompatibleProvider({
      baseUrl: "http://127.0.0.1:11434/v1",
      model: {
        id: "ollama-gemma",
        name: "Ollama Gemma",
        provider: "openai-compatible",
        contextWindow: 8192,
        maxOutputTokens: 1024,
      },
    }));
    registry.register(new OpenAICodexProvider({
      model: {
        id: "gpt-5.1-codex-mini",
        name: "Codex Mini",
        provider: "openai-codex",
        contextWindow: 128_000,
        maxOutputTokens: 4096,
      },
      resolver: {
        async resolve() {
          throw new Error("listModels must not resolve credentials");
        },
      },
    }));

    expect(registry.listProviders().map((provider) => provider.id)).toEqual([
      "llama",
      "openai-compatible",
      "openai-codex",
    ]);
    expect((await registry.listModels()).map((model) => model.id)).toEqual([
      "gemma",
      "ollama-gemma",
      "gpt-5.1-codex-mini",
    ]);
  });
});
