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
import { ContextBudgetCalculator } from "./budget.js";
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

function assertCompleteToolPairs(turns: readonly CompactionTurn[]): void {
  for (const turn of turns) {
    const pending = new Set<string>();
    for (const message of turn.messages) {
      if (message.role === "assistant") {
        for (const call of message.toolCalls) {
          if (pending.has(call.id)) {
            throw new Error(
              `Compaction turn "${turn.firstEntryId}" repeats tool call ` +
                `"${call.id}".`,
            );
          }
          pending.add(call.id);
        }
        continue;
      }
      if (message.role === "tool") {
        if (!pending.delete(message.toolCallId)) {
          throw new Error(
            `Compaction turn "${turn.firstEntryId}" has tool result ` +
              `"${message.toolCallId}" without a matching call.`,
          );
        }
      }
    }
    const firstPending = pending.values().next().value as string | undefined;
    if (firstPending !== undefined) {
      throw new Error(
        `Compaction cannot summarize incomplete tool call ` +
          `"${firstPending}" in turn "${turn.firstEntryId}".`,
      );
    }
  }
}

export class CompactionService {
  private readonly runner: ModelStreamRunner;
  private readonly settings: CompactionSettings;
  private readonly estimator: TokenEstimator;
  private readonly budgetCalculator: ContextBudgetCalculator;

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
    this.budgetCalculator = new ContextBudgetCalculator(this.estimator);
  }

  prepare(request: CompactionRequest): CompactionPreparation | undefined {
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
      ...(request.pendingUserMessage === undefined
        ? []
        : [request.pendingUserMessage]),
    ];
    const budget = this.budgetCalculator.calculate({
      model: request.model,
      messages: activeMessages,
      tools: request.toolDefinitions,
      ...(request.maxOutputTokens === undefined
        ? {}
        : { maxOutputTokens: request.maxOutputTokens }),
    });
    const tokensBefore = budget.estimatedInputTokens;
    const inputBudget = budget.inputBudget;

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

    assertCompleteToolPairs(turnsToSummarize);

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

    let summary = preparation.previousSummary;
    let batch: CompactionTurn[] = [];

    for (const turn of preparation.turnsToSummarize) {
      const candidate = [...batch, turn];
      if (this.summaryRequestFits(preparation.model, candidate, summary)) {
        batch = candidate;
        continue;
      }
      if (batch.length === 0) {
        throw new Error(
          `Compaction turn "${turn.firstEntryId}" exceeds the summarizer ` +
            "input budget.",
        );
      }
      summary = await this.summarizeBatch(
        preparation.model,
        batch,
        summary,
        options?.signal,
      );
      batch = [turn];
      if (!this.summaryRequestFits(preparation.model, batch, summary)) {
        throw new Error(
          `Compaction turn "${turn.firstEntryId}" exceeds the summarizer ` +
            "input budget.",
        );
      }
    }

    if (batch.length > 0) {
      summary = await this.summarizeBatch(
        preparation.model,
        batch,
        summary,
        options?.signal,
      );
    }
    if (summary === undefined) {
      throw new Error("Compaction had no turns to summarize.");
    }

    summary += formatFileDetails(preparation.details);

    const compactedMessages: Message[] = [
      createCompactionSummaryMessage(summary),
      ...flattenTurns(preparation.keptTurns),
      ...(preparation.pendingUserMessage === undefined
        ? []
        : [preparation.pendingUserMessage]),
    ];
    const tokensAfter = this.estimator.estimateRequest({
      model: preparation.model,
      messages: compactedMessages,
      tools: preparation.toolDefinitions,
    });

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

  private createSummaryRequest(
    model: CompactionPreparation["model"],
    turns: readonly CompactionTurn[],
    previousSummary: string | undefined,
  ): ModelRequest {
    const conversation = serializeTurns(
      turns,
      this.settings.toolResultMaxChars,
    );
    let prompt = `<conversation>\n${conversation}\n</conversation>\n\n`;
    if (previousSummary !== undefined) {
      prompt +=
        `<previous-summary>\n${previousSummary}\n` +
        `</previous-summary>\n\n${UPDATE_SUMMARY_PROMPT}`;
    } else {
      prompt += INITIAL_SUMMARY_PROMPT;
    }
    return {
      model,
      systemPrompt: SUMMARY_SYSTEM_PROMPT,
      messages: [{ role: "user", content: prompt }],
      tools: [],
      maxOutputTokens: this.settings.maxSummaryOutputTokens,
    };
  }

  private summaryRequestFits(
    model: CompactionPreparation["model"],
    turns: readonly CompactionTurn[],
    previousSummary: string | undefined,
  ): boolean {
    return this.budgetCalculator.calculate(
      this.createSummaryRequest(model, turns, previousSummary),
    ).remainingInputTokens >= 0;
  }

  private async summarizeBatch(
    model: CompactionPreparation["model"],
    turns: readonly CompactionTurn[],
    previousSummary: string | undefined,
    signal?: AbortSignal,
  ): Promise<string> {
    if (signal?.aborted) throw new Error("Compaction aborted.");
    const request = this.createSummaryRequest(model, turns, previousSummary);
    this.budgetCalculator.assertFits(request);
    let summary = "";
    let terminalSeen = false;
    for await (const event of this.runner.stream(request, { signal })) {
      if (event.type === "text-delta") {
        summary += event.delta;
        continue;
      }
      if (event.type === "tool-call") {
        throw new Error(
          "Compaction model returned a ToolCall even though no tools were provided.",
        );
      }
      if (event.type === "error") throw event.error;
      if (event.type === "done") {
        terminalSeen = true;
        if (event.reason === "length") {
          throw new Error("Compaction summary reached the output token limit.");
        }
        if (event.reason !== "stop") {
          throw new Error("Compaction model returned an invalid stop reason.");
        }
        break;
      }
    }
    if (!terminalSeen) {
      throw new Error("Compaction model stream ended without a terminal event.");
    }
    summary = summary.trim();
    if (summary.length === 0) {
      throw new Error("Compaction model returned an empty summary.");
    }
    return summary;
  }
}
