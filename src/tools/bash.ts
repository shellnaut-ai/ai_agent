import { spawn } from "node:child_process";
import { realpath } from "node:fs/promises";
import { resolve } from "node:path";
import { Type } from "typebox";

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

      const child = spawn(this.shellPath, ["-lc", commandValue], {
        cwd: rootRealPath,
        env: process.env,
        signal: options?.signal,
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

      const terminateForOutputLimit = (): void => {
        if (!outputLimitExceeded) {
          outputLimitExceeded = true;
          child.kill("SIGTERM");
        }
      };

      child.stdout.on("data", (chunk: unknown) => {
        captureChunk(stdout, chunk, this.maxOutputBytes);

        if (stdout.truncated) {
          terminateForOutputLimit();
        }
      });

      child.stderr.on("data", (chunk: unknown) => {
        captureChunk(stderr, chunk, this.maxOutputBytes);

        if (stderr.truncated) {
          terminateForOutputLimit();
        }
      });

      const timeout = setTimeout(() => {
        timedOut = true;
        child.kill("SIGTERM");
      }, this.timeoutMs);

      timeout.unref();

      const terminal = await new Promise<{
        readonly exitCode: number | null;
        readonly signal: NodeJS.Signals | null;
      }>((resolveTerminal, rejectTerminal) => {
        child.once("error", (error: Error) => {
          clearTimeout(timeout);
          rejectTerminal(error);
        });

        child.once("close", (exitCode, signal) => {
          clearTimeout(timeout);
          resolveTerminal({
            exitCode,
            signal,
          });
        });
      });

      if (options?.signal?.aborted) {
        throw new Error("Tool execution aborted.");
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
