import type { ModelStreamRunner } from "../model/runtime.js";
import type {
  Message,
  ModelRequest,
  UserMessage,
} from "../model/types.js";
import {
  collectFileDetails,
  formatFileDetails,
  serializeTurns,
} from "./serialize.js";
import { TokenEstimator } from "./token-estimator.js";
import type {
  CompactionOptions,
  CompactionPreparation,
  CompactionRequest,
  CompactionResult,
  CompactionSettings,
  CompactionTurn,
} from "./types.js";

const SUMMARY_SYSTEM_PROMPT =
  "You are a context summarization assistant. Read a conversation " +
  "between a user and an AI assistant and output only the requested " +
  "structured checkpoint summary. Do not continue the conversation.";

const INITIAL_SUMMARY_PROMPT = `The messages above are a conversation to summarize. Create a structured context checkpoint summary that another LLM will use to continue the work.

Use this EXACT format:

## Goal
[What is the user trying to accomplish?]

## Constraints & Preferences
- [Requirements mentioned by the user, or "(none)"]

## Progress
### Done
- [x] [Completed work]

### In Progress
- [ ] [Current work]

### Blocked
- [Blocking issues, or "(none)"]

## Key Decisions
- **[Decision]**: [Brief rationale]

## Next Steps
1. [Ordered next action]

## Critical Context
- [Exact data needed to continue, or "(none)"]

Keep each section concise. Preserve exact file paths, function names, commands, and error messages.`;

const UPDATE_SUMMARY_PROMPT = `The messages above are NEW conversation messages to incorporate into the existing summary.

Update the structured summary using the same format. Preserve previous goals, constraints, completed work, key decisions, exact file paths, function names, commands, and error messages. Add new progress and update Next Steps. Do not invent information.`;

const COMPACTION_SUMMARY_PREFIX =
  "The conversation history before this point was compacted into " +
  "the following summary:\n\n<summary>\n";
const COMPACTION_SUMMARY_SUFFIX = "\n</summary>";

export function createCompactionSummaryMessage(
  summary: string,
): UserMessage {
  return {
    role: "user",
    content:
      COMPACTION_SUMMARY_PREFIX +
      summary +
      COMPACTION_SUMMARY_SUFFIX,
  };
}

function flattenTurns(turns: readonly CompactionTurn[]): Message[] {
  return turns.flatMap((turn) => [...turn.messages]);
}

export class CompactionService {
  private readonly runner: ModelStreamRunner;
  private readonly settings: CompactionSettings;
  private readonly estimator: TokenEstimator;

  constructor(runner: ModelStreamRunner, settings: CompactionSettings) {
    if (
      !Number.isInteger(settings.reserveTokens) ||
      settings.reserveTokens <= 0
    ) {
      throw new Error(
        "Compaction reserveTokens must be a positive integer.",
      );
    }

    if (
      !Number.isInteger(settings.keepRecentTokens) ||
      settings.keepRecentTokens <= 0
    ) {
      throw new Error(
        "Compaction keepRecentTokens must be a positive integer.",
      );
    }

    if (
      !Number.isInteger(settings.maxSummaryOutputTokens) ||
      settings.maxSummaryOutputTokens <= 0
    ) {
      throw new Error(
        "Compaction maxSummaryOutputTokens must be a positive integer.",
      );
    }

    if (
      !Number.isInteger(settings.toolResultMaxChars) ||
      settings.toolResultMaxChars <= 0
    ) {
      throw new Error(
        "Compaction toolResultMaxChars must be a positive integer.",
      );
    }

    this.runner = runner;
    this.settings = settings;
    this.estimator = new TokenEstimator(settings.charsPerToken);
  }

