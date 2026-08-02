import type { SessionStore } from "../session/types.js";
import { createToolApprovalKey } from "./key.js";
import type {
  ToolApprovalDecision,
  ToolApprovalHandler,
  ToolApprovalOptions,
  ToolApprovalRequest,
} from "./types.js";

export interface SessionToolApprovalHandlerOptions {
  readonly delegate: ToolApprovalHandler;
  readonly store: SessionStore;
  readonly initialApprovalKeys?: ReadonlySet<string>;
}

export class SessionToolApprovalHandler implements ToolApprovalHandler {
  private readonly delegate: ToolApprovalHandler;
  private readonly store: SessionStore;
  private readonly approvalKeys: Set<string>;

  constructor(options: SessionToolApprovalHandlerOptions) {
    this.delegate = options.delegate;
    this.store = options.store;
    this.approvalKeys = new Set(options.initialApprovalKeys);
  }

  async requestApproval(
    request: ToolApprovalRequest,
    options?: ToolApprovalOptions,
  ): Promise<ToolApprovalDecision> {
    const key = createToolApprovalKey(request.toolCall);

    if (this.approvalKeys.has(key)) {
      return "allow-once";
    }

    const decision = await this.delegate.requestApproval(request, options);

    if (decision === "allow-session") {
      await this.store.appendApproval(key);
      this.approvalKeys.add(key);
    }

    return decision;
  }
}
