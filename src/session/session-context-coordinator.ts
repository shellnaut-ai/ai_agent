import type { ContextBudgetCalculator } from "../context/budget.js";
import type {
  ContextCoordinator,
  ContextCoordinatorEvent,
} from "../context/coordinator.js";
import type { CompactionService } from "../context/compaction.js";
import type { ModelRequest } from "../model/types.js";
import type { Session } from "./session.js";

export class SessionContextCoordinator implements ContextCoordinator {
  readonly #session: Session;
  readonly #compaction: CompactionService;
  readonly #calculator: ContextBudgetCalculator;

  constructor(
    session: Session,
    compaction: CompactionService,
    calculator: ContextBudgetCalculator,
  ) {
    this.#session = session;
    this.#compaction = compaction;
    this.#calculator = calculator;
  }

  async *prepareModelRequest(
    request: ModelRequest,
    options?: { readonly signal?: AbortSignal },
  ): AsyncIterable<ContextCoordinatorEvent> {
    if (options?.signal?.aborted) throw new Error("Context preparation aborted.");
    const canonicalRequest: ModelRequest = {
      ...structuredClone(request),
      messages: [...this.#session.buildActiveMessages()],
    };
    const initialBudget = this.#calculator.calculate(canonicalRequest);
    if (initialBudget.remainingInputTokens >= 0) {
      yield {
        type: "model-input-ready",
        request: canonicalRequest,
        budget: initialBudget,
      };
      return;
    }

    const preparation = this.#compaction.prepare({
      model: request.model,
      turns: this.#session.buildCompactionTurns(),
      previousCompaction: this.#session.getPreviousCompaction(),
      toolDefinitions: request.tools,
      ...(request.maxOutputTokens === undefined
        ? {}
        : { maxOutputTokens: request.maxOutputTokens }),
    });
    if (preparation === undefined) {
      this.#calculator.assertFits(canonicalRequest);
      throw new Error("Unreachable context preparation state.");
    }

    yield {
      type: "compaction-start",
      tokensBefore: preparation.tokensBefore,
    };
    const result = await this.#compaction.compact(preparation, {
      signal: options?.signal,
    });
    if (options?.signal?.aborted) throw new Error("Context preparation aborted.");
    await this.#session.appendCompaction(result);
    yield {
      type: "compaction-done",
      tokensBefore: result.tokensBefore,
      tokensAfter: result.tokensAfter,
    };

    const preparedRequest: ModelRequest = {
      ...canonicalRequest,
      messages: [...this.#session.buildActiveMessages()],
    };
    yield {
      type: "model-input-ready",
      request: preparedRequest,
      budget: this.#calculator.assertFits(preparedRequest),
    };
  }

  async *reserveToolResult(
    request: ModelRequest,
    options?: { readonly signal?: AbortSignal },
  ): AsyncIterable<ContextCoordinatorEvent> {
    if (options?.signal?.aborted) throw new Error("Context preparation aborted.");
    let preparedRequest: ModelRequest = {
      ...structuredClone(request),
      messages: [...this.#session.buildActiveMessages()],
    };
    let budget = this.#calculator.calculateToolResultBudget(preparedRequest);
    if (budget.maxTokens < 128) {
      const requestedOutput =
        request.maxOutputTokens ?? request.model.maxOutputTokens;
      const preparation = this.#compaction.prepare({
        model: request.model,
        turns: this.#session.buildCompactionTurns(),
        previousCompaction: this.#session.getPreviousCompaction(),
        toolDefinitions: request.tools,
        maxOutputTokens: requestedOutput + 128,
      });
      if (preparation !== undefined) {
        yield {
          type: "compaction-start",
          tokensBefore: preparation.tokensBefore,
        };
        const result = await this.#compaction.compact(preparation, {
          signal: options?.signal,
        });
        if (options?.signal?.aborted) {
          throw new Error("Context preparation aborted.");
        }
        await this.#session.appendCompaction(result);
        yield {
          type: "compaction-done",
          tokensBefore: result.tokensBefore,
          tokensAfter: result.tokensAfter,
        };
        preparedRequest = {
          ...structuredClone(request),
          messages: [...this.#session.buildActiveMessages()],
        };
        budget = this.#calculator.calculateToolResultBudget(preparedRequest);
      }
    }
    yield { type: "tool-result-budget-ready", budget };
  }
}
