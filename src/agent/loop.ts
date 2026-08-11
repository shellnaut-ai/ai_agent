import { randomUUID } from "node:crypto";

import type { ToolApprovalHandler } from "../approval/types.js";
import type { ContextCoordinator } from "../context/coordinator.js";
import type { ModelStreamRunner } from "../model/runtime.js";
import type {
  AssistantMessage,
  AssistantContinuationSegment,
  Message,
  ModelRequest,
  ProviderMessageState,
  StopReason,
  ToolResultMessage,
} from "../model/types.js";
import type { ToolRegistry } from "../tools/registry.js";
import type { ToolResultBudget } from "../context/budget.js";
import type { ToolCall, ToolResult } from "../tools/types.js";
import { cloneToolDefinition } from "../tools/definition.js";
import type { AgentEvent, AgentLoopOptions, AgentRequest } from "./types.js";
import {
  ContinuationOverlapGuard,
  continuationTail,
  continuationTailHash,
  createOutputContinuationPolicy,
  estimateOutputTokens,
  type OutputContinuationPolicy,
} from "./output-continuation.js";

interface ActiveContinuation {
  readonly logicalMessageId: string;
  readonly nextSegmentIndex: number;
  readonly totalContent: string;
  readonly estimatedTotalOutputTokens: number;
  readonly previousTail: string;
  readonly previousTailHash: string;
  readonly tailHashes: ReadonlySet<string>;
  readonly continuationsUsed: number;
}

export class AgentLoop {
  private readonly runtime: ModelStreamRunner;
  private readonly toolRegistry: ToolRegistry;
  private readonly approvalHandler: ToolApprovalHandler | undefined;
  private readonly contextCoordinator: ContextCoordinator | undefined;
  private readonly outputContinuationPolicy: OutputContinuationPolicy | undefined;

  constructor(
    runtime: ModelStreamRunner,
    toolRegistry: ToolRegistry,
    approvalHandler?: ToolApprovalHandler,
    contextCoordinator?: ContextCoordinator,
    outputContinuationPolicy?: OutputContinuationPolicy,
  ) {
    this.runtime = runtime;
    this.toolRegistry = toolRegistry;
    this.approvalHandler = approvalHandler;
    this.contextCoordinator = contextCoordinator;
    this.outputContinuationPolicy = outputContinuationPolicy;
  }

