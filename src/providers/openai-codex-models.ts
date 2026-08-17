import type { Model } from "../model/types.js";

export const CODEX_DEFAULT_MODEL_ID = "gpt-5.6-sol";

export const CODEX_SUPPORTED_MODEL_IDS = [
  "gpt-5.6-sol",
  "gpt-5.6-terra",
  "gpt-5.6-luna",
  "gpt-5.5",
  "gpt-5.6",
] as const;

export type CodexModelId = typeof CODEX_SUPPORTED_MODEL_IDS[number];

export function createCodexModel(id: string): Model {
  if (!isCodexModelId(id)) {
    throw new Error(
      `Unsupported ChatGPT Codex model "${id}". Supported models: ` +
        CODEX_SUPPORTED_MODEL_IDS.join(", "),
    );
  }

  return {
    id,
    name: id,
    provider: "openai-codex",
    contextWindow: 272_000,
    maxOutputTokens: 4_096,
  };
}

export function codexWireModelId(id: string): string {
  return id === "gpt-5.6" ? CODEX_DEFAULT_MODEL_ID : id;
}

function isCodexModelId(id: string): id is CodexModelId {
  return CODEX_SUPPORTED_MODEL_IDS.some((candidate) => candidate === id);
}
