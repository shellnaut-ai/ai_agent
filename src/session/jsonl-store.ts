import { randomUUID } from "node:crypto";
import {
  appendFile,
  mkdir,
  readFile,
  stat,
  truncate,
  writeFile,
} from "node:fs/promises";
import { resolve } from "node:path";

import type {
  AssistantContinuationSegment,
  AssistantMessage,
  JsonValue,
  Message,
  Model,
  ProviderId,
  ProviderMessageState,
  ToolResultMessage,
  UserMessage,
} from "../model/types.js";
import type { ToolCall } from "../tools/types.js";
import type {
  CompactionEntry,
  LeafEntry,
  LoadedSession,
  MessageEntry,
  SessionApprovalRecord,
  SessionEntry,
  SessionHeaderRecord,
  SessionStore,
} from "./types.js";
import { assertValidSessionId } from "./session-id.js";
import {
  SessionWriterLockCompromisedError,
  withSessionWriterLock,
} from "./writer-lock.js";

export interface JsonlSessionStoreOptions {
  readonly rootDir: string;
  readonly sessionId: string;
  readonly model: Model;
  readonly writerLockTimeoutMs?: number;
}

interface EntryBaseFields {
  readonly id: string;
  readonly parentId: string | null;
  readonly timestamp: string;
}

interface JsonlSourceLine {
  readonly line: string;
  readonly lineNumber: number;
  readonly startOffset: number;
  readonly terminated: boolean;
}

function splitJsonlSourceLines(content: string): JsonlSourceLine[] {
  const lines: JsonlSourceLine[] = [];
  let startOffset = 0;
  let lineNumber = 1;

  while (startOffset < content.length) {
    const newlineOffset = content.indexOf("\n", startOffset);
    const terminated = newlineOffset >= 0;
    const endOffset = terminated ? newlineOffset : content.length;
    let line = content.slice(startOffset, endOffset);

    if (line.endsWith("\r")) {
      line = line.slice(0, -1);
    }

    lines.push({ line, lineNumber, startOffset, terminated });

    if (!terminated) {
      break;
    }

    startOffset = newlineOffset + 1;
    lineNumber += 1;
  }

  return lines;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPlainJsonObject(
  value: unknown,
): value is Record<string, unknown> {
  if (!isRecord(value)) {
    return false;
  }

  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isProviderId(value: unknown): value is ProviderId {
  return (
    value === "codex" ||
    value === "claude" ||
    value === "llama" ||
    value === "fake" ||
    value === "openai-compatible" ||
    value === "openai-codex"
  );
}

function parseJsonValue(value: unknown): JsonValue {
  if (
    value === null ||
    typeof value === "boolean" ||
    typeof value === "string"
  ) {
    return value;
  }

  if (typeof value === "number") {
    if (Number.isFinite(value)) {
      return value;
    }

    throw new Error("Provider state must contain only finite numbers.");
  }

  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      if (!Object.hasOwn(value, index)) {
        throw new Error("Provider state must not contain sparse arrays.");
      }
    }

    return value.map(parseJsonValue);
  }

  if (isPlainJsonObject(value)) {
    const result: Record<string, JsonValue> = {};

    for (const [key, item] of Object.entries(value)) {
      Object.defineProperty(result, key, {
        value: parseJsonValue(item),
        enumerable: true,
        configurable: true,
        writable: true,
      });
    }

    return result;
  }

  throw new Error("Provider state must contain only JSON-compatible values.");
}

function parseProviderState(value: unknown): ProviderMessageState {
  if (!isPlainJsonObject(value) || !isProviderId(value.provider)) {
    throw new Error("Invalid provider state in session file.");
  }

  if (!("value" in value)) {
    throw new Error("Invalid provider state in session file.");
  }

  return {
    provider: value.provider,
    value: parseJsonValue(value.value),
  };
}

