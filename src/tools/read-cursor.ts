import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export interface ReadCursorPayload {
  readonly version: 1;
  readonly rootHash: string;
  readonly relativePath: string;
  readonly realPathHash: string;
  readonly offsetBytes: number;
  readonly file: {
    readonly dev: string;
    readonly ino: string;
    readonly size: string;
    readonly mtimeNs: string;
    readonly ctimeNs: string;
  };
  readonly expiresAtMs: number;
}

export interface ReadCursorCodecOptions {
  readonly key: Uint8Array;
  readonly rootHash: string;
  readonly now?: () => number;
}

export class InvalidReadCursorError extends Error {
  constructor() {
    super("Invalid read cursor.");
    this.name = "InvalidReadCursorError";
  }
}

export class ExpiredReadCursorError extends Error {
  constructor() {
    super("Expired read cursor.");
    this.name = "ExpiredReadCursorError";
  }
}

export class ReadCursorCodec {
  readonly #key: Buffer;
  readonly #rootHash: string;
  readonly #now: () => number;

  constructor(options: ReadCursorCodecOptions) {
    if (options.key.byteLength !== 32) {
      throw new Error("Read cursor key must contain exactly 32-byte key material.");
    }
    if (options.rootHash.length === 0) {
      throw new Error("Read cursor root hash must not be empty.");
    }
    this.#key = Buffer.from(options.key);
    this.#rootHash = options.rootHash;
    this.#now = options.now ?? Date.now;
  }

  encode(payload: ReadCursorPayload): string {
    try {
      assertPayload(payload);
      if (payload.rootHash !== this.#rootHash) throw new InvalidReadCursorError();
      const encodedPayload = Buffer.from(canonicalPayload(payload), "utf8")
        .toString("base64url");
      const signature = this.#sign(encodedPayload).toString("base64url");
      return `${encodedPayload}.${signature}`;
    } catch (error: unknown) {
      if (error instanceof InvalidReadCursorError) throw error;
      throw new InvalidReadCursorError();
    }
  }

  decode(
    cursor: string,
    expected?: { readonly relativePath?: string },
  ): ReadCursorPayload {
    try {
      const parts = cursor.split(".");
      if (parts.length !== 2) throw new InvalidReadCursorError();
      const [encodedPayload, encodedSignature] = parts;
      if (
        encodedPayload === undefined ||
        encodedSignature === undefined ||
        !isCanonicalBase64Url(encodedPayload) ||
        !isCanonicalBase64Url(encodedSignature)
      ) {
        throw new InvalidReadCursorError();
      }
      const actualSignature = Buffer.from(encodedSignature, "base64url");
      const expectedSignature = this.#sign(encodedPayload);
      if (
        actualSignature.byteLength !== expectedSignature.byteLength ||
        !timingSafeEqual(actualSignature, expectedSignature)
      ) {
        throw new InvalidReadCursorError();
      }

      const parsed: unknown = JSON.parse(
        Buffer.from(encodedPayload, "base64url").toString("utf8"),
      );
      assertPayload(parsed);
      if (
        parsed.rootHash !== this.#rootHash ||
        (expected?.relativePath !== undefined &&
          parsed.relativePath !== expected.relativePath)
      ) {
        throw new InvalidReadCursorError();
      }
      if (parsed.expiresAtMs <= this.#now()) throw new ExpiredReadCursorError();
      return parsed;
    } catch (error: unknown) {
      if (error instanceof ExpiredReadCursorError) throw error;
      throw new InvalidReadCursorError();
    }
  }

  #sign(encodedPayload: string): Buffer {
    return createHmac("sha256", this.#key).update(encodedPayload, "ascii").digest();
  }
}

export class FileReadCursorKeyStore {
  readonly filePath: string;

  constructor(rootDir: string) {
    this.filePath = join(rootDir, "sessions", ".read-cursor-key");
  }

  async loadOrCreate(): Promise<Buffer> {
    await mkdir(dirname(this.filePath), { recursive: true });
    try {
      const key = randomBytes(32);
      await writeFile(this.filePath, key, { flag: "wx", mode: 0o600 });
      return key;
    } catch (error: unknown) {
      if (!isNodeError(error, "EEXIST")) throw error;
    }
    const key = await readFile(this.filePath);
    if (key.byteLength !== 32) {
      throw new Error("Read cursor key file must contain exactly 32 bytes.");
    }
    return key;
  }
}

export function hashReadCursorValue(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function canonicalPayload(payload: ReadCursorPayload): string {
  return JSON.stringify({
    version: payload.version,
    rootHash: payload.rootHash,
    relativePath: payload.relativePath,
    realPathHash: payload.realPathHash,
    offsetBytes: payload.offsetBytes,
    file: {
      dev: payload.file.dev,
      ino: payload.file.ino,
      size: payload.file.size,
      mtimeNs: payload.file.mtimeNs,
      ctimeNs: payload.file.ctimeNs,
    },
    expiresAtMs: payload.expiresAtMs,
  });
}

function assertPayload(value: unknown): asserts value is ReadCursorPayload {
  if (!isRecord(value) || !hasExactKeys(value, [
    "version",
    "rootHash",
    "relativePath",
    "realPathHash",
    "offsetBytes",
    "file",
    "expiresAtMs",
  ])) {
    throw new InvalidReadCursorError();
  }
  if (
    value.version !== 1 ||
    !isNonEmptyString(value.rootHash) ||
    !isNonEmptyString(value.relativePath) ||
    !isNonEmptyString(value.realPathHash) ||
    !Number.isSafeInteger(value.offsetBytes) ||
    (value.offsetBytes as number) < 0 ||
    !Number.isSafeInteger(value.expiresAtMs) ||
    (value.expiresAtMs as number) < 0 ||
    !isRecord(value.file) ||
    !hasExactKeys(value.file, ["dev", "ino", "size", "mtimeNs", "ctimeNs"])
  ) {
    throw new InvalidReadCursorError();
  }
  for (const field of ["dev", "ino", "size", "mtimeNs", "ctimeNs"] as const) {
    if (typeof value.file[field] !== "string" || !/^\d+$/.test(value.file[field])) {
      throw new InvalidReadCursorError();
    }
  }
}

function isCanonicalBase64Url(value: string): boolean {
  if (value.length === 0 || !/^[A-Za-z0-9_-]+$/.test(value)) return false;
  try {
    return Buffer.from(value, "base64url").toString("base64url") === value;
  } catch {
    return false;
  }
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length &&
    actual.every((key, index) => key === expected[index]);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return typeof error === "object" && error !== null &&
    "code" in error && error.code === code;
}