  async *stream(
    request: AgentRequest,
    options?: AgentLoopOptions,
  ): AsyncIterable<AgentEvent> {
    yield {
      type: "start",
    };

    const maxSteps = options?.maxSteps ?? 8;
    const maxToolBatches = options?.maxToolBatches;
    const continuationPolicy = this.outputContinuationPolicy ??
      createOutputContinuationPolicy(request.model);

    if (!Number.isInteger(maxSteps) || maxSteps <= 0) {
      yield {
        type: "error",
        reason: "error",
        error: new Error("AgentLoop maxSteps must be a positive integer."),
      };

      return;
    }

    if (
      maxToolBatches !== undefined &&
      (!Number.isInteger(maxToolBatches) || maxToolBatches < 0)
    ) {
      yield {
        type: "error",
        reason: "error",
        error: new Error(
          "AgentLoop maxToolBatches must be a non-negative integer.",
        ),
      };

      return;
    }

    if (options?.signal?.aborted) {
      yield {
        type: "error",
        reason: "aborted",
        error: new Error("Agent execution aborted."),
      };

      return;
    }

    const workingMessages: Message[] = [...request.messages];

    const newMessages: Message[] = [];
    let completedToolBatches = 0;
    let activeContinuation: ActiveContinuation | undefined;
    const seenToolCallIds = new Set<string>();

    for (const message of request.messages) {
      if (message.role !== "assistant") {
        continue;
      }

      for (const call of message.toolCalls) {
        if (seenToolCallIds.has(call.id)) {
          yield {
            type: "error",
            reason: "error",
            error: new Error(`Duplicate tool call ID "${call.id}".`),
          };
          return;
        }

        seenToolCallIds.add(call.id);
      }
    }

    try {
      for (let step = 0; step < maxSteps; step += 1) {
        const continuationRequest = activeContinuation;
        const remainingOutputTokens = continuationRequest === undefined
          ? request.model.maxOutputTokens
          : continuationPolicy.maxTotalOutputTokens -
            continuationRequest.estimatedTotalOutputTokens;
        let modelRequest: ModelRequest = {
          model: request.model,
          messages: structuredClone(workingMessages),
          tools: this.toolRegistry.listDefinitions(),
          ...(continuationRequest === undefined
            ? {}
            : {
                maxOutputTokens: Math.min(
                  request.model.maxOutputTokens,
                  remainingOutputTokens,
                ),
                continuation: {
                  kind: "assistant-output" as const,
                  logicalMessageId: continuationRequest.logicalMessageId,
                  segmentIndex: continuationRequest.nextSegmentIndex,
                  previousTail: continuationRequest.previousTail,
                  previousTailHash: continuationRequest.previousTailHash,
                },
              }),
        };

        if (this.contextCoordinator !== undefined) {
          let preparedRequest: ModelRequest | undefined;
          for await (const event of this.contextCoordinator.prepareModelRequest(
            modelRequest,
            { signal: options?.signal },
          )) {
            if (event.type === "compaction-start") {
              yield event;
              continue;
            }
            if (event.type === "compaction-done") {
              yield event;
              continue;
            }
            if (event.type === "model-input-ready") {
              preparedRequest = structuredClone(event.request);
            }
          }
          if (preparedRequest === undefined) {
            throw new Error(
              "Context coordinator ended without a model-input-ready event.",
            );
          }
          modelRequest = preparedRequest;
        }

        let assistantContent = "";
        const overlapGuard = continuationRequest === undefined
          ? undefined
          : new ContinuationOverlapGuard(
              continuationRequest.previousTail,
              continuationPolicy.overlapWindowChars,
            );
        const toolCalls: ToolCall[] = [];
        let terminalReason: StopReason | undefined;
        let terminalProviderState: ProviderMessageState | undefined;
        let terminalIncompleteToolCall = false;
        let streamError:
          | { readonly reason: "aborted" | "error"; readonly error: Error }
          | undefined;

        for await (const event of this.runtime.stream(modelRequest, {
          signal: options?.signal,
        })) {
          if (event.type === "start") {
            continue;
          }

          if (event.type === "retry") {
            yield {
              type: "retry",
              attempt: event.attempt,
              maxRetries: event.maxRetries,
              delayMs: event.delayMs,
              error: event.error,
            };

            continue;
          }

          if (event.type === "text-delta") {
            if (overlapGuard === undefined) {
              assistantContent += event.delta;
              yield { type: "text-delta", delta: event.delta };
            } else {
              const novel = overlapGuard.push(event.delta);
              if (novel.length > 0) {
                assistantContent += novel;
                yield { type: "text-delta", delta: novel };
              }
            }

            continue;
          }

          if (event.type === "tool-call") {
            const toolCall = structuredClone(event.toolCall);

            if (seenToolCallIds.has(toolCall.id)) {
              throw new Error(`Duplicate tool call ID "${toolCall.id}".`);
            }

            seenToolCallIds.add(toolCall.id);
            toolCalls.push(toolCall);

            yield {
              type: "tool-call",
              toolCall: structuredClone(toolCall),
            };

            continue;
          }

          if (event.type === "error") {
            streamError = { reason: event.reason, error: event.error };
            break;
          }

          if (event.type === "done") {
            terminalReason = event.reason;
            terminalProviderState =
              event.providerState === undefined
                ? undefined
                : structuredClone(event.providerState);
            terminalIncompleteToolCall = event.incompleteToolCall === true;

            break;
          }
        }

        if (overlapGuard !== undefined) {
          const novel = overlapGuard.finish();
          if (novel.length > 0) {
            assistantContent += novel;
            yield { type: "text-delta", delta: novel };
          }
        }

        if (streamError !== undefined) {
          if (assistantContent.length > 0) {
            const checkpoint = createContinuationSegment({
              active: continuationRequest,
              content: assistantContent,
              providerState: undefined,
              toolCalls: [],
              status: "partial",
              resumeAllowed: false,
              policy: continuationPolicy,
            });
            yield {
              type: "message-checkpoint",
              message: structuredClone(checkpoint.message),
            };
            workingMessages.push(checkpoint.message);
            newMessages.push(checkpoint.message);
          }
          yield {
            type: "error",
            reason: streamError.reason,
            error: streamError.error,
          };
          return;
        }

        if (!terminalReason) {
          if (assistantContent.length > 0) {
            const checkpoint = createContinuationSegment({
              active: continuationRequest,
              content: assistantContent,
              providerState: undefined,
              toolCalls: [],
              status: "partial",
              resumeAllowed: false,
              policy: continuationPolicy,
            });
            yield {
              type: "message-checkpoint",
              message: structuredClone(checkpoint.message),
            };
            workingMessages.push(checkpoint.message);
            newMessages.push(checkpoint.message);
          }
          yield {
            type: "error",
            reason: "error",
            error: new Error("Model stream ended without a terminal event."),
          };

          return;
        }

        if (terminalReason === "length" && terminalIncompleteToolCall) {
          if (assistantContent.length > 0) {
            const checkpoint = createContinuationSegment({
              active: continuationRequest,
              content: assistantContent,
              providerState: terminalProviderState,
              toolCalls: [],
              status: "partial",
              resumeAllowed: false,
              policy: continuationPolicy,
            });
            yield {
              type: "message-checkpoint",
              message: structuredClone(checkpoint.message),
            };
            workingMessages.push(checkpoint.message);
            newMessages.push(checkpoint.message);
          }
          yield {
            type: "error",
            reason: "error",
            error: new Error(
              "Model reached its output limit with an incomplete tool call.",
            ),
          };
          return;
        }

        if (terminalReason === "tool-call" && toolCalls.length === 0) {
          yield {
            type: "error",
            reason: "error",
            error: new Error(
              "Model stopped for a tool call but returned no ToolCall.",
            ),
          };

          return;
        }

        if (terminalReason !== "tool-call" && toolCalls.length > 0) {
          yield {
            type: "error",
            reason: "error",
            error: new Error(
              "Model returned ToolCall events without a tool-call stop reason.",
            ),
          };

          return;
        }

        if (
          terminalReason === "tool-call" &&
          maxToolBatches !== undefined &&
          completedToolBatches >= maxToolBatches
        ) {
          yield {
            type: "error",
            reason: "error",
            error: new Error(
              `AgentLoop exceeded the maximum tool batch count of ` +
                `${maxToolBatches}.`,
            ),
          };

          return;
        }

        if (
          assistantContent.length === 0 &&
          (terminalReason === "length" ||
            (continuationRequest !== undefined && toolCalls.length === 0))
        ) {
          yield {
            type: "error",
            reason: "error",
            error: new Error("Continuation made no novel output progress."),
          };
          return;
        }

        const segment =
          terminalReason === "length" || continuationRequest !== undefined
            ? createContinuationSegment({
                active: continuationRequest,
                content: assistantContent,
                providerState: terminalProviderState,
                toolCalls,
                status: terminalReason === "length" ? "partial" : "complete",
                resumeAllowed: terminalReason === "length",
                policy: continuationPolicy,
              })
            : undefined;
        const assistantMessage: AssistantMessage = segment?.message ?? {
          role: "assistant",
          content: assistantContent,
          toolCalls: [...toolCalls],
          ...(terminalProviderState === undefined
            ? {}
            : { providerState: terminalProviderState }),
        };

        yield {
          type: "message-checkpoint",
          message: structuredClone(assistantMessage),
        };

        workingMessages.push(assistantMessage);

        newMessages.push(assistantMessage);

        if (terminalReason === "length") {
          if (segment === undefined || segment.next === undefined) {
            throw new Error("Continuation state was not created for a partial segment.");
          }
          const repeatedTail = continuationRequest?.tailHashes.has(
            segment.message.continuation!.tailHash,
          ) === true;
          activeContinuation = segment.next;
          if (repeatedTail) {
            yield {
              type: "error",
              reason: "error",
              error: new Error("Continuation repeated a previous output tail."),
            };
            return;
          }
          if (
            activeContinuation.estimatedTotalOutputTokens >=
            continuationPolicy.maxTotalOutputTokens
          ) {
            yield {
              type: "error",
              reason: "error",
              error: new Error("Continuation exhausted the total output token limit."),
            };
            return;
          }
          if (
            activeContinuation.continuationsUsed >=
            continuationPolicy.maxContinuations
          ) {
            yield {
              type: "error",
              reason: "error",
              error: new Error("Continuation reached the maximum continuation count."),
            };
            return;
          }
          continue;
        }

        activeContinuation = undefined;

        if (terminalReason !== "tool-call") {
          yield {
            type: "done",
            reason: terminalReason,
            newMessages,
          };

          return;
        }

        completedToolBatches += 1;

        for (const toolCall of toolCalls) {
          let resultBudget: ToolResultBudget | undefined;
          if (this.contextCoordinator !== undefined) {
            const reservationRequest: ModelRequest = {
              model: request.model,
              messages: structuredClone(workingMessages),
              tools: this.toolRegistry.listDefinitions(),
            };
            for await (const event of this.contextCoordinator.reserveToolResult(
              reservationRequest,
              { signal: options?.signal },
            )) {
              if (event.type === "compaction-start") {
                yield event;
                continue;
              }
              if (event.type === "compaction-done") {
                yield event;
                continue;
              }
              if (event.type === "tool-result-budget-ready") {
                resultBudget = event.budget;
              }
            }
            if (resultBudget === undefined) {
              throw new Error(
                "Context coordinator ended without a tool-result-budget-ready event.",
              );
            }
          }

          const preparation = this.toolRegistry.prepare(toolCall);
          let result: ToolResult;

          if (resultBudget !== undefined && resultBudget.maxTokens < 128) {
            result = {
              toolCallId: toolCall.id,
              content:
                "Insufficient tool result budget: at least 128 tokens are required.",
              isError: true,
            };
          } else if (!preparation.ok) {
            result = this.toolRegistry.boundResult(
              preparation.result,
              resultBudget,
            );
          } else if (preparation.tool.approval === "always") {
            const decision = this.approvalHandler
              ? await this.approvalHandler.requestApproval(
                  {
                    toolCall: structuredClone(preparation.executableCall),
                    definition: cloneToolDefinition(
                      preparation.tool.definition,
                    ),
                  },
                  {
                    signal: options?.signal,
                  },
                )
              : "deny";

            result =
              decision !== "deny"
                ? await this.toolRegistry.executePrepared(preparation, {
                    signal: options?.signal,
                    ...(resultBudget === undefined ? {} : { resultBudget }),
                  })
                : this.toolRegistry.boundResult({
                    toolCallId: toolCall.id,
                    content: `Tool "${toolCall.name}" was denied by the user.`,
                    isError: true,
                  }, resultBudget);
          } else {
            result = await this.toolRegistry.executePrepared(preparation, {
              signal: options?.signal,
              ...(resultBudget === undefined ? {} : { resultBudget }),
            });
          }

          const resultMessage: ToolResultMessage = {
            role: "tool",
            toolCallId: result.toolCallId,
            content: result.content,
            isError: result.isError,
          };

          yield {
            type: "tool-result",
            result,
            message: structuredClone(resultMessage),
          };

          workingMessages.push(resultMessage);

          newMessages.push(resultMessage);
        }
      }

      yield {
        type: "error",
        reason: "error",
        error: new Error(
          `AgentLoop exceeded the maximum ` + `step count of ${maxSteps}.`,
        ),
      };
    } catch (error: unknown) {
      yield {
        type: "error",
        reason: options?.signal?.aborted ? "aborted" : "error",
        error: error instanceof Error ? error : new Error(String(error)),
      };
    }
  }
}

