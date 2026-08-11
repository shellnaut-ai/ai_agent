import type { ContextBudget, ContextBudgetCalculator, ToolResultBudget } from "./budget.js";
import type { ModelRequest } from "../model/types.js";

export type ContextCoordinatorEvent =
  | { readonly type: "compaction-start"; readonly tokensBefore: number }
  | {
      readonly type: "compaction-done";
      readonly tokensBefore: number;
      readonly tokensAfter: number;
    }
  | {
      readonly type: "model-input-ready";
      readonly request: ModelRequest;
      readonly budget: ContextBudget;
    }
  | {
      readonly type: "tool-result-budget-ready";
      readonly budget: ToolResultBudget;
    };

export interface ContextCoordinator {
  prepareModelRequest(
    request: ModelRequest,
    options?: { readonly signal?: AbortSignal },
  ): AsyncIterable<ContextCoordinatorEvent>;
}

export class BudgetOnlyContextCoordinator implements ContextCoordinator {
  readonly #calculator: ContextBudgetCalculator;

  constructor(calculator: ContextBudgetCalculator) {
    this.#calculator = calculator;
  }

  async *prepareModelRequest(
    request: ModelRequest,
  ): AsyncIterable<ContextCoordinatorEvent> {
    yield {
      type: "model-input-ready",
      request: structuredClone(request),
      budget: this.#calculator.assertFits(request),
    };
  }
}
