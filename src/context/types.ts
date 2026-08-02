import type {
  Message,
  Model,
  UserMessage,
} from "../model/types.js";
import type { ToolDefinition } from "../tools/types.js";

export interface CompactionSettings {
  readonly reserveTokens: number;
  readonly keepRecentTokens: number;
  readonly charsPerToken: number;
  readonly maxSummaryOutputTokens: number;
  readonly toolResultMaxChars: number;
}

export interface CompactionTurn {
  readonly firstEntryId: string;
  readonly messages: readonly Message[];
}

export interface CompactionFileDetails {
  readonly readFiles: readonly string[];
  readonly modifiedFiles: readonly string[];
}

export interface PreviousCompaction {
  readonly summary: string;
  readonly firstKeptEntryId: string;
  readonly details: CompactionFileDetails;
}

export interface CompactionRequest {
  readonly model: Model;
  readonly turns: readonly CompactionTurn[];
  readonly previousCompaction?: PreviousCompaction;
  readonly pendingUserMessage: UserMessage;
  readonly toolDefinitions: readonly ToolDefinition[];
}

export interface CompactionPreparation {
  readonly model: Model;
  readonly previousSummary?: string;
  readonly turnsToSummarize: readonly CompactionTurn[];
  readonly keptTurns: readonly CompactionTurn[];
  readonly pendingUserMessage: UserMessage;
  readonly toolDefinitions: readonly ToolDefinition[];
  readonly firstKeptEntryId: string;
  readonly tokensBefore: number;
  readonly inputBudget: number;
  readonly details: CompactionFileDetails;
}

export interface CompactionResult {
  readonly summary: string;
  readonly firstKeptEntryId: string;
  readonly tokensBefore: number;
  readonly tokensAfter: number;
  readonly details: CompactionFileDetails;
}

export interface CompactionOptions {
  readonly signal?: AbortSignal;
}
