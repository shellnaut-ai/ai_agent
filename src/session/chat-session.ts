import { AgentLoop } from "../agent/loop.js";
import type { AgentLoopOptions } from "../agent/types.js";
import {
  continuationTail,
  continuationTailHash,
} from "../agent/output-continuation.js";
import { CompactionService } from "../context/compaction.js";
import type { ContextCoordinator } from "../context/coordinator.js";
import { isContextOverflowError } from "../model/errors.js";
import type { Message, Model, UserMessage } from "../model/types.js";
import type { ToolDefinition } from "../tools/types.js";
import { InterruptedToolRecoveryError, Session } from "./session.js";
import type { ChatEvent } from "./types.js";

export interface ChatSessionOptions {
  readonly session: Session;
  readonly compactionService?: CompactionService;
  readonly toolDefinitions?: readonly ToolDefinition[];
  readonly systemPrompt?: string;
  readonly contextCoordinator?: ContextCoordinator;
}

export class ChatSession {
  private readonly model: Model;
  private readonly agentLoop: AgentLoop;
  private readonly session: Session;
  private readonly compactionService: CompactionService | undefined;
  private readonly toolDefinitions: readonly ToolDefinition[];
  private readonly systemPrompt: string | undefined;
  private readonly contextCoordinator: ContextCoordinator | undefined;
  private turnActive = false;

  constructor(
    agentLoop: AgentLoop,
    model: Model,
    options: ChatSessionOptions,
  ) {
    this.agentLoop = agentLoop;
    this.model = model;
    this.session = options.session;
    this.compactionService = options.compactionService;
    this.toolDefinitions = [...(options.toolDefinitions ?? [])];
    this.systemPrompt = options.systemPrompt;
    this.contextCoordinator = options.contextCoordinator;
  }

  public getMessages(): readonly Message[] {
    return this.session.getMessages();
  }

  public getPendingContinuation() {
    return this.session.getPendingContinuation();
  }

  public async abandonPendingContinuation(): Promise<void> {
    if (this.turnActive) throw new Error("ChatSession already has an active turn.");
    await this.session.appendContinuationAbandoned();
  }

  public async *streamCompaction(
    options?: AgentLoopOptions,
  ): AsyncIterable<ChatEvent> {
    if (this.turnActive) {
      yield {
        type: "error",
        reason: "error",
        error: new Error("ChatSession already has an active turn."),
      };
      return;
    }

    if (this.contextCoordinator?.compact === undefined) {
      yield {
        type: "error",
        reason: "error",
        error: new Error("Manual compaction is not configured for this session."),
      };
      return;
    }

    this.turnActive = true;

    try {
      const request = {
        model: this.model,
        ...(this.systemPrompt === undefined
          ? {}
          : { systemPrompt: this.systemPrompt }),
        messages: [...this.session.buildActiveMessages()],
        tools: this.toolDefinitions,
      };

      for await (const event of this.contextCoordinator.compact(
        request,
        "manual",
        { signal: options?.signal },
      )) {
        if (
          event.type === "compaction-start" ||
          event.type === "compaction-done"
        ) {
          yield event;
        }
      }
    } catch (error: unknown) {
      yield {
        type: "error",
        reason: options?.signal?.aborted ? "aborted" : "error",
        error: error instanceof Error ? error : new Error(String(error)),
      };
    } finally {
      this.turnActive = false;
    }
  }

  public async *streamContinuation(
    options?: AgentLoopOptions,
  ): AsyncIterable<ChatEvent> {
    if (this.turnActive) {
      yield {
        type: "error",
        reason: "error",
        error: new Error("ChatSession already has an active turn."),
      };
      return;
    }
    this.turnActive = true;
    try {
      const pending = this.session.getPendingContinuation();
      if (pending === undefined || !pending.resumeAllowed) {
        yield {
          type: "error",
          reason: "error",
          error: new Error("The pending continuation cannot be resumed."),
        };
        return;
      }
      const messages = [...this.session.buildActiveMessages()];
      const logicalContent = messages
        .filter((message) =>
          message.role === "assistant" &&
          message.continuation?.logicalMessageId === pending.logicalMessageId
        )
        .map((message) => message.content)
        .join("");
      const previousTail = continuationTail(logicalContent, 1024);
      const previousTailHash = continuationTailHash(previousTail);
      if (previousTailHash !== pending.tailHash) {
        throw new Error("The pending continuation output tail has changed.");
      }
      yield* this.streamAgent({
        model: this.model,
        ...(this.systemPrompt === undefined
          ? {}
          : { systemPrompt: this.systemPrompt }),
        messages,
        continuation: {
          kind: "assistant-output",
          logicalMessageId: pending.logicalMessageId,
          segmentIndex: pending.segmentIndex + 1,
          previousTail,
          previousTailHash,
        },
      }, options);
    } catch (error: unknown) {
      yield {
        type: "error",
        reason: options?.signal?.aborted ? "aborted" : "error",
        error: error instanceof Error ? error : new Error(String(error)),
      };
    } finally {
      this.turnActive = false;
    }
  }

