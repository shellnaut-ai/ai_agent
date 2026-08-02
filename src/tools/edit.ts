import { readFile, realpath, stat, writeFile } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { Type } from "typebox";

import type {
  Tool,
  ToolDefinition,
  ToolExecutionOptions,
  ToolOutput,
} from "./types.js";

export interface EditToolOptions {
  readonly rootDir: string;
  readonly maxBytes?: number;
}

export class EditTool implements Tool {
  readonly approval = "always" as const;

  readonly definition: ToolDefinition = {
    name: "edit",
    description:
      "Replaces one exact text occurrence in an existing UTF-8 file " +
      "inside the allowed workspace.",
    inputSchema: Type.Object(
      {
        path: Type.String({
          minLength: 1,
          description: "File path relative to the workspace root.",
        }),
        oldText: Type.String({
          minLength: 1,
          description: "Exact existing text to replace.",
        }),
        newText: Type.String({
          description: "Replacement text.",
        }),
      },
      {
        additionalProperties: false,
      },
    ),
  };

  private readonly rootDir: string;
  private readonly maxBytes: number;

  constructor(options: EditToolOptions) {
    this.rootDir = resolve(options.rootDir);
    this.maxBytes = options.maxBytes ?? 64 * 1024;

    if (!Number.isInteger(this.maxBytes) || this.maxBytes <= 0) {
      throw new Error("EditTool maxBytes must be a positive integer.");
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
        content: "edit input must be an object.",
        isError: true,
      };
    }

    const pathValue = Reflect.get(input, "path");
    const oldTextValue = Reflect.get(input, "oldText");
    const newTextValue = Reflect.get(input, "newText");

    if (typeof pathValue !== "string" || pathValue.trim().length === 0) {
      return {
        content: "edit.path must be a non-empty string.",
        isError: true,
      };
    }

    if (typeof oldTextValue !== "string" || oldTextValue.length === 0) {
      return {
        content: "edit.oldText must be a non-empty string.",
        isError: true,
      };
    }

    if (typeof newTextValue !== "string") {
      return {
        content: "edit.newText must be a string.",
        isError: true,
      };
    }

    if (oldTextValue === newTextValue) {
      return {
        content: "edit.oldText and edit.newText must be different.",
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

      const firstMatchIndex = content.indexOf(oldTextValue);

      if (firstMatchIndex === -1) {
        return {
          content: "edit.oldText was not found in the file.",
          isError: true,
        };
      }

      const secondMatchIndex = content.indexOf(
        oldTextValue,
        firstMatchIndex + 1,
      );

      if (secondMatchIndex !== -1) {
        return {
          content:
            "edit.oldText appears more than once. " +
            "Provide a larger unique text block.",
          isError: true,
        };
      }

      const updatedContent =
        content.slice(0, firstMatchIndex) +
        newTextValue +
        content.slice(firstMatchIndex + oldTextValue.length);

      const updatedBytes = Buffer.byteLength(updatedContent, "utf8");

      if (updatedBytes > this.maxBytes) {
        return {
          content: `Edited file exceeds the ${this.maxBytes} byte limit.`,
          isError: true,
        };
      }

      await writeFile(targetRealPath, updatedContent, {
        encoding: "utf8",
        signal: options?.signal,
      });

      if (options?.signal?.aborted) {
        throw new Error("Tool execution aborted.");
      }

      return {
        content:
          `Replaced one occurrence in "${relativePath}" ` +
          `(${updatedBytes} bytes).`,
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
