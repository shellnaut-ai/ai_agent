import type {
  ContextBudget,
  ContextBudgetCalculator,
} from "../context/budget.js";
import type {
  CompactionReason,
  ContextCoordinator,
  ContextCoordinatorEvent,
} from "../context/coordinator.js";
import type { CompactionService } from "../context/compaction.js";
import type { ModelRequest, UserMessage } from "../model/types.js";
import type { ModelInputTokenCounter } from "../model/runtime.js";
import type { Session } from "./session.js";

export class SessionContextCoordinator implements ContextCoordinator {
  readonly #session: Session;
  readonly #compaction: CompactionService;
  readonly #calculator: ContextBudgetCalculator;
  readonly #tokenCounter: ModelInputTokenCounter | undefined;

  constructor(
    session: Session,
    compaction: CompactionService,
    calculator: ContextBudgetCalculator,
    tokenCounter?: ModelInputTokenCounter,
  ) {
    this.#session = session;
    this.#compaction = compaction;
    this.#calculator = calculator;
    this.#tokenCounter = tokenCounter;
  }

  async *preparePendingUserMessage(
    request: ModelRequest,
    pendingUserMessage: UserMessage,
    options?: { readonly signal?: AbortSignal },
  ): AsyncIterable<ContextCoordinatorEvent> {
    if (options?.signal?.aborted) throw new Error("Context preparation aborted.");
    const sessionMessages = [...this.#session.buildActiveMessages()];
    assertSynchronizedMessages(request.messages, sessionMessages);
    const pendingRequest: ModelRequest = {
      ...structuredClone(request),
      messages: [...sessionMessages, structuredClone(pendingUserMessage)],
    };
    if (
      (await this.#calculateBudget(
        pendingRequest,
        options?.signal,
      )).remainingInputTokens >= 0
    ) {
      return;
    }
    const preparation = this.#compaction.prepare({
      model: request.model,
      turns: this.#session.buildCompactionTurns(),
      force: true,
      previousCompaction: this.#session.getPreviousCompaction(),
      pendingUserMessage: structuredClone(pendingUserMessage),
      toolDefinitions: request.tools,
      ...(request.systemPrompt === undefined
        ? {}
        : { systemPrompt: request.systemPrompt }),
      ...(request.maxOutputTokens === undefined
        ? {}
        : { maxOutputTokens: request.maxOutputTokens }),
      ...(request.continuation === undefined
        ? {}
        : { continuation: structuredClone(request.continuation) }),
    });
    if (preparation === undefined) {
      throw new Error("Context compaction did not produce a preparation.");
    }
    yield {
      type: "compaction-start",
      reason: "threshold",
      tokensBefore: preparation.tokensBefore,
    };
    const result = await this.#compaction.compact(preparation, {
      signal: options?.signal,
    });
    if (options?.signal?.aborted) throw new Error("Context preparation aborted.");
    await this.#session.appendCompaction(result);
    yield {
      type: "compaction-done",
      reason: "threshold",
      tokensBefore: result.tokensBefore,
      tokensAfter: result.tokensAfter,
    };
    await this.#assertFits({
      ...structuredClone(request),
      messages: [
        ...this.#session.buildActiveMessages(),
        structuredClone(pendingUserMessage),
      ],
    }, options?.signal);
  }

  async *prepareModelRequest(
    request: ModelRequest,
    options?: { readonly signal?: AbortSignal },
  ): AsyncIterable<ContextCoordinatorEvent> {
    if (options?.signal?.aborted) throw new Error("Context preparation aborted.");
    const sessionMessages = [...this.#session.buildActiveMessages()];
    assertSynchronizedMessages(request.messages, sessionMessages);
    const canonicalRequest: ModelRequest = {
      ...structuredClone(request),
      messages: sessionMessages,
    };
    const initialBudget = await this.#calculateBudget(
      canonicalRequest,
      options?.signal,
    );
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
      force: true,
      previousCompaction: this.#session.getPreviousCompaction(),
      toolDefinitions: request.tools,
      ...(request.systemPrompt === undefined
        ? {}
        : { systemPrompt: request.systemPrompt }),
      ...(request.maxOutputTokens === undefined
        ? {}
        : { maxOutputTokens: request.maxOutputTokens }),
      ...(request.continuation === undefined
        ? {}
        : { continuation: structuredClone(request.continuation) }),
    });
    if (preparation === undefined) {
      throw new Error("Context compaction did not produce a preparation.");
    }

    yield {
      type: "compaction-start",
      reason: "threshold",
      tokensBefore: preparation.tokensBefore,
    };
    const result = await this.#compaction.compact(preparation, {
      signal: options?.signal,
    });
    if (options?.signal?.aborted) throw new Error("Context preparation aborted.");
    await this.#session.appendCompaction(result);
    yield {
      type: "compaction-done",
      reason: "threshold",
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
      budget: await this.#assertFits(preparedRequest, options?.signal),
    };
  }

  async *reserveToolResult(
    request: ModelRequest,
    options?: {
      readonly signal?: AbortSignal;
      readonly toolCallId?: string;
    },
  ): AsyncIterable<ContextCoordinatorEvent> {
    if (options?.signal?.aborted) throw new Error("Context preparation aborted.");
    const sessionMessages = [...this.#session.buildActiveMessages()];
    assertSynchronizedMessages(request.messages, sessionMessages);
    let preparedRequest: ModelRequest = {
      ...structuredClone(request),
      messages: sessionMessages,
    };
    let budget = this.#calculator.calculateToolResultBudget(
      preparedRequest,
      options?.toolCallId,
    );
    if (budget.maxTokens < 128) {
      const requestedOutput =
        request.maxOutputTokens ?? request.model.maxOutputTokens;
      const preparation = this.#compaction.prepare({
        model: request.model,
        turns: this.#session.buildCompactionTurns(),
        force: true,
        previousCompaction: this.#session.getPreviousCompaction(),
        toolDefinitions: request.tools,
        ...(request.systemPrompt === undefined
          ? {}
          : { systemPrompt: request.systemPrompt }),
        maxOutputTokens: requestedOutput + 128,
        ...(request.continuation === undefined
          ? {}
          : { continuation: structuredClone(request.continuation) }),
      });
      if (preparation !== undefined) {
        yield {
          type: "compaction-start",
          reason: "threshold",
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
          reason: "threshold",
          tokensBefore: result.tokensBefore,
          tokensAfter: result.tokensAfter,
        };
        preparedRequest = {
          ...structuredClone(request),
          messages: [...this.#session.buildActiveMessages()],
        };
        budget = this.#calculator.calculateToolResultBudget(
          preparedRequest,
          options?.toolCallId,
        );
      }
    }
    yield {
      type: "tool-result-budget-ready",
      budget,
      request: structuredClone(preparedRequest),
    };
  }

  async *compact(
    request: ModelRequest,
    reason: CompactionReason,
    options?: { readonly signal?: AbortSignal },
  ): AsyncIterable<ContextCoordinatorEvent> {
    if (options?.signal?.aborted) {
      throw new Error("Context preparation aborted.");
    }

    const sessionMessages = [...this.#session.buildActiveMessages()];
    assertSynchronizedMessages(request.messages, sessionMessages);

    const preparation = this.#compaction.prepare({
      model: request.model,
      turns: this.#session.buildCompactionTurns(),
      force: true,
      previousCompaction: this.#session.getPreviousCompaction(),
      toolDefinitions: request.tools,
      ...(request.systemPrompt === undefined
        ? {}
        : { systemPrompt: request.systemPrompt }),
      ...(request.maxOutputTokens === undefined
        ? {}
        : { maxOutputTokens: request.maxOutputTokens }),
      ...(request.continuation === undefined
        ? {}
        : { continuation: structuredClone(request.continuation) }),
    });

    if (preparation === undefined) {
      throw new Error("Context compaction did not produce a preparation.");
    }

    yield {
      type: "compaction-start",
      reason,
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
      reason,
      tokensBefore: result.tokensBefore,
      tokensAfter: result.tokensAfter,
    };

    await this.#assertFits({
      ...structuredClone(request),
      messages: [...this.#session.buildActiveMessages()],
    }, options?.signal);
  }

  async #calculateBudget(
    request: ModelRequest,
    signal?: AbortSignal,
  ): Promise<ContextBudget> {
    const estimated = this.#calculator.calculate(request);

    if (this.#tokenCounter === undefined) {
      return estimated;
    }

    try {
      const inputTokens = await this.#tokenCounter.countInputTokens(
        request,
        { signal },
      );

      return inputTokens === undefined
        ? estimated
        : this.#calculator.calculateWithInputTokens(
            request,
            inputTokens,
          );
    } catch (error: unknown) {
      if (signal?.aborted) {
        throw error;
      }

      return estimated;
    }
  }

  async #assertFits(
    request: ModelRequest,
    signal?: AbortSignal,
  ): Promise<ContextBudget> {
    const budget = await this.#calculateBudget(request, signal);

    if (budget.remainingInputTokens < 0) {
      const excess = Math.abs(budget.remainingInputTokens);
      throw new Error(
        "Model input exceeds the calculated context budget by " +
          excess +
          " token" +
          (excess === 1 ? "" : "s") +
          ".",
      );
    }

    return budget;
  }
}

function assertSynchronizedMessages(
  requestMessages: readonly ModelRequest["messages"][number][],
  sessionMessages: readonly ModelRequest["messages"][number][],
): void {
  if (JSON.stringify(requestMessages) !== JSON.stringify(sessionMessages)) {
    throw new Error(
      "Model request messages are not synchronized with the durable session tail.",
    );
  }
}
