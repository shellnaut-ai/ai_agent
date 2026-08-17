import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";

import { createCodexModel } from "../providers/openai-codex-models.js";
import { JsonlSessionStore } from "../session/jsonl-store.js";
import { parseChatOptions, resolveChatModel } from "./main.js";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) =>
    rm(root, { recursive: true, force: true })
  ));
});

describe("CLI chat options", () => {
  test("defaults ChatGPT Codex to GPT-5.6 Sol", () => {
    expect(parseChatOptions([
      "chat",
      "--provider",
      "openai-codex",
    ])).toEqual({
      provider: "openai-codex",
      model: "gpt-5.6-sol",
    });
  });

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

  test("resumes a pre-upgrade default GPT-5.5 session without --model", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "ai-agent-cli-session-"));
    temporaryRoots.push(rootDir);
    const sessionId = "pre-upgrade-default";
    await new JsonlSessionStore({
      rootDir,
      sessionId,
      model: createCodexModel("gpt-5.5"),
    }).load();

    const options = parseChatOptions([
      "chat",
      "--provider",
      "openai-codex",
      "--session",
      sessionId,
    ]);

    await expect(resolveChatModel(options, rootDir)).resolves.toBe("gpt-5.5");
  });

  test("rejects a traversal session ID before reading its model header", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "ai-agent-cli-session-"));
    temporaryRoots.push(rootDir);
    await writeFile(
      join(rootDir, "outside.jsonl"),
      `${JSON.stringify({ model: { id: "gpt-5.5" } })}\n`,
      "utf8",
    );

    await expect(resolveChatModel({
      provider: "openai-codex",
      model: "gpt-5.6-sol",
      sessionId: "../../outside",
      resumeModelFromSession: true,
    }, rootDir)).rejects.toThrow("Session ID may contain only");
  });

  test("rejects an unsupported Provider before creating runtime resources", () => {
    expect(() => parseChatOptions([
      "chat",
      "--provider",
      "unknown",
    ])).toThrow('Unsupported provider "unknown"');
  });
});
