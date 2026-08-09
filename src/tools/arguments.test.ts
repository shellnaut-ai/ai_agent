import { describe, expect, test } from "vitest";

import { serializeToolCallArguments } from "./arguments.js";

describe("serializeToolCallArguments", () => {
  test("serializes ordinary tool arguments", () => {
    expect(serializeToolCallArguments({
      id: "call-1",
      name: "read",
      arguments: { path: "a.txt" },
    })).toBe('{"path":"a.txt"}');
  });

  test("rejects undefined instead of silently omitting replay arguments", () => {
    expect(() => serializeToolCallArguments({
      id: "call-1",
      name: "read",
      arguments: undefined,
    })).toThrow(
      'Tool call "call-1" arguments must not be undefined.',
    );
  });
});
