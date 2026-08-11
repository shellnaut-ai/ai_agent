import { open, realpath } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";
import { Type } from "typebox";

import {
  FileReadCursorKeyStore,
  ReadCursorCodec,
  hashReadCursorValue,
  type ReadCursorPayload,
} from "./read-cursor.js";
import type {
  Tool,
  ToolDefinition,
  ToolExecutionOptions,
  ToolOutput,
} from "./types.js";
import { WorkspacePaths } from "./workspace-paths.js";

export type ReadInput =
  | { readonly path: string }
  | { readonly cursor: string };

export interface ReadPageMetadata {
  readonly version: 1;
  readonly path: string;
  readonly startByte: number;
  readonly endByte: number;
  readonly totalBytes: number;
  readonly nextCursor?: string;
}

export interface ReadToolOptions {
  readonly rootDir: string;
  readonly maxBytes?: number;
  readonly cursorKey?: Uint8Array;
  readonly cursorTtlMs?: number;
  readonly now?: () => number;
}

interface FileIdentity {
  readonly dev: string;
  readonly ino: string;
  readonly size: string;
  readonly mtimeNs: string;
  readonly ctimeNs: string;
}

const DEFAULT_CURSOR_TTL_MS = 24 * 60 * 60 * 1000;

export class ReadTool implements Tool {
  readonly approval = "never" as const;

  readonly definition: ToolDefinition = {
    name: "read",
    description:
      "Reads a UTF-8 text file inside the allowed workspace. Large files " +
      "return a signed next cursor; continue with only that cursor.",
    inputSchema: Type.Union([
      Type.Object(
        {
          path: Type.String({
            minLength: 1,
            description: "File path relative to the workspace root.",
          }),
        },
        { additionalProperties: false },
      ),
      Type.Object(
        {
          cursor: Type.String({
            minLength: 1,
            description: "Opaque next cursor returned by an earlier read page.",
          }),
        },
        { additionalProperties: false },
      ),
    ]),
  };

  readonly #rootDir: string;
  readonly #paths: WorkspacePaths;
  readonly #maxBytes: number;
  readonly #cursorKey: Uint8Array | undefined;
  readonly #cursorTtlMs: number;
  readonly #now: () => number;
  readonly #keyStore: FileReadCursorKeyStore;
  #codecPromise: Promise<{ codec: ReadCursorCodec; realRoot: string }> | undefined;