function parseAssistantContinuation(
  value: unknown,
): AssistantContinuationSegment {
  if (
    !isPlainJsonObject(value) ||
    Object.keys(value).length !== 6 ||
    typeof value.logicalMessageId !== "string" ||
    value.logicalMessageId.length === 0 ||
    !Number.isInteger(value.segmentIndex) ||
    (value.segmentIndex as number) < 0 ||
    (value.status !== "partial" &&
      value.status !== "complete" &&
      value.status !== "abandoned") ||
    typeof value.resumeAllowed !== "boolean" ||
    typeof value.tailHash !== "string" ||
    !/^[a-f0-9]{64}$/.test(value.tailHash) ||
    !Number.isInteger(value.estimatedTotalOutputTokens) ||
    (value.estimatedTotalOutputTokens as number) < 0 ||
    ![
      "logicalMessageId",
      "segmentIndex",
      "status",
      "resumeAllowed",
      "tailHash",
      "estimatedTotalOutputTokens",
    ].every((key) => Object.hasOwn(value, key)) ||
    (value.status !== "partial" && value.resumeAllowed)
  ) {
    throw new Error("Invalid assistant continuation metadata in session file.");
  }
  return {
    logicalMessageId: value.logicalMessageId,
    segmentIndex: value.segmentIndex as number,
    status: value.status,
    resumeAllowed: value.resumeAllowed,
    tailHash: value.tailHash,
    estimatedTotalOutputTokens: value.estimatedTotalOutputTokens as number,
  };
}

function isFileNotFound(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    error.code === "ENOENT"
  );
}

function parseTimestamp(value: unknown, field: string): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    !Number.isFinite(Date.parse(value))
  ) {
    throw new Error(`Invalid ${field} in session file.`);
  }

  return value;
}

function parseToolCall(value: unknown): ToolCall {
  if (
    !isRecord(value) ||
    typeof value.id !== "string" ||
    typeof value.name !== "string" ||
    !("arguments" in value) ||
    value.arguments === undefined
  ) {
    throw new Error("Invalid ToolCall in session file.");
  }

  return {
    id: value.id,
    name: value.name,
    arguments: structuredClone(value.arguments),
  };
}

function parseMessage(value: unknown): Message {
  if (!isRecord(value) || typeof value.role !== "string") {
    throw new Error("Invalid message in session file.");
  }

  if (value.role === "user" && typeof value.content === "string") {
    const message: UserMessage = {
      role: "user",
      content: value.content,
    };

    return message;
  }

  if (
    value.role === "assistant" &&
    typeof value.content === "string" &&
    Array.isArray(value.toolCalls)
  ) {
    const providerState =
      "providerState" in value
        ? parseProviderState(value.providerState)
        : undefined;
    const continuation =
      "continuation" in value
        ? parseAssistantContinuation(value.continuation)
        : undefined;
    const message: AssistantMessage = {
      role: "assistant",
      content: value.content,
      toolCalls: value.toolCalls.map(parseToolCall),
      ...(providerState === undefined ? {} : { providerState }),
      ...(continuation === undefined ? {} : { continuation }),
    };

    if (
      continuation?.status === "abandoned" &&
      (message.content !== "" ||
        message.toolCalls.length > 0 ||
        message.providerState !== undefined)
    ) {
      throw new Error("Invalid abandoned continuation tombstone in session file.");
    }

    return message;
  }

  if (
    value.role === "tool" &&
    typeof value.toolCallId === "string" &&
    typeof value.content === "string" &&
    typeof value.isError === "boolean"
  ) {
    const message: ToolResultMessage = {
      role: "tool",
      toolCallId: value.toolCallId,
      content: value.content,
      isError: value.isError,
    };

    return message;
  }

  throw new Error("Invalid message in session file.");
}

function parseStringArray(value: unknown, field: string): string[] {
  if (
    !Array.isArray(value) ||
    value.some((item) => typeof item !== "string")
  ) {
    throw new Error(`Invalid ${field} in session compaction entry.`);
  }

  return [...value];
}

function parseEntryBase(value: Record<string, unknown>): EntryBaseFields {
  if (typeof value.id !== "string" || value.id.length === 0) {
    throw new Error("Invalid session entry ID.");
  }

  if (
    value.parentId !== null &&
    typeof value.parentId !== "string"
  ) {
    throw new Error(`Invalid parentId for session entry "${value.id}".`);
  }

  return {
    id: value.id,
    parentId: value.parentId,
    timestamp: parseTimestamp(
      value.timestamp,
      `timestamp for session entry "${value.id}"`,
    ),
  };
}

