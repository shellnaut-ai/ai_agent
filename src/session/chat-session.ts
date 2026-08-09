import { AgentLoop } from "../agent/loop.js";
import type { AgentLoopOptions } from "../agent/types.js";
import { CompactionService } from "../context/compaction.js";
import type { Message, Model, UserMessage } from "../model/types.js";
import type { ToolDefinition } from "../tools/types.js";
import { Session } from "./session.js";
import { SessionRepository } from "./repository.js";
import type { SessionTreeNode } from "./tree.js";
import type { ChatEvent } from "./types.js";

export interface ChatSessionOptions {
  readonly session: Session;
  readonly sessionRepository?: SessionRepository;
  readonly onSessionChanged?: (session: Session) => void;
  readonly compactionService?: CompactionService;
  readonly toolDefinitions?: readonly ToolDefinition[];
}

export class ChatSession {
  private readonly model: Model;
  private readonly agentLoop: AgentLoop;
  private session: Session;
  private readonly sessionRepository: SessionRepository | undefined;
  private readonly onSessionChanged:
    | ((session: Session) => void)
    | undefined;
  private readonly compactionService: CompactionService | undefined;
  private readonly toolDefinitions: readonly ToolDefinition[];

  constructor(
    agentLoop: AgentLoop,
    model: Model,
    options: ChatSessionOptions,
  ) {
    this.agentLoop = agentLoop;
    this.model = model;
    this.session = options.session;
    this.sessionRepository = options.sessionRepository;
    this.onSessionChanged = options.onSessionChanged;
    this.compactionService = options.compactionService;
    this.toolDefinitions = [...(options.toolDefinitions ?? [])];
  }

  public getMessages(): readonly Message[] {
    return this.session.getMessages();
  }

  public getTree(): readonly SessionTreeNode[] {
    return this.session.getTree();
  }

  public getLeafId(): string | null {
    return this.session.getLeafId();
  }

  public moveTo(entryId: string): Promise<void> {
    return this.session.moveTo(entryId);
  }

  public async fork(
    entryId: string,
  ): Promise<{ sessionId: string; filePath: string }> {
    if (!this.sessionRepository) {
      throw new Error("Session forking is not configured.");
    }

    if (!this.onSessionChanged) {
      throw new Error(
        "Session replacement handling is not configured.",
      );
    }

    const result = await this.sessionRepository.fork(
      this.session,
      entryId,
    );
    this.onSessionChanged(result.session);
    this.session = result.session;

    return {
      sessionId: result.store.sessionId,
      filePath: result.store.filePath,
    };
  }

  public async clone(): Promise<{
    sessionId: string;
    filePath: string;
  }> {
    if (!this.sessionRepository) {
      throw new Error("Session cloning is not configured.");
    }

    if (!this.onSessionChanged) {
      throw new Error(
        "Session replacement handling is not configured.",
      );
    }

    const result = await this.sessionRepository.clone(this.session);
    this.onSessionChanged(result.session);
    this.session = result.session;

    return {
      sessionId: result.store.sessionId,
      filePath: result.store.filePath,
    };
  }

  public async *streamTurn(
    userContent: string,
    options?: AgentLoopOptions,
  ): AsyncIterable<ChatEvent> {
    const newMessage: UserMessage = {
      role: "user",
      content: userContent,
    };

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

    const request = {
      model: this.model,
      messages: [
        ...this.session.buildActiveMessages(),
        newMessage,
      ],
    };

    for await (const event of this.agentLoop.stream(request, options)) {
      if (event.type === "done") {
        const completedMessages: Message[] = [
          newMessage,
          ...event.newMessages.map((message) => ({
            ...message,
          })),
        ];

        try {
          await this.session.appendMessages(completedMessages);
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
