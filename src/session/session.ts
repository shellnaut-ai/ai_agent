import {
  createCompactionSummaryMessage,
} from "../context/compaction.js";
import type {
  CompactionResult,
  CompactionTurn,
  PreviousCompaction,
} from "../context/types.js";
import type {
  Message,
  ToolResultMessage,
} from "../model/types.js";
import type {
  CompactionEntry,
  MessageEntry,
  SessionEntry,
  SessionStore,
} from "./types.js";

function cloneMessage(message: Message): Message {
  return structuredClone(message);
}

function messagesFromEntries(
  entries: readonly SessionEntry[],
): Message[] {
  return entries
    .filter(
      (entry): entry is MessageEntry => entry.type === "message",
    )
    .map((entry) => cloneMessage(entry.message));
}

interface BranchToolCallState {
  readonly callIds: Set<string>;
  readonly pendingCallIds: Map<string, true>;
}

const interruptedToolResultContent =
  "Tool execution was interrupted before its result was recorded. " +
  "The outcome is unknown. Inspect workspace state before retrying " +
  "this operation.";

export class InterruptedToolRecoveryError extends Error {
  readonly recoveredMessages: readonly ToolResultMessage[];

  constructor(
    cause: unknown,
    recoveredMessages: readonly ToolResultMessage[],
  ) {
    super(cause instanceof Error ? cause.message : String(cause));
    this.recoveredMessages = structuredClone(recoveredMessages);
  }
}

function getBranchToolCallState(
  entries: readonly SessionEntry[],
): BranchToolCallState {
  const callIds = new Set<string>();
  const pendingCallIds = new Map<string, true>();

  for (const entry of entries) {
    if (entry.type !== "message") {
      continue;
    }

    if (entry.message.role === "assistant") {
      for (const toolCall of entry.message.toolCalls) {
        callIds.add(toolCall.id);
        pendingCallIds.set(toolCall.id, true);
      }
    } else if (entry.message.role === "tool") {
      pendingCallIds.delete(entry.message.toolCallId);
    }
  }

  return { callIds, pendingCallIds };
}

export class Session {
  private readonly store: SessionStore;

  constructor(store: SessionStore) {
    this.store = store;
  }

  getMessages(): readonly Message[] {
    return messagesFromEntries(this.store.getPathToRoot());
  }

  getLatestCompaction(): CompactionEntry | undefined {
    const path = this.store.getPathToRoot();

    for (let index = path.length - 1; index >= 0; index -= 1) {
      const entry = path[index];

      if (entry.type === "compaction") {
        return structuredClone(entry);
      }
    }

    return undefined;
  }

  getPreviousCompaction(): PreviousCompaction | undefined {
    const entry = this.getLatestCompaction();

    if (!entry) {
      return undefined;
    }

    return {
      summary: entry.summary,
      firstKeptEntryId: entry.firstKeptEntryId,
      details: structuredClone(entry.details),
    };
  }

  buildActiveMessages(): readonly Message[] {
    const path = this.store.getPathToRoot();
    let compactionIndex = -1;

    for (let index = path.length - 1; index >= 0; index -= 1) {
      if (path[index].type === "compaction") {
        compactionIndex = index;
        break;
      }
    }

    if (compactionIndex < 0) {
      return messagesFromEntries(path);
    }

    const compaction = path[compactionIndex];

    if (compaction.type !== "compaction") {
      throw new Error("Invalid session compaction position.");
    }

    const firstKeptIndex = path.findIndex(
      (entry) => entry.id === compaction.firstKeptEntryId,
    );

    if (
      firstKeptIndex < 0 ||
      firstKeptIndex >= compactionIndex
    ) {
      throw new Error(
        `Compaction entry "${compaction.id}" has an invalid ` +
          "first kept entry.",
      );
    }

    return [
      createCompactionSummaryMessage(compaction.summary),
      ...messagesFromEntries(
        path.slice(firstKeptIndex, compactionIndex),
      ),
      ...messagesFromEntries(path.slice(compactionIndex + 1)),
    ];
  }