function parseSessionEntry(value: unknown): SessionEntry {
  if (!isRecord(value) || typeof value.type !== "string") {
    throw new Error("Invalid session entry.");
  }

  const base = parseEntryBase(value);

  if (value.type === "message") {
    const entry: MessageEntry = {
      type: "message",
      ...base,
      message: parseMessage(value.message),
    };

    return entry;
  }

  if (value.type === "compaction") {
    if (
      typeof value.summary !== "string" ||
      value.summary.trim().length === 0 ||
      typeof value.firstKeptEntryId !== "string" ||
      value.firstKeptEntryId.length === 0 ||
      typeof value.tokensBefore !== "number" ||
      !Number.isFinite(value.tokensBefore) ||
      value.tokensBefore < 0 ||
      !isRecord(value.details)
    ) {
      throw new Error(
        `Invalid compaction entry "${base.id}" in session file.`,
      );
    }

    const entry: CompactionEntry = {
      type: "compaction",
      ...base,
      summary: value.summary,
      firstKeptEntryId: value.firstKeptEntryId,
      tokensBefore: value.tokensBefore,
      details: {
        readFiles: parseStringArray(
          value.details.readFiles,
          "readFiles",
        ),
        modifiedFiles: parseStringArray(
          value.details.modifiedFiles,
          "modifiedFiles",
        ),
      },
    };

    return entry;
  }

  if (value.type === "leaf") {
    if (
      typeof value.targetId !== "string" ||
      value.targetId.length === 0
    ) {
      throw new Error(
        `Invalid targetId for leaf entry "${base.id}".`,
      );
    }

    const entry: LeafEntry = {
      type: "leaf",
      ...base,
      targetId: value.targetId,
    };

    return entry;
  }

  throw new Error(`Unknown session entry type "${String(value.type)}".`);
}

function cloneEntry(entry: SessionEntry): SessionEntry {
  return structuredClone(entry);
}

function leafIdAfterEntry(entry: SessionEntry): string {
  return entry.type === "leaf" ? entry.targetId : entry.id;
}

function pathContains(
  entriesById: ReadonlyMap<string, SessionEntry>,
  leafId: string,
  targetId: string,
): boolean {
  const visited = new Set<string>();
  let currentId: string | null = leafId;

  while (currentId !== null) {
    if (visited.has(currentId)) {
      throw new Error(
        `Cycle detected at session entry "${currentId}".`,
      );
    }

    visited.add(currentId);

    if (currentId === targetId) {
      return true;
    }

    const entry = entriesById.get(currentId);

    if (!entry) {
      throw new Error(`Session entry "${currentId}" was not found.`);
    }

    currentId = entry.parentId;
  }

  return false;
}

function validateEntry(
  entry: SessionEntry,
  entriesById: ReadonlyMap<string, SessionEntry>,
  currentLeafId: string | null,
): void {
  if (entriesById.has(entry.id)) {
    throw new Error(`Session entry ID "${entry.id}" is duplicated.`);
  }

  if (entry.parentId !== currentLeafId) {
    throw new Error(
      `Session entry "${entry.id}" must use the current leaf ` +
        `"${String(currentLeafId)}" as its parent.`,
    );
  }

  if (
    entry.parentId !== null &&
    !entriesById.has(entry.parentId)
  ) {
    throw new Error(
      `Parent entry "${entry.parentId}" was not found for ` +
        `"${entry.id}".`,
    );
  }

  if (
    entry.parentId === null &&
    entriesById.size > 0
  ) {
    throw new Error(
      `Only the first session entry may have a null parentId.`,
    );
  }

  parseTimestamp(
    entry.timestamp,
    `timestamp for session entry "${entry.id}"`,
  );

  if (entry.type === "message") {
    parseMessage(entry.message);
    if (
      entry.message.role === "assistant" &&
      entry.message.continuation !== undefined
    ) {
      validateContinuationTransition(
        entry.message.continuation,
        entriesById,
        entry.parentId,
      );
    }
    return;
  }

  if (entry.type === "compaction") {
    if (entry.parentId === null) {
      throw new Error("A compaction entry must have a parent.");
    }

    const firstKeptEntry = entriesById.get(entry.firstKeptEntryId);

    if (
      !firstKeptEntry ||
      firstKeptEntry.type !== "message" ||
      firstKeptEntry.message.role === "tool"
    ) {
      throw new Error(
        `Compaction entry "${entry.id}" must keep a user or assistant message.`,
      );
    }

    if (
      !pathContains(
        entriesById,
        entry.parentId,
        entry.firstKeptEntryId,
      )
    ) {
      throw new Error(
        `Compaction entry "${entry.id}" points outside its branch.`,
      );
    }

    return;
  }

  const target = entriesById.get(entry.targetId);

  if (!target || target.type === "leaf") {
    throw new Error(
      `Leaf entry "${entry.id}" points to an invalid target.`,
    );
  }
}

