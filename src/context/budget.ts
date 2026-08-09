import type { ModelRequest } from "../model/types.js";

export interface ContextBudgetSettings {
  readonly safetyMarginRatio: number;
  readonly minSafetyMarginTokens: number;
  readonly maxSafetyMarginTokens: number;
  readonly minToolResultTokens: number;
}

export interface ContextBudget {
  readonly requestedMaxOutputTokens: number;
  readonly safetyMarginTokens: number;
  readonly inputBudget: number;
  readonly estimatedInputTokens: number;
  readonly remainingInputTokens: number;
}

export interface ToolResultBudget {
  readonly maxBytes: number;
  readonly maxTokens: number;
}

export interface RequestTokenEstimator {
  estimateRequest(request: ModelRequest): number;
}

const DEFAULT_SETTINGS: ContextBudgetSettings = {
  safetyMarginRatio: 0.02,
  minSafetyMarginTokens: 256,
  maxSafetyMarginTokens: 2048,
  minToolResultTokens: 128,
};

export class ContextBudgetCalculator {
  readonly #estimator: RequestTokenEstimator;
  readonly #settings: ContextBudgetSettings;

  constructor(
    estimator: RequestTokenEstimator,
    settings: ContextBudgetSettings = DEFAULT_SETTINGS,
  ) {
    if (
      !Number.isFinite(settings.safetyMarginRatio) ||
      settings.safetyMarginRatio < 0
    ) {
      throw new Error("Context safetyMarginRatio must be non-negative.");
    }
    for (const [name, value] of Object.entries({
      minSafetyMarginTokens: settings.minSafetyMarginTokens,
      maxSafetyMarginTokens: settings.maxSafetyMarginTokens,
      minToolResultTokens: settings.minToolResultTokens,
    })) {
      if (!Number.isInteger(value) || value <= 0) {
        throw new Error(`Context ${name} must be a positive integer.`);
      }
    }
    if (settings.minSafetyMarginTokens > settings.maxSafetyMarginTokens) {
      throw new Error(
        "Context minimum safety margin must not exceed the maximum.",
      );
    }

    this.#estimator = estimator;
    this.#settings = { ...settings };
  }

  calculate(request: ModelRequest): ContextBudget {
    const { contextWindow } = request.model;
    const requestedMaxOutputTokens =
      request.maxOutputTokens ?? request.model.maxOutputTokens;
    if (!Number.isInteger(contextWindow) || contextWindow <= 0) {
      throw new Error("Model contextWindow must be a positive integer.");
    }
    if (
      !Number.isInteger(requestedMaxOutputTokens) ||
      requestedMaxOutputTokens <= 0
    ) {
      throw new Error("Requested output tokens must be a positive integer.");
    }

    const ratioMargin = Math.ceil(
      contextWindow * this.#settings.safetyMarginRatio,
    );
    const safetyMarginTokens = Math.min(
      this.#settings.maxSafetyMarginTokens,
      Math.max(this.#settings.minSafetyMarginTokens, ratioMargin),
    );
    const inputBudget =
      contextWindow - requestedMaxOutputTokens - safetyMarginTokens;
    if (inputBudget <= 0) {
      throw new Error(
        "Model output reservation and safety margin must leave a positive input budget.",
      );
    }

    const estimatedInputTokens = this.#estimator.estimateRequest(request);
    if (
      !Number.isInteger(estimatedInputTokens) ||
      estimatedInputTokens < 0
    ) {
      throw new Error(
        "Request token estimator must return a non-negative integer.",
      );
    }

    return {
      requestedMaxOutputTokens,
      safetyMarginTokens,
      inputBudget,
      estimatedInputTokens,
      remainingInputTokens: inputBudget - estimatedInputTokens,
    };
  }

  assertFits(request: ModelRequest): ContextBudget {
    const budget = this.calculate(request);
    if (budget.remainingInputTokens < 0) {
      throw new Error(
        `Model input exceeds the calculated context budget by ` +
          `${Math.abs(budget.remainingInputTokens)} token` +
          `${budget.remainingInputTokens === -1 ? "" : "s"}.`,
      );
    }
    return budget;
  }

  calculateToolResultBudget(request: ModelRequest): ToolResultBudget {
    const remaining = Math.max(0, this.calculate(request).remainingInputTokens);
    return {
      maxTokens: remaining,
      maxBytes: Math.min(64 * 1024, remaining * 4),
    };
  }
}