  constructor(options: ReadToolOptions) {
    this.#rootDir = resolve(options.rootDir);
    this.#paths = new WorkspacePaths(this.#rootDir);
    this.#maxBytes = options.maxBytes ?? 64 * 1024;
    this.#cursorKey = options.cursorKey === undefined
      ? undefined
      : Uint8Array.from(options.cursorKey);
    this.#cursorTtlMs = options.cursorTtlMs ?? DEFAULT_CURSOR_TTL_MS;
    this.#now = options.now ?? Date.now;
    this.#keyStore = new FileReadCursorKeyStore(this.#rootDir);

    if (!Number.isInteger(this.#maxBytes) || this.#maxBytes <= 0) {
      throw new Error("ReadTool maxBytes must be a positive integer.");
    }
    if (!Number.isInteger(this.#cursorTtlMs) || this.#cursorTtlMs <= 0) {
      throw new Error("ReadTool cursorTtlMs must be a positive integer.");
    }
    if (this.#cursorKey !== undefined && this.#cursorKey.byteLength !== 32) {
      throw new Error("Read cursor key must contain exactly 32-byte key material.");
    }
  }

  async execute(
    input: unknown,
    options?: ToolExecutionOptions,
  ): Promise<ToolOutput> {
    assertNotAborted(options?.signal);
    const parsed = parseInput(input);
    if (!parsed.ok) return { content: parsed.message, isError: true };

    try {
      const { codec, realRoot } = await this.#getCodec();
      assertNotAborted(options?.signal);
      const cursorPayload = "cursor" in parsed.input
        ? codec.decode(parsed.input.cursor)
        : undefined;
      const requestedPath = cursorPayload?.relativePath ??
        ("path" in parsed.input ? parsed.input.path : undefined);
      if (requestedPath === undefined) {
        throw new Error("Invalid read cursor.");
      }
      const targetRealPath = await this.#paths.existingFile(requestedPath);
      assertNotAborted(options?.signal);
      if (samePath(targetRealPath, resolve(realRoot, "sessions", ".read-cursor-key"))) {
        throw new Error("The read cursor key is not readable through the read tool.");
      }
      const relativePath = normalizeRelativePath(relative(realRoot, targetRealPath));
      if (
        cursorPayload !== undefined &&
        (cursorPayload.relativePath !== relativePath ||
          cursorPayload.realPathHash !== hashReadCursorValue(targetRealPath))
      ) {
        throw new Error("Stale read cursor.");
      }

      return await this.#readFilePage(
        targetRealPath,
        relativePath,
        cursorPayload,
        codec,
        hashReadCursorValue(realRoot),
        options,
      );
    } catch (error: unknown) {
      if (options?.signal?.aborted) throw error;
      return {
        content: error instanceof Error ? error.message : String(error),
        isError: true,
      };
    }
  }

  async #readFilePage(
    targetRealPath: string,
    relativePath: string,
    cursorPayload: ReadCursorPayload | undefined,
    codec: ReadCursorCodec,
    rootHash: string,
    options?: ToolExecutionOptions,
  ): Promise<ToolOutput> {
    const handle = await open(targetRealPath, "r");
    try {
      const before = await handle.stat({ bigint: true });
      assertNotAborted(options?.signal);
      const identity = fileIdentity(before);
      if (cursorPayload !== undefined && !sameIdentity(identity, cursorPayload.file)) {
        throw new Error("Stale read cursor.");
      }
      const totalBytes = safeFileSize(before.size);
      const startByte = cursorPayload?.offsetBytes ?? 0;
      if (startByte > totalBytes) throw new Error("Stale read cursor.");
      const outputLimit = resultByteLimit(this.#maxBytes, options?.resultBudget);

      if (cursorPayload === undefined && totalBytes <= outputLimit) {
        const buffer = Buffer.alloc(totalBytes);
        const { bytesRead } = await handle.read(buffer, 0, totalBytes, 0);
        assertNotAborted(options?.signal);
        if (bytesRead !== totalBytes) throw new Error("Stale read cursor.");
        const content = decodeUtf8(buffer, true).text;
        const after = await handle.stat({ bigint: true });
        assertNotAborted(options?.signal);
        if (!sameIdentity(identity, fileIdentity(after))) {
          throw new Error("Stale read cursor.");
        }
        return { content, isError: false };
      }

      const remaining = totalBytes - startByte;
      if (remaining === 0) {
        throw new Error("Stale read cursor.");
      }
      const buffer = Buffer.alloc(Math.min(remaining, outputLimit));
      const { bytesRead } = await handle.read(
        buffer,
        0,
        buffer.byteLength,
        startByte,
      );
      assertNotAborted(options?.signal);
      if (bytesRead === 0) throw new Error("Stale read cursor.");
      const page = this.#fitPage({
        bytes: buffer.subarray(0, bytesRead),
        startByte,
        totalBytes,
        relativePath,
        targetRealPath,
        identity,
        codec,
        rootHash,
        outputLimit,
      });
      const after = await handle.stat({ bigint: true });
      assertNotAborted(options?.signal);
      if (!sameIdentity(identity, fileIdentity(after))) {
        throw new Error("Stale read cursor.");
      }
      return { content: page, isError: false };
    } finally {
      await handle.close();
    }
  }

  #fitPage(input: {
    readonly bytes: Buffer;
    readonly startByte: number;
    readonly totalBytes: number;
    readonly relativePath: string;
    readonly targetRealPath: string;
    readonly identity: FileIdentity;
    readonly codec: ReadCursorCodec;
    readonly rootHash: string;
    readonly outputLimit: number;
  }): string {
    let candidateBytes = input.bytes.byteLength;
    while (candidateBytes > 0) {
      const decoded = decodeUtf8(
        input.bytes.subarray(0, candidateBytes),
        input.startByte + candidateBytes === input.totalBytes,
      );
      if (decoded.bytes === 0) break;
      const endByte = input.startByte + decoded.bytes;
      const nextCursor = endByte < input.totalBytes
        ? input.codec.encode({
            version: 1,
            rootHash: input.rootHash,
            relativePath: input.relativePath,
            realPathHash: hashReadCursorValue(input.targetRealPath),
            offsetBytes: endByte,
            file: input.identity,
            expiresAtMs: this.#now() + this.#cursorTtlMs,
          })
        : undefined;
      const metadata: ReadPageMetadata = {
        version: 1,
        path: input.relativePath,
        startByte: input.startByte,
        endByte,
        totalBytes: input.totalBytes,
        ...(nextCursor === undefined ? {} : { nextCursor }),
      };
      const output = `${decoded.text}\n\n<read-page>${JSON.stringify(metadata)}</read-page>`;
      const overflow = Buffer.byteLength(output, "utf8") - input.outputLimit;
      if (overflow <= 0) return output;
      candidateBytes = decoded.bytes - overflow;
    }
    throw new Error(
      `Read result budget of ${input.outputLimit} bytes is too small for page metadata.`,
    );
  }

  async #getCodec(): Promise<{ codec: ReadCursorCodec; realRoot: string }> {
    this.#codecPromise ??= (async () => {
      const [realRoot, key] = await Promise.all([
        realpath(this.#rootDir),
        this.#cursorKey === undefined
          ? this.#keyStore.loadOrCreate()
          : Promise.resolve(Buffer.from(this.#cursorKey)),
      ]);
      return {
        realRoot,
        codec: new ReadCursorCodec({
          key,
          rootHash: hashReadCursorValue(realRoot),
          now: this.#now,
        }),
      };
    })();
    return await this.#codecPromise;
  }
}