  public async *streamTurn(
    userContent: string,
    options?: AgentLoopOptions,
  ): AsyncIterable<ChatEvent> {
    if (this.turnActive) {
      yield {
        type: "error",
        reason: "error",
        error: new Error("ChatSession already has an active turn."),
      };
      return;
    }

    this.turnActive = true;

    try {
      yield* this.streamTurnUnlocked(userContent, options);
    } finally {
      this.turnActive = false;
    }
  }

  private async *streamTurnUnlocked(
    userContent: string,
    options?: AgentLoopOptions,
  ): AsyncIterable<ChatEvent> {
    const newMessage: UserMessage = {
      role: "user",
      content: userContent,
    };

    try {
      const recovered = await this.session.recoverInterruptedToolCalls();

      if (recovered.length > 0) {
        yield {
          type: "session-recovery",
          recoveredToolCallIds: recovered.map(
            (message) => message.toolCallId,
          ),
        };
      }
    } catch (error: unknown) {
      if (
        error instanceof InterruptedToolRecoveryError &&
        error.recoveredMessages.length > 0
      ) {
        yield {
          type: "session-recovery",
          recoveredToolCallIds: error.recoveredMessages.map(
            (message) => message.toolCallId,
          ),
        };
      }

      yield {
        type: "error",
        reason: "error",
        error:
          error instanceof InterruptedToolRecoveryError
            ? new Error(error.message)
            : error instanceof Error
              ? error
              : new Error(String(error)),
      };
      return;
    }

    const pendingContinuation = this.session.getPendingContinuation();
    if (pendingContinuation !== undefined) {
      yield {
        type: "continuation-recovery-required",
        continuation: pendingContinuation,
      };
      return;
    }

    if (this.contextCoordinator?.preparePendingUserMessage !== undefined) {
      try {
        const request = {
          model: this.model,
          ...(this.systemPrompt === undefined
            ? {}
            : { systemPrompt: this.systemPrompt }),
          messages: [...this.session.buildActiveMessages()],
          tools: this.toolDefinitions,
        };
        for await (const event of this.contextCoordinator.preparePendingUserMessage(
          request,
          newMessage,
          { signal: options?.signal },
        )) {
          if (event.type === "compaction-start" || event.type === "compaction-done") {
            yield event;
          }
        }
      } catch (error: unknown) {
        yield {
          type: "error",
          reason: options?.signal?.aborted ? "aborted" : "error",
          error: error instanceof Error ? error : new Error(String(error)),
        };
        return;
      }
    } else if (this.compactionService) {
      let preparation;

      try {
        preparation = this.compactionService.prepare({
          model: this.model,
          turns: this.session.buildCompactionTurns(),
          previousCompaction:
            this.session.getPreviousCompaction(),
          pendingUserMessage: newMessage,
          toolDefinitions: this.toolDefinitions,
          ...(this.systemPrompt === undefined
            ? {}
            : { systemPrompt: this.systemPrompt }),
        });
      } catch (error: unknown) {
        yield {
          type: "error",
          reason: options?.signal?.aborted ? "aborted" : "error",
          error: error instanceof Error ? error : new Error(String(error)),
        };
        return;
      }

      if (preparation) {
        yield {
          type: "compaction-start",
          reason: "threshold",
          tokensBefore: preparation.tokensBefore,
        };

        try {
          const result = await this.compactionService.compact(preparation, {
            signal: options?.signal,
          });

          if (options?.signal?.aborted) {
            throw new Error("Compaction aborted.");
          }

          await this.session.appendCompaction(result);

          yield {
            type: "compaction-done",
            reason: "threshold",
            tokensBefore: result.tokensBefore,
            tokensAfter: result.tokensAfter,
          };
        } catch (error: unknown) {
          yield {
            type: "error",
            reason: options?.signal?.aborted ? "aborted" : "error",
            error: error instanceof Error ? error : new Error(String(error)),
          };
          return;
        }
      }
    }

    try {
      await this.session.appendMessage(newMessage);
    } catch (error: unknown) {
      yield {
        type: "error",
        reason: "error",
        error: error instanceof Error ? error : new Error(String(error)),
      };
      return;
    }

    const request = {
      model: this.model,
      ...(this.systemPrompt === undefined
        ? {}
        : { systemPrompt: this.systemPrompt }),
      messages: [...this.session.buildActiveMessages()],
    };

    yield* this.streamAgentWithOverflowRecovery(request, options);
  }

