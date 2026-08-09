import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { open } from "node:fs/promises";
import { join } from "node:path";

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

const POSIX_HOLDER =
  "process.stdout.write(process.argv[1] + '\\n');" +
  "process.stdin.resume();";

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
  const handle = await open(lockPath, "a", 0o600);
  await handle.close();
  const token = randomUUID();
  const child =
    process.platform === "win32"
      ? spawnWindowsHolder(lockPath, token, timeoutMs)
      : spawnPosixHolder(lockPath, token, timeoutMs);

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

function spawnPosixHolder(
  lockPath: string,
  token: string,
  timeoutMs: number,
): ChildProcessWithoutNullStreams {
  return spawn(
    "flock",
    [
      "--exclusive",
      "--wait",
      String(timeoutMs / 1_000),
      lockPath,
      process.execPath,
      "-e",
      POSIX_HOLDER,
      token,
    ],
    {
      env: {
        PATH: process.env["PATH"] ?? "",
      },
      stdio: ["pipe", "pipe", "pipe"],
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
    const timer = setTimeout(() => {
      finish(() => reject(new Error("Timed out waiting for session writer lock.")));
    }, timeoutMs + 5_000);
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