function validateContinuationTransition(
  continuation: AssistantContinuationSegment,
  entriesById: ReadonlyMap<string, SessionEntry>,
  parentId: string | null,
): void {
  let currentId = parentId;
  let previous: AssistantContinuationSegment | undefined;
  while (currentId !== null) {
    const entry = entriesById.get(currentId);
    if (entry === undefined) break;
    if (
      entry.type === "message" &&
      entry.message.role === "assistant" &&
      entry.message.continuation?.logicalMessageId ===
        continuation.logicalMessageId
    ) {
      previous = entry.message.continuation;
      break;
    }
    currentId = entry.parentId;
  }
  if (previous === undefined) {
    if (continuation.segmentIndex !== 0) {
      throw new Error("A continuation must begin at segment index 0.");
    }
    return;
  }
  if (
    previous.status !== "partial" ||
    continuation.segmentIndex !== previous.segmentIndex + 1 ||
    continuation.estimatedTotalOutputTokens <
      previous.estimatedTotalOutputTokens
  ) {
    throw new Error("Invalid assistant continuation status transition.");
  }
}

export class JsonlSessionStore implements SessionStore {
  readonly sessionId: string;
  readonly filePath: string;

  private readonly model: Model;
  private readonly sessionDirectory: string;
  private readonly writerLockPath: string;
  private readonly writerLockTimeoutMs: number;
  private entries: SessionEntry[] = [];
  private entriesById = new Map<string, SessionEntry>();
  private currentLeafId: string | null = null;
  private writeQueue: Promise<void> = Promise.resolve();
  private initialized = false;
  private poisonError: Error | undefined;

  constructor(options: JsonlSessionStoreOptions) {
    assertValidSessionId(options.sessionId);

    this.sessionId = options.sessionId;
    this.model = options.model;
    this.sessionDirectory = resolve(options.rootDir, "sessions");
    this.filePath = resolve(
      this.sessionDirectory,
      `${options.sessionId}.jsonl`,
    );
    this.writerLockPath = `${this.filePath}.writer.lock`;
    this.writerLockTimeoutMs = options.writerLockTimeoutMs ?? 30_000;
  }

  async load(): Promise<LoadedSession> {
    this.assertNotPoisoned();
    await mkdir(this.sessionDirectory, {
      recursive: true,
    });

    return this.runWithWriterLock(async () => this.loadFromDisk());
  }

