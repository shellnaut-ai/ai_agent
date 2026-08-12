import type {
  AssistantMessage,
  ErrorReason,
  Message,
  Model,
  ModelContinuation,
  StopReason,
  ToolResultMessage,
} from "../model/types.js";
import type { ToolCall, ToolResult } from "../tools/types.js";

export interface AgentRequest {
  readonly model: Model;
  readonly systemPrompt?: string;
  readonly messages: readonly Message[];
  readonly maxOutputTokens?: number;
  readonly continuation?: ModelContinuation;
}

export interface AgentExecutionPolicy {
  readonly maxSteps: number;
  readonly maxToolBatches?: number;
}

export interface AgentLoopOptions {
  readonly signal?: AbortSignal;
  readonly maxSteps?: number;
  readonly maxToolBatches?: number;
}

export type AgentStopReason = Exclude<StopReason, "tool-call">;

export type AgentEvent =
  | {
      type: "start";
    }
  | {
      type: "retry";
      attempt: number;
      maxRetries: number;
      delayMs: number;
      error: Error;
    }
  | {
      type: "compaction-start";
      tokensBefore: number;
    }
  | {
      type: "compaction-done";
      tokensBefore: number;
      tokensAfter: number;
    }
  | {
      type: "text-delta";
      delta: string;
    }
  | {
      type: "tool-call";
      toolCall: ToolCall;
    }
  | {
      type: "message-checkpoint";
      message: AssistantMessage;
    }
  | {
      type: "tool-result";
      result: ToolResult;
      message: ToolResultMessage;
    }
  | {
      type: "done";
      reason: AgentStopReason;
      newMessages: readonly Message[];
    }
  | {
      type: "error";
      reason: ErrorReason;
      error: Error;
    };
