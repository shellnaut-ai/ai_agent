import type { ContextBudget, ContextBudgetCalculator, ToolResultBudget } from "./budget.js";
import type { ModelRequest, UserMessage } from "../model/types.js";

export type CompactionReason = "manual" | "threshold" | "overflow";

export type ContextCoordinatorEvent =
  | {
      readonly type: "compaction-start";
      readonly reason: CompactionReason;
      readonly tokensBefore: number;
    }
  | {
      readonly type: "compaction-done";
      readonly reason: CompactionReason;
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
      readonly request?: ModelRequest;
    };

export interface ContextCoordinator {
  preparePendingUserMessage?(
    request: ModelRequest,
    pendingUserMessage: UserMessage,
    options?: { readonly signal?: AbortSignal },
  ): AsyncIterable<ContextCoordinatorEvent>;

  prepareModelRequest(
    request: ModelRequest,
    options?: { readonly signal?: AbortSignal },
  ): AsyncIterable<ContextCoordinatorEvent>;

  reserveToolResult(
    request: ModelRequest,
    options?: {
      readonly signal?: AbortSignal;
      readonly toolCallId?: string;
    },
  ): AsyncIterable<ContextCoordinatorEvent>;

  compact?(
    request: ModelRequest,
    reason: CompactionReason,
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

  async *reserveToolResult(
    request: ModelRequest,
    options?: { readonly toolCallId?: string },
  ): AsyncIterable<ContextCoordinatorEvent> {
    yield {
      type: "tool-result-budget-ready",
      budget: this.#calculator.calculateToolResultBudget(
        request,
        options?.toolCallId,
      ),
      request: structuredClone(request),
    };
  }
}