function createContinuationSegment(input: {
  readonly active: ActiveContinuation | undefined;
  readonly content: string;
  readonly providerState: ProviderMessageState | undefined;
  readonly toolCalls: readonly ToolCall[];
  readonly status: AssistantContinuationSegment["status"];
  readonly resumeAllowed: boolean;
  readonly policy: OutputContinuationPolicy;
}): { readonly message: AssistantMessage; readonly next?: ActiveContinuation } {
  const logicalMessageId = input.active?.logicalMessageId ?? randomUUID();
  const segmentIndex = input.active?.nextSegmentIndex ?? 0;
  const totalContent = (input.active?.totalContent ?? "") + input.content;
  const estimatedTotalOutputTokens = estimateOutputTokens(totalContent);
  const previousTail = continuationTail(
    totalContent,
    input.policy.overlapWindowChars,
  );
  const tailHash = continuationTailHash(previousTail);
  const continuation: AssistantContinuationSegment = {
    logicalMessageId,
    segmentIndex,
    status: input.status,
    resumeAllowed: input.resumeAllowed,
    tailHash,
    estimatedTotalOutputTokens,
  };
  const message: AssistantMessage = {
    role: "assistant",
    content: input.content,
    toolCalls: structuredClone(input.toolCalls),
    ...(input.providerState === undefined
      ? {}
      : { providerState: structuredClone(input.providerState) }),
    continuation,
  };
  if (input.status !== "partial") return { message };

  const tailHashes = new Set(input.active?.tailHashes ?? []);
  tailHashes.add(tailHash);
  return {
    message,
    next: {
      logicalMessageId,
      nextSegmentIndex: segmentIndex + 1,
      totalContent,
      estimatedTotalOutputTokens,
      previousTail,
      previousTailHash: tailHash,
      tailHashes,
      continuationsUsed:
        (input.active?.continuationsUsed ?? 0) +
        (input.active === undefined ? 0 : 1),
    },
  };
}
