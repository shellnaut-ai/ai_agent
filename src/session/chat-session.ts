import { AgentLoop } from "../agent/loop.js";
import type { AgentLoopOptions } from "../agent/types.js";
import { CompactionService } from "../context/compaction.js";
import type { Message, Model, UserMessage } from "../model/types.js";
import type { ToolDefinition } from "../tools/types.js";
import { InterruptedToolRecoveryError, Session } from "./session.js";
import type { ChatEvent } from "./types.js";

export interface ChatSessionOptions {
  readonly session: Session;
  readonly compactionService?: CompactionService;
  readonly toolDefinitions?: readonly ToolDefinition[];
}

export class ChatSession {
  private readonly model: Model;
  private readonly agentLoop: AgentLoop;
  private readonly session: Session;
  private readonly compactionService: CompactionService | undefined;
  private readonly toolDefinitions: readonly ToolDefinition[];
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
  }

  public getMessages(): readonly Message[] {
    return this.session.getMessages();
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

    if (this.compactionService) {
      let preparation;

      try {
        preparation = this.compactionService.prepare({
          model: this.model,
          turns: this.session.buildCompactionTurns(),
          previousCompaction:
            this.session.getPreviousCompaction(),
          pendingUserMessage: newMessage,
          toolDefinitions: this.toolDefinitions,
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
      messages: [...this.session.buildActiveMessages()],
    };

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
