import { describe, expect, test } from "vitest";

import {
  ContextOverflowError,
  isContextOverflowError,
  isContextOverflowMessage,
  isRetryableModelError,
  ModelHttpError,
} from "./errors.js";

describe("model request errors", () => {
  test.each([
    [400, false],
    [401, false],
    [403, false],
    [408, true],
    [409, true],
    [429, true],
    [500, true],
    [503, true],
  ])("classifies HTTP %i retryability", (status, retryable) => {
    const error = new ModelHttpError(status, `HTTP ${status}`);

    expect(error).toMatchObject({
      name: "ModelHttpError",
      status,
      retryable,
      message: `HTTP ${status}`,
    });
    expect(isRetryableModelError(error)).toBe(retryable);
  });

  test("keeps ordinary transport errors retryable", () => {
    expect(isRetryableModelError(new Error("connection reset"))).toBe(true);
  });

  test("classifies only known context overflow messages", () => {
    expect(isContextOverflowMessage("context_length_exceeded")).toBe(true);
    expect(isContextOverflowMessage("exceeds the available context size")).toBe(true);
    expect(isContextOverflowMessage("HTTP 500 connection reset")).toBe(false);
    expect(isContextOverflowError(new ContextOverflowError("overflow"))).toBe(true);
    expect(isContextOverflowError(new Error("overflow"))).toBe(false);
  });
});