  buildCompactionTurns(): readonly CompactionTurn[] {
    const path = this.store.getPathToRoot();
    const turns: CompactionTurn[] = [];
    let current:
      | {
          firstEntryId: string;
          messages: Message[];
        }
      | undefined;

    for (const entry of path) {
      if (entry.type !== "message") {
        continue;
      }

      if (entry.message.role === "user") {
        if (current) {
          turns.push(current);
        }

        current = {
          firstEntryId: entry.id,
          messages: [cloneMessage(entry.message)],
        };
        continue;
      }

      if (!current) {
        throw new Error(
          `Message entry "${entry.id}" appears before a user message.`,
        );
      }

      current.messages.push(cloneMessage(entry.message));
    }

    if (current) {
      turns.push(current);
    }

    return turns;
  }

  async appendMessages(
    messages: readonly Message[],
  ): Promise<readonly MessageEntry[]> {
    if (messages.length === 0) {
      return [];
    }

    if (messages[0].role !== "user") {
      throw new Error(
        "A completed session turn must start with a user message.",
      );
    }

    if (messages.slice(1).some((message) => message.role === "user")) {
      throw new Error(
        "A completed session turn may contain only one user message.",
      );
    }

    const entries: MessageEntry[] = [];
    let parentId = this.store.getLeafId();

    for (const message of messages) {
      const entry: MessageEntry = {
        type: "message",
        id: this.store.createEntryId(),
        parentId,
        timestamp: new Date().toISOString(),
        message: cloneMessage(message),
      };

      entries.push(entry);
      parentId = entry.id;
    }

    await this.store.appendEntries(entries);
    return entries.map((entry) => structuredClone(entry));
  }

  async appendMessage(message: Message): Promise<MessageEntry> {
    const branchState = getBranchToolCallState(
      this.store.getPathToRoot(),
    );

    if (message.role === "assistant") {
      for (const toolCall of message.toolCalls) {
        if (branchState.callIds.has(toolCall.id)) {
          throw new Error(
            `Tool call ID "${toolCall.id}" is duplicated on the ` +
              "active session branch.",
          );
        }

        branchState.callIds.add(toolCall.id);
      }
    } else if (
      message.role === "tool" &&
      !branchState.pendingCallIds.has(message.toolCallId)
    ) {
      throw new Error(
        `Tool result "${message.toolCallId}" does not match a ` +
          "pending tool call on the active session branch.",
      );
    }

    const entry: MessageEntry = {
      type: "message",
      id: this.store.createEntryId(),
      parentId: this.store.getLeafId(),
      timestamp: new Date().toISOString(),
      message: cloneMessage(message),
    };

    await this.store.appendEntry(entry);
    return structuredClone(entry);
  }

  async recoverInterruptedToolCalls(): Promise<
    readonly ToolResultMessage[]
  > {
    const { pendingCallIds } = getBranchToolCallState(
      this.store.getPathToRoot(),
    );
    const recovered: ToolResultMessage[] = [];

    for (const toolCallId of pendingCallIds.keys()) {
      const message: ToolResultMessage = {
        role: "tool",
        toolCallId,
        content: interruptedToolResultContent,
        isError: true,
      };

      try {
        await this.appendMessage(message);
      } catch (error: unknown) {
        throw new InterruptedToolRecoveryError(error, recovered);
      }

      recovered.push(structuredClone(message));
    }

    return recovered;
  }

  async appendCompaction(
    result: CompactionResult,
  ): Promise<CompactionEntry> {
    const path = this.store.getPathToRoot();
    const firstKeptEntry = path.find(
      (entry) => entry.id === result.firstKeptEntryId,
    );

    if (
      !firstKeptEntry ||
      firstKeptEntry.type !== "message" ||
      firstKeptEntry.message.role !== "user"
    ) {
      throw new Error(
        `Compaction first kept entry "${result.firstKeptEntryId}" ` +
          "must be a user message on the current path.",
      );
    }

    const entry: CompactionEntry = {
      type: "compaction",
      id: this.store.createEntryId(),
      parentId: this.store.getLeafId(),
      timestamp: new Date().toISOString(),
      summary: result.summary,
      firstKeptEntryId: result.firstKeptEntryId,
      tokensBefore: result.tokensBefore,
      details: structuredClone(result.details),
    };

    await this.store.appendEntry(entry);
    return structuredClone(entry);
  }
}
