import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import type { BigIntStats } from "node:fs";
import {
  lstat,
  mkdir,
  open,
  readFile,
  rename,
  rm,
} from "node:fs/promises";
import { hostname } from "node:os";
import { join } from "node:path";

import { posixProcessIsRunnable } from "../tools/process-tree.js";

export interface SessionWriterLockOptions {
  readonly timeoutMs?: number;
}

export class SessionWriterLockCompromisedError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "SessionWriterLockCompromisedError";
  }
}

interface LockLease {
  release(): Promise<void>;
}

const inProcessTails = new Map<string, Promise<void>>();

/** Internal deterministic filesystem seam; not exported from the package root. */
export const sessionWriterLockRuntime: {
  publishPosixCandidate(candidatePath: string, lockPath: string): Promise<void>;
} = {
  async publishPosixCandidate(
    candidatePath: string,
    lockPath: string,
  ): Promise<void> {
    await rename(candidatePath, lockPath);
  },
};

interface PosixLeaseRecord {
  readonly version: 1;
  readonly token: string;
  readonly pid: number;
  readonly host: string;
}

interface PosixLeaseCandidate {
  readonly path: string;
  readonly record: PosixLeaseRecord;
}

const POSIX_OWNER_FILE = "owner.json";
const POSIX_TOKEN_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

const WINDOWS_HOLDER = String.raw`
$ErrorActionPreference = 'Stop'
$lockPath = $env:PI_CLONE_SESSION_LOCK_PATH
$token = $env:PI_CLONE_SESSION_LOCK_TOKEN
$timeoutMs = [int]$env:PI_CLONE_SESSION_LOCK_TIMEOUT_MS
$deadline = [DateTime]::UtcNow.AddMilliseconds($timeoutMs)
$stream = $null
while ($null -eq $stream) {
  try {
    $stream = [IO.File]::Open(
      $lockPath,
      [IO.FileMode]::OpenOrCreate,
      [IO.FileAccess]::ReadWrite,
      [IO.FileShare]::None)
  } catch [IO.IOException] {
    if ([DateTime]::UtcNow -ge $deadline) {
      exit 23
    }
    Start-Sleep -Milliseconds 10
  }
}
try {
  [Console]::Out.WriteLine($token)
  [Console]::Out.Flush()
  [Console]::In.ReadLine() | Out-Null
} finally {
  $stream.Dispose()
}
`;

export async function withSessionWriterLock<T>(
  lockPath: string,
  operation: () => Promise<T>,
  options: SessionWriterLockOptions = {},
): Promise<T> {
  const timeoutMs = options.timeoutMs ?? 30_000;

  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error("Session writer lock timeout must be positive.");
  }

  return serializeInProcess(lockPath, async () => {
    const lease = await acquireOsLease(lockPath, timeoutMs);
    let result: T | undefined;
    let operationError: unknown;
    let operationFailed = false;

    try {
      result = await operation();
    } catch (error: unknown) {
      operationFailed = true;
      operationError = error;
    }

    try {
      await lease.release();
    } catch (releaseError: unknown) {
      throw new SessionWriterLockCompromisedError(
        `Session writer lock release failed for ${lockPath}.`,
        {
          cause:
            !operationFailed
              ? releaseError
              : new AggregateError(
                  [operationError, releaseError],
                  "The session operation and writer-lock release both failed.",
                ),
        },
      );
    }

    if (operationFailed) {
      throw operationError;
    }

    return result as T;
  });
}

async function serializeInProcess<T>(
  key: string,
  operation: () => Promise<T>,
): Promise<T> {
  const predecessor = inProcessTails.get(key) ?? Promise.resolve();
  let releaseQueue: (() => void) | undefined;
  const current = new Promise<void>((resolve) => {
    releaseQueue = resolve;
  });
  const tail = predecessor.then(() => current);
  inProcessTails.set(key, tail);
  await predecessor;

  try {
    return await operation();
  } finally {
    releaseQueue?.();

    if (inProcessTails.get(key) === tail) {
      inProcessTails.delete(key);
    }
  }
}

