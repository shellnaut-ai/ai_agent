import { lstat, realpath, stat, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { Type } from "typebox";

import type {
  Tool,
  ToolDefinition,
  ToolExecutionOptions,
  ToolOutput,
} from "./types.js";

export interface WriteToolOptions {
  readonly rootDir: string;
  readonly maxBytes?: number;
}

export class WriteTool implements Tool {
  readonly approval = "always" as const;

  readonly definition: ToolDefinition = {
    name: "write",
    description:
      "Creates or overwrites a UTF-8 text file inside the allowed workspace.",
    inputSchema: Type.Object(
      {
        path: Type.String({
          minLength: 1,
          description: "File path relative to the workspace root.",
        }),
        content: Type.String({
          description: "Complete UTF-8 text content to write.",
        }),
      },
      {
        additionalProperties: false,
      },
    ),
  };

  private readonly rootDir: string;
  private readonly maxBytes: number;

  constructor(options: WriteToolOptions) {
    this.rootDir = resolve(options.rootDir);
    this.maxBytes = options.maxBytes ?? 64 * 1024;

    if (!Number.isInteger(this.maxBytes) || this.maxBytes <= 0) {
      throw new Error("WriteTool maxBytes must be a positive integer.");
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
        content: "write input must be an object.",
        isError: true,
      };
    }

    const pathValue = Reflect.get(input, "path");
    const contentValue = Reflect.get(input, "content");

    if (typeof pathValue !== "string" || pathValue.trim().length === 0) {
      return {
        content: "write.path must be a non-empty string.",
        isError: true,
      };
    }

    if (typeof contentValue !== "string") {
      return {
        content: "write.content must be a string.",
        isError: true,
      };
    }

    const contentBytes = Buffer.byteLength(contentValue, "utf8");

    if (contentBytes > this.maxBytes) {
      return {
        content: `Content exceeds the ${this.maxBytes} byte limit.`,
        isError: true,
      };
    }

    const requestedPath = resolve(this.rootDir, pathValue);

    try {
      const rootRealPath = await realpath(this.rootDir);
      let targetExists = true;

      try {
        await lstat(requestedPath);
      } catch (error: unknown) {
        const notFound =
          error instanceof Error &&
          "code" in error &&
          error.code === "ENOENT";

        if (!notFound) {
          throw error;
        }

        targetExists = false;
      }

      let targetRealPath: string;

      if (targetExists) {
        targetRealPath = await realpath(requestedPath);

        const targetStat = await stat(targetRealPath);

        if (!targetStat.isFile()) {
          return {
            content: "Path is not a regular file.",
            isError: true,
          };
        }
      } else {
        const parentRealPath = await realpath(dirname(requestedPath));
        targetRealPath = resolve(parentRealPath, basename(requestedPath));
      }

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

      await writeFile(targetRealPath, contentValue, {
        encoding: "utf8",
        signal: options?.signal,
      });

      if (options?.signal?.aborted) {
        throw new Error("Tool execution aborted.");
      }

      return {
        content:
          `${targetExists ? "Overwrote" : "Created"} ` +
          `"${relativePath}" (${contentBytes} bytes).`,
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
