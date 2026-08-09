import { describe, expect, test } from "vitest";

import { cloneModelRequest } from "../model/request-clone.js";
import type { ModelRequest } from "../model/types.js";
import { ContextBudgetCalculator } from "./budget.js";
import { TokenEstimator } from "./token-estimator.js";

const model = {
  id: "local-model",
  name: "Local model",
  provider: "fake" as const,
  contextWindow: 8192,
  maxOutputTokens: 1024,
};

function request(overrides: Partial<ModelRequest> = {}): ModelRequest {
  return {
    model,
    messages: [{ role: "user", content: "inspect" }],
    tools: [],
    ...overrides,
  };
}

describe("ContextBudgetCalculator", () => {
  test("accepts an exact-limit input and represents one token over", () => {
    const calculator = new ContextBudgetCalculator(
      { estimateRequest: () => 6912 },
    );

    expect(calculator.calculate(request())).toEqual({
      requestedMaxOutputTokens: 1024,
      safetyMarginTokens: 256,
      inputBudget: 6912,
      estimatedInputTokens: 6912,
      remainingInputTokens: 0,
    });

    const oneOver = new ContextBudgetCalculator(
      { estimateRequest: () => 6913 },
    );
    expect(oneOver.calculate(request()).remainingInputTokens).toBe(-1);
    expect(() => oneOver.assertFits(request())).toThrow(
      "Model input exceeds the calculated context budget by 1 token.",
    );
  });

  test("uses request output limit and clamps the safety margin", () => {
    const calculator = new ContextBudgetCalculator(
      { estimateRequest: () => 10 },
    );
    const largeModel = { ...model, contextWindow: 128_000 };

    expect(calculator.calculate(request({
      model: largeModel,
      maxOutputTokens: 321,
    }))).toMatchObject({
      requestedMaxOutputTokens: 321,
      safetyMarginTokens: 2048,
      inputBudget: 125_631,
    });
  });

  test("rejects an output reservation that consumes the context window", () => {
    const calculator = new ContextBudgetCalculator(
      { estimateRequest: () => 0 },
    );

    expect(() => calculator.calculate(request({ maxOutputTokens: 8000 })))
      .toThrow(/output reservation and safety margin/i);
  });

  test("derives a bounded tool-result allowance from remaining input", () => {
    const calculator = new ContextBudgetCalculator(
      { estimateRequest: () => 6800 },
    );

    expect(calculator.calculateToolResultBudget(request())).toEqual({
      maxTokens: 112,
      maxBytes: 448,
    });
  });
});

describe("TokenEstimator request coverage", () => {
  test("counts system, tools, and continuation control as model input", () => {
    const estimator = new TokenEstimator(2);
    const plain = estimator.estimateRequest(request());
    const withSystem = estimator.estimateRequest(request({
      systemPrompt: "System instruction",
    }));
    const withTool = estimator.estimateRequest(request({
      tools: [{
        name: "read",
        description: "Read a file",
        inputSchema: {
          type: "object",
          properties: { path: { type: "string" } },
        },
      }],
    }));
    const withContinuation = estimator.estimateRequest(request({
      continuation: {
        kind: "assistant-output",
        logicalMessageId: "logical-1",
        segmentIndex: 1,
        previousTail: "partial",
        previousTailHash: "a".repeat(64),
      },
    }));

    expect(withSystem).toBeGreaterThan(plain);
    expect(withTool).toBeGreaterThan(plain);
    expect(withContinuation).toBeGreaterThan(plain);
  });

  test("cloneModelRequest isolates continuation metadata", () => {
    const original = request({
      continuation: {
        kind: "assistant-output",
        logicalMessageId: "logical-1",
        segmentIndex: 1,
        previousTail: "partial",
        previousTailHash: "b".repeat(64),
      },
    });

    const cloned = cloneModelRequest(original);
    (cloned.continuation as { segmentIndex: number }).segmentIndex = 99;

    expect(original.continuation?.segmentIndex).toBe(1);
  });
});