  prepare(request: CompactionRequest): CompactionPreparation | undefined {
    const inputBudget =
      request.model.contextWindow - this.settings.reserveTokens;

    if (inputBudget <= 0) {
      throw new Error(
        "Compaction reserveTokens must be smaller than the context window.",
      );
    }

    let activeTurns = [...request.turns];

    if (request.previousCompaction) {
      const activeStartIndex = activeTurns.findIndex(
        (turn) => {
          return (
            turn.firstEntryId ===
            request.previousCompaction!.firstKeptEntryId
          );
        },
      );

      if (activeStartIndex < 0) {
        throw new Error(
          "Previous compaction points outside the current session branch.",
        );
      }

      activeTurns = activeTurns.slice(activeStartIndex);
    }

    const activeMessages: Message[] = [
      ...(request.previousCompaction
        ? [
            createCompactionSummaryMessage(
              request.previousCompaction.summary,
            ),
          ]
        : []),
      ...flattenTurns(activeTurns),
      request.pendingUserMessage,
    ];
    const tokensBefore = this.estimator.estimateRequest(
      activeMessages,
      request.toolDefinitions,
    );

    if (tokensBefore <= inputBudget) {
      return undefined;
    }

    if (activeTurns.length < 2) {
      throw new Error(
        "The active context is too large and has no complete old turn " +
          "that can be compacted.",
      );
    }

    const keptTurns: CompactionTurn[] = [];
    let keptTokens = 0;

    for (let index = activeTurns.length - 1; index >= 0; index -= 1) {
      const turn = activeTurns[index];
      const turnTokens = this.estimator.estimateMessages(turn.messages);

      if (
        keptTurns.length > 0 &&
        keptTokens + turnTokens > this.settings.keepRecentTokens
      ) {
        break;
      }

      keptTurns.unshift(turn);
      keptTokens += turnTokens;
    }

    const firstKeptTurn = keptTurns[0];

    if (!firstKeptTurn) {
      throw new Error("Compaction could not select a recent turn to keep.");
    }

    const firstKeptPosition = activeTurns.findIndex(
      (turn) => turn.firstEntryId === firstKeptTurn.firstEntryId,
    );
    const turnsToSummarize = activeTurns.slice(0, firstKeptPosition);

    if (turnsToSummarize.length === 0) {
      throw new Error(
        "A single recent turn is too large to fit in the model context.",
      );
    }

    return {
      model: request.model,
      previousSummary: request.previousCompaction?.summary,
      turnsToSummarize,
      keptTurns,
      pendingUserMessage: request.pendingUserMessage,
      toolDefinitions: request.toolDefinitions,
      firstKeptEntryId: firstKeptTurn.firstEntryId,
      tokensBefore,
      inputBudget,
      details: collectFileDetails(
        turnsToSummarize,
        request.previousCompaction?.details,
      ),
    };
  }

  async compact(
    preparation: CompactionPreparation,
    options?: CompactionOptions,
  ): Promise<CompactionResult> {
    if (options?.signal?.aborted) {
      throw new Error("Compaction aborted.");
    }

    const conversation = serializeTurns(
      preparation.turnsToSummarize,
      this.settings.toolResultMaxChars,
    );
    let prompt =
      `<conversation>\n${conversation}\n</conversation>\n\n`;

    if (preparation.previousSummary !== undefined) {
      prompt +=
        `<previous-summary>\n${preparation.previousSummary}\n` +
        `</previous-summary>\n\n${UPDATE_SUMMARY_PROMPT}`;
    } else {
      prompt += INITIAL_SUMMARY_PROMPT;
    }

    const summaryRequest: ModelRequest = {
      model: preparation.model,
      systemPrompt: SUMMARY_SYSTEM_PROMPT,
      messages: [
        {
          role: "user",
          content: prompt,
        },
      ],
      tools: [],
      maxOutputTokens: this.settings.maxSummaryOutputTokens,
    };
    let summary = "";
    let terminalSeen = false;

    for await (const event of this.runner.stream(summaryRequest, {
      signal: options?.signal,
    })) {
      if (event.type === "text-delta") {
        summary += event.delta;
        continue;
      }

      if (event.type === "tool-call") {
        throw new Error(
          "Compaction model returned a ToolCall even though no tools " +
            "were provided.",
        );
      }

      if (event.type === "error") {
        throw event.error;
      }

      if (event.type === "done") {
        terminalSeen = true;

        if (event.reason === "length") {
          throw new Error(
            "Compaction summary reached the output token limit.",
          );
        }

        break;
      }
    }

    if (!terminalSeen) {
      throw new Error(
        "Compaction model stream ended without a terminal event.",
      );
    }

    summary = summary.trim();

    if (summary.length === 0) {
      throw new Error("Compaction model returned an empty summary.");
    }

    summary += formatFileDetails(preparation.details);

    const compactedMessages: Message[] = [
      createCompactionSummaryMessage(summary),
      ...flattenTurns(preparation.keptTurns),
      preparation.pendingUserMessage,
    ];
    const tokensAfter = this.estimator.estimateRequest(
      compactedMessages,
      preparation.toolDefinitions,
    );

    if (tokensAfter > preparation.inputBudget) {
      throw new Error(
        "Compacted context still exceeds the model input budget.",
      );
    }

    return {
      summary,
      firstKeptEntryId: preparation.firstKeptEntryId,
      tokensBefore: preparation.tokensBefore,
      tokensAfter,
      details: preparation.details,
    };
  }
}
