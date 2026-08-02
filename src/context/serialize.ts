import type { Message } from "../model/types.js";
import type {
  CompactionFileDetails,
  CompactionTurn,
} from "./types.js";

interface MutableFileOperations {
  readonly read: Set<string>;
  readonly modified: Set<string>;
}

function truncateToolResult(content: string, maxChars: number): string {
  if (content.length <= maxChars) {
    return content;
  }

  const truncatedChars = content.length - maxChars;

  return (
    `${content.slice(0, maxChars)}\n\n` +
    `[... ${truncatedChars} more characters truncated]`
  );
}

function serializeMessage(message: Message, toolResultMaxChars: number): string {
  if (message.role === "user") {
    return `[User]: ${message.content}`;
  }

  if (message.role === "assistant") {
    const parts: string[] = [];

    if (message.content.length > 0) {
      parts.push(`[Assistant]: ${message.content}`);
    }

    if (message.toolCalls.length > 0) {
      const calls = message.toolCalls
        .map((call) => {
          const entries =
            typeof call.arguments === "object" &&
            call.arguments !== null &&
            !Array.isArray(call.arguments)
              ? Object.entries(call.arguments as Record<string, unknown>)
              : [["arguments", call.arguments] as const];
          const argumentsText = entries
            .map(([key, value]) => {
              return `${key}=${JSON.stringify(value)}`;
            })
            .join(", ");

          return `${call.name}(${argumentsText})`;
        })
        .join("; ");

      parts.push(`[Assistant tool calls]: ${calls}`);
    }

    return parts.join("\n");
  }

  return (
    `[Tool result${message.isError ? " error" : ""}]: ` +
    truncateToolResult(message.content, toolResultMaxChars)
  );
}

export function serializeTurns(
  turns: readonly CompactionTurn[],
  toolResultMaxChars: number,
): string {
  return turns
    .flatMap((turn) => {
      return turn.messages.map((message) => {
        return serializeMessage(message, toolResultMaxChars);
      });
    })
    .filter((part) => part.length > 0)
    .join("\n\n");
}

function addPath(
  operations: MutableFileOperations,
  toolName: string,
  argumentsValue: unknown,
): void {
  if (
    typeof argumentsValue !== "object" ||
    argumentsValue === null ||
    Array.isArray(argumentsValue)
  ) {
    return;
  }

  const pathValue = Reflect.get(argumentsValue, "path");

  if (typeof pathValue !== "string" || pathValue.length === 0) {
    return;
  }

  if (toolName === "read") {
    operations.read.add(pathValue);
  }

  if (toolName === "write" || toolName === "edit") {
    operations.modified.add(pathValue);
  }
}

export function collectFileDetails(
  turns: readonly CompactionTurn[],
  previous?: CompactionFileDetails,
): CompactionFileDetails {
  const operations: MutableFileOperations = {
    read: new Set(previous?.readFiles ?? []),
    modified: new Set(previous?.modifiedFiles ?? []),
  };

  for (const turn of turns) {
    for (const message of turn.messages) {
      if (message.role !== "assistant") {
        continue;
      }

      for (const call of message.toolCalls) {
        addPath(operations, call.name, call.arguments);
      }
    }
  }

  for (const path of operations.modified) {
    operations.read.delete(path);
  }

  return {
    readFiles: [...operations.read].sort(),
    modifiedFiles: [...operations.modified].sort(),
  };
}

export function formatFileDetails(details: CompactionFileDetails): string {
  const sections: string[] = [];

  if (details.readFiles.length > 0) {
    sections.push(
      `<read-files>\n${details.readFiles.join("\n")}\n</read-files>`,
    );
  }

  if (details.modifiedFiles.length > 0) {
    sections.push(
      `<modified-files>\n` +
        `${details.modifiedFiles.join("\n")}\n` +
        `</modified-files>`,
    );
  }

  return sections.length > 0 ? `\n\n${sections.join("\n\n")}` : "";
}
