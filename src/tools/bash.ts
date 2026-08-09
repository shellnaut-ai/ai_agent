import { spawn } from "node:child_process";
import { realpath } from "node:fs/promises";
import type { Readable } from "node:stream";
import { resolve } from "node:path";
import { Type } from "typebox";

import { terminateProcessTree } from "./process-tree.js";
import {
  spawnWindowsBashSupervisor,
  type WindowsBashSupervisor,
} from "./windows-bash-supervisor.js";
import type {
  Tool,
  ToolDefinition,
  ToolExecutionOptions,
  ToolOutput,
} from "./types.js";

export interface BashToolOptions {
  readonly rootDir: string;
  readonly shellPath?: string;
  readonly timeoutMs?: number;
  readonly maxOutputBytes?: number;
}

interface CapturedOutput {
  readonly chunks: Buffer[];
  byteLength: number;
  truncated: boolean;
}

interface StreamEndWatcher {
  readonly promise: Promise<void>;
  dispose(): void;
}

function captureChunk(
  output: CapturedOutput,
  chunk: unknown,
  maxOutputBytes: number,
): void {
  const buffer = Buffer.isBuffer(chunk)
    ? chunk
    : Buffer.from(String(chunk), "utf8");

  const remainingBytes = maxOutputBytes - output.byteLength;

  if (remainingBytes > 0) {
    output.chunks.push(buffer.subarray(0, remainingBytes));
    output.byteLength += Math.min(buffer.byteLength, remainingBytes);
  }

  if (buffer.byteLength > remainingBytes) {
    output.truncated = true;
  }
}

function watchStreamEnd(stream: Readable): StreamEndWatcher {
  if (stream.readableEnded || stream.destroyed) {
    return {
      promise: Promise.resolve(),
      dispose: () => undefined,
    };
  }

  let resolveEnd: () => void = () => undefined;
  let rejectEnd: (error: Error) => void = () => undefined;
  const promise = new Promise<void>((resolvePromise, rejectPromise) => {
    resolveEnd = resolvePromise;
    rejectEnd = rejectPromise;
  });
  const dispose = (): void => {
    stream.off("end", onEnd);
    stream.off("close", onClose);
    stream.off("error", onError);
  };
  const onEnd = (): void => {
    dispose();
    resolveEnd();
  };
  const onClose = (): void => {
    dispose();
    resolveEnd();
  };
  const onError = (error: Error): void => {
    dispose();
    rejectEnd(error);
  };

  stream.once("end", onEnd);
  stream.once("close", onClose);
  stream.once("error", onError);

  return { promise, dispose };
}

function createAbortError(signal: AbortSignal): Error {
  const error = new Error("The operation was aborted", {
    cause: signal.reason,
  });
  error.name = "AbortError";
  (error as NodeJS.ErrnoException).code = "ABORT_ERR";
  return error;
}

export class BashTool implements Tool {
  readonly approval = "always" as const;

  readonly definition: ToolDefinition = {
    name: "bash",
    description:
      "Runs a non-interactive Bash command in the workspace and returns " +
      "its exit code, stdout, and stderr.",
    inputSchema: Type.Object(
      {
        command: Type.String({
          minLength: 1,
          description: "Complete Bash command to execute.",
        }),
      },
      {
        additionalProperties: false,
      },
    ),
  };

  private readonly rootDir: string;
  private readonly shellPath: string;
  private readonly timeoutMs: number;
  private readonly maxOutputBytes: number;

  constructor(options: BashToolOptions) {
    this.rootDir = resolve(options.rootDir);
    this.shellPath = options.shellPath ?? "bash";
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.maxOutputBytes = options.maxOutputBytes ?? 64 * 1024;

    if (this.shellPath.trim().length === 0) {
      throw new Error("BashTool shellPath must be a non-empty string.");
    }

    if (!Number.isInteger(this.timeoutMs) || this.timeoutMs <= 0) {
      throw new Error("BashTool timeoutMs must be a positive integer.");
    }

    if (
      !Number.isInteger(this.maxOutputBytes) ||
      this.maxOutputBytes <= 0
    ) {
      throw new Error("BashTool maxOutputBytes must be a positive integer.");
    }
  }

