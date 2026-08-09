import { spawn } from "node:child_process";
import { realpath } from "node:fs/promises";
import { resolve } from "node:path";
import { Type } from "typebox";

import { terminateProcessTree } from "./process-tree.js";
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

const WINDOWS_MANAGED_COMMAND = `
__pi_clone_managed_command_7f2c=$1
shift
__pi_clone_wait_for_jobs_7f2c() {
  __pi_clone_exit_status_7f2c=$?
  trap - EXIT
  wait
  exit "$__pi_clone_exit_status_7f2c"
}
trap '__pi_clone_wait_for_jobs_7f2c' EXIT
eval "$__pi_clone_managed_command_7f2c"
`;

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

    try {
      const rootRealPath = await realpath(this.rootDir);
      const shellArgs =
        process.platform === "win32"
          ? ["-lc", WINDOWS_MANAGED_COMMAND, "bash", commandValue]
          : ["-lc", commandValue];

      const child = spawn(this.shellPath, shellArgs, {
        cwd: rootRealPath,
        detached: process.platform !== "win32",
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

      child.stdout.on("data", onStdoutData);
      child.stderr.on("data", onStderrData);

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
        const terminal = await terminalPromise;

        if (terminationPromise !== undefined) {
          await terminationPromise;
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
        child.stdout.off("data", onStdoutData);
        child.stderr.off("data", onStderrData);
        child.off("error", onChildError);
        child.off("close", onChildClose);
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
