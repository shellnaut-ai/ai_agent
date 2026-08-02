import { lstat, writeFile } from "node:fs/promises";
import { Type } from "typebox";

import type {
  Tool,
  ToolDefinition,
  ToolExecutionOptions,
  ToolOutput,
} from "./types.js";
import { WorkspacePaths } from "./workspace-paths.js";

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

  private readonly paths: WorkspacePaths;
  private readonly maxBytes: number;

  constructor(options: WriteToolOptions) {
    this.paths = new WorkspacePaths(options.rootDir);
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

    try {
      let targetExists = true;

      try {
        await lstat(await this.paths.writableFile(pathValue));
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

      const targetRealPath = await this.paths.writableFile(pathValue);

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
          `"${pathValue}" (${contentBytes} bytes).`,
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