  async execute(
    input: unknown,
    options?: ToolExecutionOptions,
  ): Promise<ToolOutput> {
    if (options?.signal?.aborted) {
      throw new Error("Tool execution aborted.");
    }

    if (typeof input !== "object" || input === null || Array.isArray(input)) {
      return {
        content: "bash input must be an object.",
        isError: true,
      };
    }

    const commandValue = Reflect.get(input, "command");

    if (
      typeof commandValue !== "string" ||
      commandValue.trim().length === 0
    ) {
      return {
        content: "bash.command must be a non-empty string.",
        isError: true,
      };
    }

    let supervisor: WindowsBashSupervisor | undefined;

    try {
      const rootRealPath = await realpath(this.rootDir);
      supervisor =
        process.platform === "win32"
          ? await spawnWindowsBashSupervisor({
              shellPath: this.shellPath,
              command: commandValue,
              cwd: rootRealPath,
            })
          : undefined;
      const child =
        supervisor?.child ??
        spawn(this.shellPath, ["-lc", commandValue], {
          cwd: rootRealPath,
          detached: true,
          env: process.env,
          stdio: ["ignore", "pipe", "pipe"],
          windowsHide: true,
        });

      const stdout: CapturedOutput = {
        chunks: [],
        byteLength: 0,
        truncated: false,
      };

      const stderr: CapturedOutput = {
        chunks: [],
        byteLength: 0,
        truncated: false,
      };

      let timedOut = false;
      let outputLimitExceeded = false;
      let terminationPromise: Promise<void> | undefined;
      let detachSupervisor = false;
      let stdoutStream: Readable | undefined;
      let stderrStream: Readable | undefined;
      let stdoutEnd: StreamEndWatcher | undefined;
      let stderrEnd: StreamEndWatcher | undefined;

      let rejectTerminal: (error: Error) => void = () => undefined;
      const onChildError = (error: Error): void => rejectTerminal(error);
      let resolveTerminal: (
        terminal: {
          readonly exitCode: number | null;
          readonly signal: NodeJS.Signals | null;
        },
      ) => void = () => undefined;
      const onChildClose = (
        exitCode: number | null,
        signal: NodeJS.Signals | null,
      ): void => resolveTerminal({ exitCode, signal });

      const terminalPromise = new Promise<{
        readonly exitCode: number | null;
        readonly signal: NodeJS.Signals | null;
      }>((resolvePromise, rejectPromise) => {
        resolveTerminal = resolvePromise;
        rejectTerminal = rejectPromise;
        child.once("error", onChildError);
        child.once("close", onChildClose);
      });

      const requestTermination = (): Promise<void> => {
        terminationPromise ??= terminateProcessTree(child, process.platform);
        void terminationPromise.catch((error: unknown) => {
          rejectTerminal(
            error instanceof Error ? error : new Error(String(error)),
          );
        });
        return terminationPromise;
      };

      const terminateForOutputLimit = (): void => {
        if (!outputLimitExceeded) {
          outputLimitExceeded = true;
          void requestTermination();
        }
      };

      const onStdoutData = (chunk: unknown): void => {
        captureChunk(stdout, chunk, this.maxOutputBytes);

        if (stdout.truncated) {
          terminateForOutputLimit();
        }
      };

      const onStderrData = (chunk: unknown): void => {
        captureChunk(stderr, chunk, this.maxOutputBytes);

        if (stderr.truncated) {
          terminateForOutputLimit();
        }
      };

      const onAbort = (): void => {
        void requestTermination();
      };

      options?.signal?.addEventListener("abort", onAbort, { once: true });

      if (options?.signal?.aborted) {
        onAbort();
      }

      const timeout = setTimeout(() => {
        timedOut = true;
        void requestTermination();
      }, this.timeoutMs);

      timeout.unref();

      try {
        const output =
          supervisor === undefined
            ? { stdout: child.stdout!, stderr: child.stderr! }
            : await supervisor.output;
        stdoutStream = output.stdout;
        stderrStream = output.stderr;

        output.stdout.on("data", onStdoutData);
        output.stderr.on("data", onStderrData);
        stdoutEnd = watchStreamEnd(output.stdout);
        stderrEnd = watchStreamEnd(output.stderr);
        output.stdout.resume();
        output.stderr.resume();

        const terminal =
          supervisor === undefined
            ? await terminalPromise
            : await Promise.race([
                Promise.all([
                  supervisor.rootExit,
                  stdoutEnd.promise,
                  stderrEnd.promise,
                ]).then(([exitCode]) => ({
                  exitCode,
                  signal: null,
                })),
                terminalPromise,
              ]);

        if (terminationPromise !== undefined) {
          await terminationPromise;
        } else if (supervisor !== undefined) {
          detachSupervisor = true;
        }

        if (options?.signal?.aborted) {
          throw createAbortError(options.signal);
        }

        const result = {
          exitCode: terminal.exitCode,
          signal: terminal.signal,
          timedOut,
          outputTruncated: outputLimitExceeded,
          stdout: Buffer.concat(stdout.chunks).toString("utf8"),
          stderr: Buffer.concat(stderr.chunks).toString("utf8"),
        };

        return {
          content: JSON.stringify(result, null, 2),
          isError:
            timedOut ||
            outputLimitExceeded ||
            terminal.exitCode !== 0 ||
            terminal.signal !== null,
        };
      } finally {
        clearTimeout(timeout);
        options?.signal?.removeEventListener("abort", onAbort);
        stdoutStream?.off("data", onStdoutData);
        stderrStream?.off("data", onStderrData);
        child.off("error", onChildError);
        child.off("close", onChildClose);

        try {
          if (
            supervisor !== undefined &&
            !detachSupervisor &&
            child.exitCode === null &&
            child.signalCode === null
          ) {
            await requestTermination();
          }
        } finally {
          try {
            await supervisor?.dispose(detachSupervisor);
          } finally {
            stdoutEnd?.dispose();
            stderrEnd?.dispose();
          }
        }
      }
    } catch (error: unknown) {
      if (options?.signal?.aborted) {
        throw error;
      }

      return {
        content: error instanceof Error ? error.message : String(error),
        isError: true,
      };
    }
  }
}
