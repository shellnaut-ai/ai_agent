import type {
  ErrorReason,
  Message,
  Model,
  StopReason,
} from "../model/types.js";
import type { ToolCall, ToolResult } from "../tools/types.js";

export interface AgentRequest {
  readonly model: Model;
  readonly messages: readonly Message[];
}

export interface AgentLoopOptions {
  readonly signal?: AbortSignal;
  readonly maxSteps?: number;
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
      type: "text-delta";
      delta: string;
    }
  | {
      type: "tool-call";
      toolCall: ToolCall;
    }
  | {
      type: "tool-result";
      result: ToolResult;
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