  private async loadFromDisk(): Promise<LoadedSession> {
    let content: string;

    try {
      content = await readFile(this.filePath, "utf8");
    } catch (error: unknown) {
      if (!isFileNotFound(error)) {
        throw error;
      }

      const header: SessionHeaderRecord = {
        type: "session",
        version: 2,
        sessionId: this.sessionId,
        createdAt: new Date().toISOString(),
        model: {
          provider: this.model.provider,
          id: this.model.id,
        },
      };

      await writeFile(this.filePath, `${JSON.stringify(header)}\n`, {
        encoding: "utf8",
        flag: "wx",
        mode: 0o600,
      });

      this.entries = [];
      this.entriesById = new Map<string, SessionEntry>();
      this.currentLeafId = null;
      this.initialized = true;

      return {
        entries: [],
        leafId: null,
        approvalKeys: new Set<string>(),
      };
    }

    const lines = splitJsonlSourceLines(content)
      .filter(({ line }) => line.trim().length > 0);

    if (lines.length === 0) {
      throw new Error("Session file does not contain a header.");
    }

    let headerValue: unknown;

    try {
      headerValue = JSON.parse(lines[0].line);
    } catch {
      throw new Error("Session file does not start with a valid header.");
    }

    if (
      !isRecord(headerValue) ||
      headerValue.type !== "session"
    ) {
      throw new Error("Session file does not start with a valid header.");
    }

    if (headerValue.version !== 2) {
      throw new Error(
        `Session "${this.sessionId}" uses unsupported version ` +
          `"${String(headerValue.version)}". Start a new session.`,
      );
    }

    if (
      headerValue.sessionId !== this.sessionId ||
      typeof headerValue.createdAt !== "string" ||
      !Number.isFinite(Date.parse(headerValue.createdAt)) ||
      !isRecord(headerValue.model) ||
      headerValue.model.provider !== this.model.provider ||
      headerValue.model.id !== this.model.id
    ) {
      throw new Error("Session file contains an invalid header.");
    }

    const nextEntries: SessionEntry[] = [];
    const nextEntriesById = new Map<string, SessionEntry>();
    const approvalKeys = new Set<string>();
    let nextLeafId: string | null = null;
    let repairedIncompleteTail = false;

    for (let index = 1; index < lines.length; index += 1) {
      const {
        line,
        lineNumber,
        startOffset,
        terminated,
      } = lines[index];
      let value: unknown;

      try {
        value = JSON.parse(line);
      } catch {
        if (index === lines.length - 1 && !terminated) {
          try {
            await truncate(
              this.filePath,
              Buffer.byteLength(content.slice(0, startOffset), "utf8"),
            );
          } catch (error: unknown) {
            throw this.poison(error);
          }
          repairedIncompleteTail = true;
          break;
        }

        throw new Error(`Invalid JSONL record at line ${lineNumber}.`);
      }

      if (!isRecord(value) || typeof value.type !== "string") {
        throw new Error(`Invalid session record at line ${lineNumber}.`);
      }

      if (value.type === "session") {
        throw new Error(
          `Unexpected session header at line ${lineNumber}.`,
        );
      }

      if (value.type === "approval") {
        if (
          typeof value.key !== "string" ||
          value.key.trim().length === 0
        ) {
          throw new Error(
            `Invalid approval record at line ${lineNumber}.`,
          );
        }

        parseTimestamp(
          value.createdAt,
          `approval timestamp at line ${lineNumber}`,
        );
        approvalKeys.add(value.key);
        continue;
      }

      let entry: SessionEntry;

      try {
        entry = parseSessionEntry(value);
        validateEntry(entry, nextEntriesById, nextLeafId);
      } catch (error: unknown) {
        const message =
          error instanceof Error ? error.message : String(error);

        throw new Error(
          `Invalid session entry at line ${lineNumber}: ${message}`,
        );
      }

      const storedEntry = cloneEntry(entry);
      nextEntries.push(storedEntry);
      nextEntriesById.set(storedEntry.id, storedEntry);
      nextLeafId = leafIdAfterEntry(storedEntry);
    }

    if (!repairedIncompleteTail && !content.endsWith("\n")) {
      await this.appendContentSafely("\n");
    }

    this.entries = nextEntries;
    this.entriesById = nextEntriesById;
    this.currentLeafId = nextLeafId;
    this.initialized = true;

    return {
      entries: this.getEntries(),
      leafId: this.currentLeafId,
      approvalKeys,
    };
  }

  createEntryId(): string {
    this.assertInitialized();

    for (let attempt = 0; attempt < 100; attempt += 1) {
      const id = randomUUID();

      if (!this.entriesById.has(id)) {
        return id;
      }
    }

    throw new Error("Could not generate a unique session entry ID.");
  }

  async appendEntry(entry: SessionEntry): Promise<void> {
    await this.appendEntries([entry]);
  }

  async appendEntries(entries: readonly SessionEntry[]): Promise<void> {
    this.assertInitialized();

    if (entries.length === 0) {
      return;
    }

    const parsedEntries = entries.map(parseSessionEntry);

    await this.enqueueWrite(async () => {
      await this.runWithWriterLock(async () => {
        await this.loadFromDisk();
        await this.appendEntriesNow(parsedEntries);
      });
    });
  }

  private async appendEntriesNow(
    entries: readonly SessionEntry[],
  ): Promise<void> {
    const nextEntriesById = new Map(this.entriesById);
    let nextLeafId = this.currentLeafId;
    const storedEntries: SessionEntry[] = [];

    for (const entry of entries) {
      const storedEntry = cloneEntry(entry);
      validateEntry(storedEntry, nextEntriesById, nextLeafId);
      storedEntries.push(storedEntry);
      nextEntriesById.set(storedEntry.id, storedEntry);
      nextLeafId = leafIdAfterEntry(storedEntry);
    }

    const content = storedEntries
      .map((entry) => JSON.stringify(entry))
      .join("\n");

    await this.appendContentSafely(`${content}\n`);

    this.entries.push(...storedEntries);

    for (const entry of storedEntries) {
      this.entriesById.set(entry.id, entry);
    }

    this.currentLeafId = nextLeafId;
  }

