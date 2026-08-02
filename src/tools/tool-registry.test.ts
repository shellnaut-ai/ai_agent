import { describe, expect, test } from "vitest";

import { ToolRegistry } from "./tool-registry.js";

describe("ToolRegistry", () => {
  test("exposes provider definitions in constructor source order without executors", () => {
    const registry = new ToolRegistry([
      {
        name: "second",
        description: "Second tool",
        inputSchema: { type: "object", properties: {} },
        parse(value: unknown) { return value; },
        async execute() { return { content: "second" }; },
      },
      {
        name: "first",
        description: "First tool",
        inputSchema: { type: "object", properties: {} },
        parse(value: unknown) { return value; },
        async execute() { return { content: "first" }; },
      },
    ]);

    expect(registry.definitions).toEqual([
      { name: "second", description: "Second tool", inputSchema: { type: "object", properties: {} } },
      { name: "first", description: "First tool", inputSchema: { type: "object", properties: {} } },
    ]);
    expect(registry.definitions[0]).not.toHaveProperty("execute");
  });

  test("returns a successful tool result with injected id and time", async () => {
    const registry = new ToolRegistry(
      [
        {
          name: "echo",
          description: "Echoes a value",
          inputSchema: { type: "object" },
          parse(value: unknown) {
            if (typeof value !== "object" || value === null || !("value" in value)) {
              throw new Error("value is required");
            }
            return value as { value: string };
          },
          async execute(argumentsValue: { value: string }) {
            return { content: argumentsValue.value };
          },
        },
      ],
      { createResultId: () => "result-1", now: () => "2026-07-26T00:00:00.000Z" },
    );

    await expect(
      registry.executeBatch([{ id: "call-1", name: "echo", argumentsJson: '{"value":"hello"}' }]),
    ).resolves.toEqual([
      {
        id: "result-1",
        role: "tool",
        toolCallId: "call-1",
        toolName: "echo",
        ok: true,
        content: "hello",
        createdAt: "2026-07-26T00:00:00.000Z",
      },
    ]);
  });

  test("turns each recoverable failure into a result and continues the batch", async () => {
    const registry = new ToolRegistry(
      [
        {
          name: "validate",
          description: "Accepts only { value: string }",
          inputSchema: { type: "object" },
          parse(value: unknown) {
            if (typeof value !== "object" || value === null || !("value" in value)) {
              throw new Error("value is required");
            }
            return value as { value: string };
          },
          async execute(argumentsValue: { value: string }) {
            if (argumentsValue.value === "explode") {
              throw new Error("tool exploded");
            }
            return { content: `accepted:${argumentsValue.value}` };
          },
        },
      ],
      { createResultId: (() => { let index = 0; return () => `result-${++index}`; })(), now: () => "now" },
    );

    const results = await registry.executeBatch([
      { id: "unknown", name: "missing", argumentsJson: "{}" },
      { id: "json", name: "validate", argumentsJson: "{" },
      { id: "arguments", name: "validate", argumentsJson: "{}" },
      { id: "execution", name: "validate", argumentsJson: '{"value":"explode"}' },
      { id: "success", name: "validate", argumentsJson: '{"value":"still-runs"}' },
    ]);

    expect(results.map((result) => [result.toolCallId, result.ok, result.error?.code, result.content])).toEqual([
      ["unknown", false, "unknown_tool", "Unknown tool: missing"],
      ["json", false, "invalid_json", expect.any(String)],
      ["arguments", false, "invalid_arguments", "value is required"],
      ["execution", false, "execution_error", "tool exploded"],
      ["success", true, undefined, "accepted:still-runs"],
    ]);
  });

  test("runs calls and lifecycle hooks strictly in assistant source order", async () => {
    const log: string[] = [];
    let releaseFirst: (() => void) | undefined;
    const firstFinished = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const registry = new ToolRegistry(
      [
        {
          name: "record",
          description: "Records execution order",
          inputSchema: { type: "object" },
          parse(value: unknown) { return value as { name: string }; },
          async execute(argumentsValue: { name: string }) {
            log.push(`execute-start:${argumentsValue.name}`);
            if (argumentsValue.name === "first") {
              await firstFinished;
            }
            log.push(`execute-end:${argumentsValue.name}`);
            return { content: argumentsValue.name };
          },
        },
      ],
      {
        createResultId: () => "result",
        now: () => "now",
        hooks: {
          onStart: (call) => { log.push(`hook-start:${call.id}`); },
          onEnd: (result) => { log.push(`hook-end:${result.toolCallId}`); },
        },
      },
    );

    const batch = registry.executeBatch([
      { id: "first", name: "record", argumentsJson: '{"name":"first"}' },
      { id: "second", name: "record", argumentsJson: '{"name":"second"}' },
    ]);
    await Promise.resolve();
    expect(log).toEqual(["hook-start:first", "execute-start:first"]);

    releaseFirst?.();
    await batch;
    expect(log).toEqual([
      "hook-start:first", "execute-start:first", "execute-end:first", "hook-end:first",
      "hook-start:second", "execute-start:second", "execute-end:second", "hook-end:second",
    ]);
  });

  test("uses per-batch hooks instead of constructor hooks when both are supplied", async () => {
    const constructorLog: string[] = [];
    const batchLog: string[] = [];
    const registry = new ToolRegistry(
      [{
        name: "echo",
        description: "Echoes a value",
        inputSchema: { type: "object" },
        parse(value: unknown) { return value as { value: string }; },
        async execute(argumentsValue: { value: string }) { return { content: argumentsValue.value }; },
      }],
      {
        createResultId: () => "result",
        now: () => "now",
        hooks: {
          onStart: () => { constructorLog.push("start"); },
          onEnd: () => { constructorLog.push("end"); },
        },
      },
    );

    await registry.executeBatch(
      [{ id: "call", name: "echo", argumentsJson: '{"value":"hello"}' }],
      {
        onStart: (call) => { batchLog.push(`start:${call.id}`); },
        onEnd: (result) => { batchLog.push(`end:${result.toolCallId}`); },
      },
    );

    expect(constructorLog).toEqual([]);
    expect(batchLog).toEqual(["start:call", "end:call"]);
  });
});
