import type { ToolApprovalHandler } from "../approval/types.js";
import type { ModelStreamRunner } from "../model/runtime.js";
import type {
  AssistantMessage,
  Message,
  ModelRequest,
  StopReason,
  ToolResultMessage,
} from "../model/types.js";
import type { ToolRegistry } from "../tools/registry.js";
import type { ToolCall, ToolResult } from "../tools/types.js";
import type { AgentEvent, AgentLoopOptions, AgentRequest } from "./types.js";

export class AgentLoop {
  private readonly runtime: ModelStreamRunner;
  private readonly toolRegistry: ToolRegistry;
  private readonly approvalHandler: ToolApprovalHandler | undefined;

  constructor(
    runtime: ModelStreamRunner,
    toolRegistry: ToolRegistry,
    approvalHandler?: ToolApprovalHandler,
  ) {
    this.runtime = runtime;
    this.toolRegistry = toolRegistry;
    this.approvalHandler = approvalHandler;
  }

  async *stream(
    request: AgentRequest,
    options?: AgentLoopOptions,
  ): AsyncIterable<AgentEvent> {
    yield {
      type: "start",
    };

    const maxSteps = options?.maxSteps ?? 8;

    if (!Number.isInteger(maxSteps) || maxSteps <= 0) {
      yield {
        type: "error",
        reason: "error",
        error: new Error("AgentLoop maxSteps must be a positive integer."),
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

    const definitions = this.toolRegistry.listDefinitions();

    try {
      for (let step = 0; step < maxSteps; step += 1) {
        const modelRequest: ModelRequest = {
          model: request.model,
          messages: workingMessages,
          tools: definitions,
        };

        let assistantContent = "";
        const toolCalls: ToolCall[] = [];
        let terminalReason: StopReason | undefined;

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
            assistantContent += event.delta;

            yield {
              type: "text-delta",
              delta: event.delta,
            };

            continue;
          }

          if (event.type === "tool-call") {
            toolCalls.push(event.toolCall);

            yield {
              type: "tool-call",
              toolCall: event.toolCall,
            };

            continue;
          }

          if (event.type === "error") {
            yield {
              type: "error",
              reason: event.reason,
              error: event.error,
            };

            return;
          }

          if (event.type === "done") {
            terminalReason = event.reason;

            break;
          }
        }

        if (!terminalReason) {
          yield {
            type: "error",
            reason: "error",
            error: new Error("Model stream ended without a terminal event."),
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

        const assistantMessage: AssistantMessage = {
          role: "assistant",
          content: assistantContent,
          toolCalls: [...toolCalls],
        };

        workingMessages.push(assistantMessage);

        newMessages.push(assistantMessage);

        if (terminalReason !== "tool-call") {
          yield {
            type: "done",
            reason: terminalReason,
            newMessages,
          };

          return;
        }

        for (const toolCall of toolCalls) {
          const preparation = this.toolRegistry.prepare(toolCall);
          let result: ToolResult;

          if (!preparation.ok) {
            result = preparation.result;
          } else if (preparation.tool.approval === "always") {
            const decision = this.approvalHandler
              ? await this.approvalHandler.requestApproval(
                  {
                    toolCall: preparation.executableCall,
                    definition: preparation.tool.definition,
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
                  })
                : {
                    toolCallId: toolCall.id,
                    content: `Tool "${toolCall.name}" was denied by the user.`,
                    isError: true,
                  };
          } else {
            result = await this.toolRegistry.executePrepared(preparation, {
              signal: options?.signal,
            });
          }

          const resultMessage: ToolResultMessage = {
            role: "tool",
            toolCallId: result.toolCallId,
            content: result.content,
            isError: result.isError,
          };

          workingMessages.push(resultMessage);

          newMessages.push(resultMessage);

          yield {
            type: "tool-result",
            result,
          };
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
