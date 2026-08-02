import { readFile, realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { Type } from "typebox";

import type {
  Tool,
  ToolDefinition,
  ToolExecutionOptions,
  ToolOutput,
} from "./types.js";

export interface ReadToolOptions {
  readonly rootDir: string;
  readonly maxBytes?: number;
}

export class ReadTool implements Tool {
  readonly approval = "never" as const;

  readonly definition: ToolDefinition = {
    name: "read",
    description: "Reads a UTF-8 text file inside the allowed workspace.",
    inputSchema: Type.Object(
      {
        path: Type.String({
          minLength: 1,
          description: "File path relative to the workspace root.",
        }),
      },
      {
        additionalProperties: false,
      },
    ),
  };

  private readonly rootDir: string;
  private readonly maxBytes: number;

  constructor(options: ReadToolOptions) {
    this.rootDir = resolve(options.rootDir);
    this.maxBytes = options.maxBytes ?? 64 * 1024;

    if (!Number.isInteger(this.maxBytes) || this.maxBytes <= 0) {
      throw new Error("ReadTool maxBytes must be a positive integer.");
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
        content: "read input must be an object.",
        isError: true,
      };
    }

    const pathValue = Reflect.get(input, "path");

    if (typeof pathValue !== "string" || pathValue.trim().length === 0) {
      return {
        content: "read.path must be a non-empty string.",
        isError: true,
      };
    }

    const requestedPath = resolve(this.rootDir, pathValue);

    try {
      const rootRealPath = await realpath(this.rootDir);

      const targetRealPath = await realpath(requestedPath);

      const relativePath = relative(rootRealPath, targetRealPath);

      const outsideRoot =
        relativePath === ".." ||
        relativePath.startsWith(`..${sep}`) ||
        isAbsolute(relativePath);

      if (outsideRoot) {
        return {
          content: "Path is outside the allowed workspace.",
          isError: true,
        };
      }

      const fileStat = await stat(targetRealPath);

      if (!fileStat.isFile()) {
        return {
          content: "Path is not a regular file.",
          isError: true,
        };
      }

      if (fileStat.size > this.maxBytes) {
        return {
          content: `File exceeds the ${this.maxBytes} byte limit.`,
          isError: true,
        };
      }

      const content = await readFile(targetRealPath, {
        encoding: "utf8",
        signal: options?.signal,
      });

      if (options?.signal?.aborted) {
        throw new Error("Tool execution aborted.");
      }

      if (Buffer.byteLength(content, "utf8") > this.maxBytes) {
        return {
          content: `File exceeds the ${this.maxBytes} byte limit.`,
          isError: true,
        };
      }

      return {
        content,
        isError: false,
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
