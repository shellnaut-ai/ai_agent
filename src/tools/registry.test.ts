import { Type } from "typebox";
import { describe, expect, test } from "vitest";

import { ToolRegistry } from "./registry.js";
import type { Tool } from "./types.js";

describe("ToolRegistry snapshots", () => {
  test("clones and freezes the full tool contract at registration", async () => {
    let originalExecutions = 0;
    let replacementExecutions = 0;
    const tool: Tool = {
      approval: "never",
      definition: {
        name: "count",
        description: "Count a number.",
        inputSchema: Type.Object({ value: Type.Number() }),
      },
      async execute(input) {
        expect(this).toBe(tool);
        originalExecutions += 1;
        return {
          content: String((input as { value: number }).value),
          isError: false,
        };
      },
    };
    const registry = new ToolRegistry();
    registry.register(tool);
    (tool.definition as { description: string }).description = "mutated";
    const properties = (tool.definition.inputSchema as {
      properties: Record<string, unknown>;
    }).properties;
    properties.value = Type.String();
    (tool as { approval: "always" }).approval = "always";
    (tool as { execute: Tool["execute"] }).execute = async () => {
      replacementExecutions += 1;
      return { content: "replacement", isError: false };
    };

    const preparation = registry.prepare({
      id: "call-1",
      name: "count",
      arguments: { value: "2" },
    });

    expect(preparation.ok).toBe(true);

    if (!preparation.ok) {
      throw new Error("Expected the registered tool call to validate.");
    }

    expect(preparation.executableCall.arguments).toEqual({ value: 2 });
    expect(preparation.tool.approval).toBe("never");
    await expect(registry.executePrepared(preparation)).resolves.toEqual({
      toolCallId: "call-1",
      content: "2",
      isError: false,
    });
    expect(originalExecutions).toBe(1);
    expect(replacementExecutions).toBe(0);
    expect(registry.listDefinitions()[0]?.description).toBe("Count a number.");
  });

  test("returns fresh nested definition clones to every caller", () => {
    const registry = new ToolRegistry();
    registry.register({
      approval: "never",
      definition: {
        name: "read",
        description: "Read a path.",
        inputSchema: Type.Object({ path: Type.String() }),
      },
      async execute() {
        return { content: "ok", isError: false };
      },
    });
    const first = registry.listDefinitions()[0];

    if (first === undefined) {
      throw new Error("Expected one registered definition.");
    }

    (first as { description: string }).description = "provider mutation";
    const properties = (first.inputSchema as {
      properties: Record<string, unknown>;
    }).properties;
    properties.path = Type.Number();

    const second = registry.listDefinitions()[0];
    expect(second?.description).toBe("Read a path.");
    expect(
      (second?.inputSchema as { properties: { path: { type: string } } })
        .properties.path.type,
    ).toBe("string");
  });

  test("bounds non-paged output with an explicit non-recoverable marker", async () => {
    const registry = new ToolRegistry();
    registry.register({
      approval: "never",
      definition: {
        name: "large-output",
        description: "Return too much text.",
        inputSchema: Type.Object({}, { additionalProperties: false }),
      },
      async execute() {
        return { content: "x".repeat(2_000), isError: false };
      },
    });
    const preparation = registry.prepare({
      id: "large-1",
      name: "large-output",
      arguments: {},
    });
    if (!preparation.ok) throw new Error("Expected valid tool input.");

    const result = await registry.executePrepared(preparation, {
      resultBudget: { maxBytes: 512, maxTokens: 128 },
    });

    expect(Buffer.byteLength(result.content, "utf8")).toBeLessThanOrEqual(512);
    expect(result).toMatchObject({
      isError: true,
      content: expect.stringMatching(/truncated.*not recoverable|not recoverable.*truncated/i),
    });
  });

  test("bounds a thrown tool error through the exact result fit contract", async () => {
    const registry = new ToolRegistry();
    registry.register({
      approval: "never",
      definition: {
        name: "throw-large",
        description: "Throw too much text.",
        inputSchema: Type.Object({}, { additionalProperties: false }),
      },
      async execute() {
        throw new Error("boom".repeat(1_000));
      },
    });
    const preparation = registry.prepare({
      id: "throw-1",
      name: "throw-large",
      arguments: {},
    });
    if (!preparation.ok) throw new Error("Expected valid tool input.");

    const result = await registry.executePrepared(preparation, {
      resultBudget: {
        maxBytes: 256,
        maxTokens: 128,
        fits: (content) => content.length <= 120,
      },
    });

    expect(result.isError).toBe(true);
    expect(result.content.length).toBeLessThanOrEqual(120);
    expect(result.content).not.toContain("boom".repeat(100));
  });
});