async function acquireOsLease(
  lockPath: string,
  timeoutMs: number,
): Promise<LockLease> {
  if (process.platform !== "win32") {
    return acquirePosixDirectoryLease(lockPath, timeoutMs);
  }

  const token = randomUUID();
  const child = spawnWindowsHolder(lockPath, token, timeoutMs);

  try {
    await waitForAcquisition(child, token, timeoutMs);
  } catch (error: unknown) {
    child.kill();
    await waitForClose(child).catch(() => undefined);
    throw error;
  }

  let released = false;

  return {
    async release(): Promise<void> {
      if (released) {
        return;
      }

      released = true;
      child.stdin.end("release\n");
      const terminal = await waitForClose(child);

      if (terminal.code !== 0) {
        throw new Error(
          `Session writer lock holder exited with code ${String(terminal.code)}` +
            formatStderr(terminal.stderr),
        );
      }
    },
  };
}

async function acquirePosixDirectoryLease(
  lockPath: string,
  timeoutMs: number,
): Promise<LockLease> {
  await rejectLegacyRegularLockFile(lockPath);
  const candidate = await createPosixLeaseCandidate(lockPath);
  const deadline = performance.now() + timeoutMs;
  let firstAttempt = true;

  try {
    while (true) {
      if (!firstAttempt && performance.now() >= deadline) {
        throw new Error("Timed out waiting for session writer lock.");
      }

      try {
        await sessionWriterLockRuntime.publishPosixCandidate(
          candidate.path,
          lockPath,
        );
        break;
      } catch (error: unknown) {
        if (!isLeaseContentionError(error)) {
          throw error;
        }
      }

      firstAttempt = false;
      await recoverAbandonedPosixLease(lockPath);
      const remainingMs = deadline - performance.now();

      if (remainingMs <= 0) {
        throw new Error("Timed out waiting for session writer lock.");
      }

      await delay(Math.min(10, remainingMs));
    }
  } catch (error: unknown) {
    await removeCandidateAfterFailure(candidate.path, error);
  }

  let released = false;

  return {
    async release(): Promise<void> {
      if (released) {
        return;
      }

      released = true;
      await releasePosixDirectoryLease(lockPath, candidate.record);
    },
  };
}

async function createPosixLeaseCandidate(
  lockPath: string,
): Promise<PosixLeaseCandidate> {
  const token = randomUUID();
  const candidatePath = `${lockPath}.candidate-${token}`;
  const record: PosixLeaseRecord = {
    version: 1,
    token,
    pid: process.pid,
    host: hostname(),
  };
  await mkdir(candidatePath, { mode: 0o700 });

  try {
    const ownerFile = await open(
      join(candidatePath, POSIX_OWNER_FILE),
      "wx",
      0o600,
    );

    try {
      await ownerFile.writeFile(`${JSON.stringify(record)}\n`, "utf8");
      await ownerFile.sync();
    } finally {
      await ownerFile.close();
    }
  } catch (error: unknown) {
    await removeCandidateAfterFailure(candidatePath, error);
  }

  return { path: candidatePath, record };
}

async function recoverAbandonedPosixLease(lockPath: string): Promise<void> {
  let details: BigIntStats;

  try {
    // Classify the contended pathname in one observation. A regular legacy
    // artifact always fails closed; only a same-version directory is reaped.
    details = await lstat(lockPath, { bigint: true });
  } catch (error: unknown) {
    if (isErrorCode(error, "ENOENT")) {
      return;
    }

    throw error;
  }

  if (details.isDirectory()) {
    const record = await readPosixLeaseRecord(lockPath);

    if (record === undefined || await posixOwnerMayBeAlive(record)) {
      return;
    }

    await moveLeaseToTombstone(
      lockPath,
      `${lockPath}.reaped-${record.token}`,
    );
    return;
  }

  if (details.isFile()) {
    throw legacyRegularLockError(lockPath);
  }
}

