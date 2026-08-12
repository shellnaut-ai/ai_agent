import type { TSchema } from "typebox";

import type { ToolResultBudget } from "../context/budget.js";

export interface ToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: TSchema;
}

export interface ToolCall {
  readonly id: string;
  readonly name: string;
  readonly arguments: unknown;
}

export interface ToolOutput {
  readonly content: string;
  readonly isError: boolean;
}

export interface ToolResult extends ToolOutput {
  readonly toolCallId: string;
}

export interface ToolExecutionOptions {
  readonly signal?: AbortSignal;
  readonly resultBudget?: ToolResultBudget;
}

export type ToolApprovalMode = "never" | "always";

export interface Tool {
  readonly definition: ToolDefinition;
  readonly approval: ToolApprovalMode;

  execute(input: unknown, options?: ToolExecutionOptions): Promise<ToolOutput>;
}

export interface PreparedToolCall {
  readonly ok: true;
  readonly tool: Tool;
  readonly originalCall: ToolCall;
  readonly executableCall: ToolCall;
}

export interface RejectedToolCall {
  readonly ok: false;
  readonly result: ToolResult;
}

export type ToolCallPreparation = PreparedToolCall | RejectedToolCall;