  private async *streamAgentWithOverflowRecovery(
    request: Parameters<AgentLoop["stream"]>[0],
    options?: AgentLoopOptions,
  ): AsyncIterable<ChatEvent> {
    let activeRequest = structuredClone(request);
    let overflowRecoveryAttempted = false;

    while (true) {
      let visibleOutputSeen = false;
      let overflowError: Error | undefined;

      for await (const event of this.streamAgent(activeRequest, options)) {
        if (
          event.type === "text-delta" ||
          event.type === "tool-call" ||
          event.type === "tool-result" ||
          event.type === "message-checkpoint"
        ) {
          visibleOutputSeen = true;
        }

        if (
          event.type === "error" &&
          isContextOverflowError(event.error)
        ) {
          overflowError = event.error;
          break;
        }

        yield event;

        if (event.type === "error" || event.type === "done") {
          return;
        }
      }

      if (overflowError === undefined) {
        return;
      }

      if (
        visibleOutputSeen ||
        overflowRecoveryAttempted ||
        this.contextCoordinator?.compact === undefined
      ) {
        yield {
          type: "error",
          reason: "error",
          error:
            overflowRecoveryAttempted
              ? new Error(
                  "Context overflow recovery failed after one " +
                    "compact-and-retry attempt. Reduce context or use " +
                    "a larger model context window.",
                )
              : overflowError,
        };
        return;
      }

      overflowRecoveryAttempted = true;

      const recoveryRequest = {
        model: activeRequest.model,
        ...(activeRequest.systemPrompt === undefined
          ? {}
          : { systemPrompt: activeRequest.systemPrompt }),
        messages: [...this.session.buildActiveMessages()],
        tools: this.toolDefinitions,
        ...(activeRequest.maxOutputTokens === undefined
          ? {}
          : { maxOutputTokens: activeRequest.maxOutputTokens }),
        ...(activeRequest.continuation === undefined
          ? {}
          : { continuation: structuredClone(activeRequest.continuation) }),
      };

      try {
        for await (const event of this.contextCoordinator.compact(
          recoveryRequest,
          "overflow",
          { signal: options?.signal },
        )) {
          if (
            event.type === "compaction-start" ||
            event.type === "compaction-done"
          ) {
            yield event;
          }
        }
      } catch (error: unknown) {
        yield {
          type: "error",
          reason: options?.signal?.aborted ? "aborted" : "error",
          error: error instanceof Error ? error : new Error(String(error)),
        };
        return;
      }

      activeRequest = {
        ...structuredClone(activeRequest),
        messages: [...this.session.buildActiveMessages()],
      };
    }
  }

  private async *streamAgent(
    request: Parameters<AgentLoop["stream"]>[0],
    options?: AgentLoopOptions,
  ): AsyncIterable<ChatEvent> {
    for await (const event of this.agentLoop.stream(request, options)) {
      if (event.type === "message-checkpoint") {
        try {
          await this.session.appendMessage(event.message);
        } catch (error: unknown) {
          yield {
            type: "error",
            reason: "error",
            error: error instanceof Error ? error : new Error(String(error)),
          };

          return;
        }
      }

      if (event.type === "tool-result") {
        try {
          await this.session.appendMessage(event.message);
        } catch (error: unknown) {
          yield {
            type: "error",
            reason: "error",
            error: error instanceof Error ? error : new Error(String(error)),
          };

          return;
        }
      }

      yield event;

      if (event.type === "error" || event.type === "done") {
        return;
      }
    }
  }
}