async function rejectLegacyRegularLockFile(lockPath: string): Promise<void> {
  try {
    const details = await lstat(lockPath);

    if (details.isFile()) {
      throw legacyRegularLockError(lockPath);
    }
  } catch (error: unknown) {
    if (isErrorCode(error, "ENOENT")) {
      return;
    }

    throw error;
  }
}

function legacyRegularLockError(
  lockPath: string,
): SessionWriterLockCompromisedError {
  return new SessionWriterLockCompromisedError(
    "A legacy regular session writer lock file was found. " +
      "Quiescent upgrade required: stop every older process using this " +
      "session, verify that no old writer remains, then explicitly remove " +
      `${lockPath} before retrying. The file is never migrated automatically.`,
  );
}

async function moveLeaseToTombstone(
  lockPath: string,
  tombstonePath: string,
): Promise<void> {
  try {
    // The token-specific non-empty tombstone is intentionally retained. It
    // makes a delayed stale observer's rename fail instead of moving a newer
    // live owner (the cross-process ABA case).
    await rename(lockPath, tombstonePath);
  } catch (error: unknown) {
    if (
      isErrorCode(error, "ENOENT") ||
      isErrorCode(error, "EEXIST") ||
      isErrorCode(error, "ENOTEMPTY") ||
      isErrorCode(error, "ENOTDIR") ||
      isErrorCode(error, "EISDIR")
    ) {
      return;
    }

    throw error;
  }
}

async function readPosixLeaseRecord(
  lockPath: string,
): Promise<PosixLeaseRecord | undefined> {
  let raw: string;

  try {
    raw = await readFile(join(lockPath, POSIX_OWNER_FILE), "utf8");
  } catch (error: unknown) {
    if (
      isErrorCode(error, "ENOENT") ||
      isErrorCode(error, "ENOTDIR")
    ) {
      return undefined;
    }

    throw error;
  }

  let value: unknown;

  try {
    value = JSON.parse(raw);
  } catch {
    return undefined;
  }

  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    Reflect.get(value, "version") !== 1 ||
    typeof Reflect.get(value, "token") !== "string" ||
    !POSIX_TOKEN_PATTERN.test(Reflect.get(value, "token") as string) ||
    !Number.isInteger(Reflect.get(value, "pid")) ||
    Number(Reflect.get(value, "pid")) <= 0 ||
    typeof Reflect.get(value, "host") !== "string" ||
    (Reflect.get(value, "host") as string).length === 0
  ) {
    return undefined;
  }

  return {
    version: 1,
    token: Reflect.get(value, "token") as string,
    pid: Number(Reflect.get(value, "pid")),
    host: Reflect.get(value, "host") as string,
  };
}

async function posixOwnerMayBeAlive(
  record: PosixLeaseRecord,
): Promise<boolean> {
  if (record.host !== hostname()) {
    return true;
  }

  try {
    process.kill(record.pid, 0);
  } catch (error: unknown) {
    return !isErrorCode(error, "ESRCH");
  }

  try {
    return await posixProcessIsRunnable(record.pid, process.platform);
  } catch {
    // State inspection is advisory. Unsupported ps selectors, permission
    // errors, timeouts, and malformed output must never reap a possibly live
    // owner; a later retry can observe an unambiguous ESRCH/dead state.
    return true;
  }
}

async function releasePosixDirectoryLease(
  lockPath: string,
  expected: PosixLeaseRecord,
): Promise<void> {
  const current = await readPosixLeaseRecord(lockPath);

  if (
    current === undefined ||
    current.token !== expected.token ||
    current.pid !== expected.pid ||
    current.host !== expected.host
  ) {
    throw new Error("Session writer lock ownership changed before release.");
  }

  const releasedPath = `${lockPath}.released-${expected.token}`;
  await rename(lockPath, releasedPath);
  await rm(releasedPath, { recursive: true, force: false });
}

