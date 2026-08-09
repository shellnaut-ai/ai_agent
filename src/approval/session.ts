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
  private store: SessionStore;
  private readonly approvalKeys: Set<string>;

  constructor(options: SessionToolApprovalHandlerOptions) {
    this.delegate = options.delegate;
    this.store = options.store;
    this.approvalKeys = new Set(options.initialApprovalKeys);
  }

  replaceSession(
    store: SessionStore,
    approvalKeys?: ReadonlySet<string>,
  ): void {
    this.store = store;
    this.approvalKeys.clear();

    for (const key of approvalKeys ?? []) {
      this.approvalKeys.add(key);
    }
  }

  async requestApproval(
    request: ToolApprovalRequest,
    options?: ToolApprovalOptions,
  ): Promise<ToolApprovalDecision> {
    const key = createToolApprovalKey(request.toolCall);
    const store = this.store;

    if (this.approvalKeys.has(key)) {
      return "allow-once";
    }

    const decision = await this.delegate.requestApproval(request, options);

    if (decision === "allow-session") {
      await store.appendApproval(key);

      if (this.store === store) {
        this.approvalKeys.add(key);
      }
    }

    return decision;
  }
}