  getEntry(id: string): SessionEntry | undefined {
    this.assertInitialized();
    const entry = this.entriesById.get(id);
    return entry ? cloneEntry(entry) : undefined;
  }

  getEntries(): readonly SessionEntry[] {
    this.assertInitialized();
    return this.entries.map(cloneEntry);
  }

  getLeafId(): string | null {
    this.assertInitialized();
    return this.currentLeafId;
  }

  getPathToRoot(
    leafId?: string | null,
  ): readonly SessionEntry[] {
    this.assertInitialized();

    const targetLeafId =
      leafId === undefined ? this.currentLeafId : leafId;

    if (targetLeafId === null) {
      return [];
    }

    const path: SessionEntry[] = [];
    const visited = new Set<string>();
    let currentId: string | null = targetLeafId;

    while (currentId !== null) {
      if (visited.has(currentId)) {
        throw new Error(
          `Cycle detected at session entry "${currentId}".`,
        );
      }

      visited.add(currentId);

      const entry = this.entriesById.get(currentId);

      if (!entry) {
        throw new Error(
          `Session entry "${currentId}" was not found.`,
        );
      }

      path.push(cloneEntry(entry));
      currentId = entry.parentId;
    }

    return path.reverse();
  }

  async setLeafId(leafId: string): Promise<void> {
    this.assertInitialized();

    await this.enqueueWrite(async () => {
      await this.runWithWriterLock(async () => {
        await this.loadFromDisk();
        const target = this.entriesById.get(leafId);

        if (!target || target.type === "leaf") {
          throw new Error(
            `Session leaf target "${leafId}" was not found.`,
          );
        }

        const entry: LeafEntry = {
          type: "leaf",
          id: this.createEntryId(),
          parentId: this.currentLeafId,
          timestamp: new Date().toISOString(),
          targetId: leafId,
        };

        await this.appendEntriesNow([entry]);
      });
    });
  }

  async appendApproval(key: string): Promise<void> {
    this.assertInitialized();

    if (key.trim().length === 0) {
      throw new Error("Session approval key must not be empty.");
    }

    const record: SessionApprovalRecord = {
      type: "approval",
      key,
      createdAt: new Date().toISOString(),
    };

    await this.enqueueWrite(async () => {
      await this.runWithWriterLock(async () => {
        await this.loadFromDisk();
        await this.appendContentSafely(`${JSON.stringify(record)}\n`);
      });
    });
  }

  private async enqueueWrite(operation: () => Promise<void>): Promise<void> {
    const result = this.writeQueue.then(() => {
      this.assertNotPoisoned();
      return operation();
    });

    this.writeQueue = result.catch(() => {
      return;
    });

    await result;
  }

  private assertInitialized(): void {
    if (!this.initialized) {
      throw new Error(
        "Session store must be loaded before it can be used.",
      );
    }
  }

  private async appendContentSafely(content: string): Promise<void> {
    this.assertNotPoisoned();
    const committedEof = (await stat(this.filePath)).size;

    try {
      await appendFile(this.filePath, content, { encoding: "utf8" });
    } catch (appendError: unknown) {
      try {
        await truncate(this.filePath, committedEof);
      } catch (rollbackError: unknown) {
        throw this.poison(
          new AggregateError(
            [appendError, rollbackError],
            "Session append failed and rollback to the committed EOF failed.",
          ),
        );
      }

      throw appendError;
    }
  }

  private async runWithWriterLock<T>(
    operation: () => Promise<T>,
  ): Promise<T> {
    this.assertNotPoisoned();

    try {
      return await withSessionWriterLock(
        this.writerLockPath,
        operation,
        { timeoutMs: this.writerLockTimeoutMs },
      );
    } catch (error: unknown) {
      if (error instanceof SessionWriterLockCompromisedError) {
        throw this.poison(error);
      }

      throw error;
    }
  }

  private poison(cause: unknown): Error {
    if (this.poisonError === undefined) {
      this.poisonError = new Error(
        "Session store is poisoned because durable writer recovery failed. " +
          "Create a new store instance and reload the journal before continuing.",
        { cause },
      );
    }

    return this.poisonError;
  }

  private assertNotPoisoned(): void {
    if (this.poisonError !== undefined) {
      throw this.poisonError;
    }
  }
}