async function removeCandidateAfterFailure(
  candidatePath: string,
  originalError: unknown,
): Promise<never> {
  try {
    await rm(candidatePath, { recursive: true, force: true });
  } catch (cleanupError: unknown) {
    throw new AggregateError(
      [originalError, cleanupError],
      "Session writer lock acquisition and cleanup both failed.",
    );
  }

  throw originalError;
}

function isLeaseContentionError(error: unknown): boolean {
  return (
    isErrorCode(error, "EEXIST") ||
    isErrorCode(error, "ENOTEMPTY") ||
    isErrorCode(error, "ENOTDIR") ||
    isErrorCode(error, "EISDIR")
  );
}

function isErrorCode(error: unknown, code: string): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === code;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function spawnWindowsHolder(
  lockPath: string,
  token: string,
  timeoutMs: number,
): ChildProcessWithoutNullStreams {
  const systemRoot = process.env["SystemRoot"] ?? "C:\\Windows";
  const executable = join(
    systemRoot,
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe",
  );
  const encoded = Buffer.from(WINDOWS_HOLDER, "utf16le").toString("base64");

  return spawn(
    executable,
    [
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-EncodedCommand",
      encoded,
    ],
    {
      env: {
        SystemRoot: systemRoot,
        PI_CLONE_SESSION_LOCK_PATH: lockPath,
        PI_CLONE_SESSION_LOCK_TIMEOUT_MS: String(Math.ceil(timeoutMs)),
        PI_CLONE_SESSION_LOCK_TOKEN: token,
      },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    },
  );
}

async function waitForAcquisition(
  child: ChildProcessWithoutNullStreams,
  token: string,
  timeoutMs: number,
): Promise<void> {
  const terminal = waitForClose(child);
  let buffered = "";
  let settled = false;

  await new Promise<void>((resolve, reject) => {
    // PowerShell enforces the Windows deadline itself, but allow its cold
    // startup to finish so its explicit timeout result wins.
    const startupGraceMs = 5_000;
    const timer = setTimeout(() => {
      finish(() => reject(new Error("Timed out waiting for session writer lock.")));
    }, timeoutMs + startupGraceMs);
    timer.unref();

    const finish = (action: () => void): void => {
      if (settled) {
        return;
      }

      settled = true;
      clearTimeout(timer);
      action();
    };

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      buffered += chunk;
      const newline = buffered.indexOf("\n");

      if (newline < 0) {
        return;
      }

      const line = buffered.slice(0, newline).trim();

      if (line === token) {
        finish(resolve);
      } else {
        finish(() => reject(new Error("Session writer lock authentication failed.")));
      }
    });
    child.once("error", (error) => finish(() => reject(error)));
    void terminal.then(({ code, stderr }) => {
      finish(() =>
        reject(
          new Error(
            `Session writer lock holder exited before acquisition with code ` +
              `${String(code)}${formatStderr(stderr)}`,
          ),
        ),
      );
    });
  });
}

function waitForClose(
  child: ChildProcessWithoutNullStreams,
): Promise<{ code: number | null; stderr: string }> {
  const existing = Reflect.get(child, "__piCloneClosePromise") as
    | Promise<{ code: number | null; stderr: string }>
    | undefined;

  if (existing) {
    return existing;
  }

  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    stderr = `${stderr}${chunk}`.slice(-4_096);
  });
  const close = new Promise<{ code: number | null; stderr: string }>(
    (resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code) => resolve({ code, stderr }));
    },
  );
  Reflect.set(child, "__piCloneClosePromise", close);
  void close.catch(() => undefined);
  return close;
}

function formatStderr(stderr: string): string {
  const trimmed = stderr.trim();
  return trimmed.length === 0 ? "." : `: ${trimmed}`;
}
