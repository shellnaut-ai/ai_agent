import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Type } from "typebox";
import { afterEach, describe, expect, test } from "vitest";

import { ToolRegistry } from "./registry.js";
import type { Tool } from "./types.js";
import { WriteTool } from "./write.js";

const cleanup: string[] = [];

afterEach(async () => {
  await Promise.all(
    cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("tool integration", () => {
  test("write creates missing parent directories inside the workspace", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "ai-agent-write-"));
    cleanup.push(rootDir);
    const tool = new WriteTool({ rootDir });

    const result = await tool.execute({
      path: "nested/deep/a.txt",
      content: "A",
    });

    expect(result.isError).toBe(false);
    await expect(
      readFile(join(rootDir, "nested", "deep", "a.txt"), "utf8"),
    ).resolves.toBe("A");
  });

  test("executeBatch preserves order and continues after a failure", async () => {
    const registry = new ToolRegistry();
    const executionOrder: string[] = [];

    const tool = (name: string, isError: boolean): Tool => ({
      approval: "never",
      definition: {
        name,
        description: name,
        inputSchema: Type.Object({}, { additionalProperties: false }),
      },
      async execute() {
        executionOrder.push(name);
        return { content: name, isError };
      },
    });
    registry.register(tool("first", true));
    registry.register(tool("second", false));

    const results = await registry.executeBatch([
      { id: "1", name: "first", arguments: {} },
      { id: "2", name: "second", arguments: {} },
    ]);

    expect(executionOrder).toEqual(["first", "second"]);
    expect(results).toEqual([
      { toolCallId: "1", content: "first", isError: true },
      { toolCallId: "2", content: "second", isError: false },
    ]);
  });
});