function parseInput(input: unknown):
  | { readonly ok: true; readonly input: ReadInput }
  | { readonly ok: false; readonly message: string } {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return { ok: false, message: "read input must be an object." };
  }
  const path = Reflect.get(input, "path");
  const cursor = Reflect.get(input, "cursor");
  const hasPath = typeof path === "string" && path.trim().length > 0;
  const hasCursor = typeof cursor === "string" && cursor.length > 0;
  if (hasPath === hasCursor) {
    return {
      ok: false,
      message: "read input must contain exactly one of path or cursor.",
    };
  }
  return hasPath
    ? { ok: true, input: { path } }
    : { ok: true, input: { cursor } };
}

function decodeUtf8(
  bytes: Buffer,
  mustConsumeAll: boolean,
): { readonly text: string; readonly bytes: number } {
  const minimum = mustConsumeAll ? bytes.byteLength : Math.max(0, bytes.byteLength - 3);
  for (let end = bytes.byteLength; end >= minimum; end -= 1) {
    try {
      return {
        text: new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, end)),
        bytes: end,
      };
    } catch {
      if (mustConsumeAll) break;
    }
  }
  throw new Error("File content is not valid UTF-8.");
}

function fileIdentity(stats: {
  readonly dev: bigint;
  readonly ino: bigint;
  readonly size: bigint;
  readonly mtimeNs: bigint;
  readonly ctimeNs: bigint;
}): FileIdentity {
  return {
    dev: stats.dev.toString(),
    ino: stats.ino.toString(),
    size: stats.size.toString(),
    mtimeNs: stats.mtimeNs.toString(),
    ctimeNs: stats.ctimeNs.toString(),
  };
}

function sameIdentity(left: FileIdentity, right: FileIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino &&
    left.size === right.size && left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs;
}

function safeFileSize(size: bigint): number {
  if (size < 0n || size > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error("File is too large to page safely.");
  }
  return Number(size);
}

function resultByteLimit(
  configuredMaxBytes: number,
  budget: ToolExecutionOptions["resultBudget"],
): number {
  if (budget === undefined) return configuredMaxBytes;
  if (
    !Number.isInteger(budget.maxBytes) || budget.maxBytes <= 0 ||
    !Number.isInteger(budget.maxTokens) || budget.maxTokens <= 0
  ) {
    throw new Error("Tool result budget must contain positive integer limits.");
  }
  return Math.min(configuredMaxBytes, budget.maxBytes, budget.maxTokens * 4);
}

function normalizeRelativePath(path: string): string {
  return path.split(sep).join("/");
}

function samePath(left: string, right: string): boolean {
  return process.platform === "win32"
    ? left.toLowerCase() === right.toLowerCase()
    : left === right;
}

function assertNotAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new Error("Tool execution aborted.");
}
