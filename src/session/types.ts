import type { AgentEvent } from "../agent/types.js";
import type { CompactionFileDetails } from "../context/types.js";
import type { Message, Model } from "../model/types.js";

export interface SessionEntryBase {
  readonly id: string;
  readonly parentId: string | null;
  readonly timestamp: string;
}

export interface MessageEntry extends SessionEntryBase {
  readonly type: "message";
  readonly message: Message;
}

export interface CompactionEntry extends SessionEntryBase {
  readonly type: "compaction";
  readonly summary: string;
  readonly firstKeptEntryId: string;
  readonly tokensBefore: number;
  readonly details: CompactionFileDetails;
}

export interface LeafEntry extends SessionEntryBase {
  readonly type: "leaf";
  readonly targetId: string;
}

export type SessionEntry =
  | MessageEntry
  | CompactionEntry
  | LeafEntry;

export interface LoadedSession {
  readonly entries: readonly SessionEntry[];
  readonly leafId: string | null;
  readonly approvalKeys: ReadonlySet<string>;
}

export interface SessionStore {
  readonly sessionId: string;
  readonly filePath: string;

  load(): Promise<LoadedSession>;
  createEntryId(): string;
  appendEntry(entry: SessionEntry): Promise<void>;
  appendEntries(entries: readonly SessionEntry[]): Promise<void>;
  getEntry(id: string): SessionEntry | undefined;
  getEntries(): readonly SessionEntry[];
  getLeafId(): string | null;
  getPathToRoot(leafId?: string | null): readonly SessionEntry[];
  setLeafId(leafId: string): Promise<void>;
  appendApproval(key: string): Promise<void>;
}

export interface SessionHeaderRecord {
  readonly type: "session";
  readonly version: 2;
  readonly sessionId: string;
  readonly createdAt: string;
  readonly model: Pick<Model, "provider" | "id">;
}

export interface SessionApprovalRecord {
  readonly type: "approval";
  readonly key: string;
  readonly createdAt: string;
}

export type SessionRecord =
  | SessionHeaderRecord
  | SessionEntry
  | SessionApprovalRecord;

export type ChatEvent =
  | AgentEvent
  | {
      readonly type: "compaction-start";
      readonly tokensBefore: number;
    }
  | {
      readonly type: "compaction-done";
      readonly tokensBefore: number;
      readonly tokensAfter: number;
    };
