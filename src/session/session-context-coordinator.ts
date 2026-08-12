import type { ContextBudgetCalculator } from "../context/budget.js";
import type {
  ContextCoordinator,
  ContextCoordinatorEvent,
} from "../context/coordinator.js";
import type { CompactionService } from "../context/compaction.js";
import type { ModelRequest, UserMessage } from "../model/types.js";
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
    if (this.#calculator.calculate(pendingRequest).remainingInputTokens >= 0) {
      return;
    }
    const preparation = this.#compaction.prepare({
      model: request.model,
      turns: this.#session.buildCompactionTurns(),
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
      this.#calculator.assertFits(pendingRequest);
      return;
    }
    yield { type: "compaction-start", tokensBefore: preparation.tokensBefore };
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
    this.#calculator.assertFits({
      ...structuredClone(request),
      messages: [
        ...this.#session.buildActiveMessages(),
        structuredClone(pendingUserMessage),
      ],
    });
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
