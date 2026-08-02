import type { ToolCall, ToolDefinition } from "../tools/types.js";

export type ToolApprovalDecision =
  | "allow-once"
  | "allow-session"
  | "deny";

export interface ToolApprovalRequest {
  readonly toolCall: ToolCall;
  readonly definition: ToolDefinition;
}

export interface ToolApprovalOptions {
  readonly signal?: AbortSignal;
}

export interface ToolApprovalHandler {
  requestApproval(
    request: ToolApprovalRequest,
    options?: ToolApprovalOptions,
  ): Promise<ToolApprovalDecision>;
}
