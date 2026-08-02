import type { ToolCall } from "../tools/types.js";

function canonicalJson(value: unknown): string {
  if (value === null) {
    return "null";
  }

  if (typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }

  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new Error("Tool arguments must contain only finite numbers.");
    }

    return JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }

  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    const properties = Object.keys(record)
      .sort()
      .map((key) => {
        return `${JSON.stringify(key)}:${canonicalJson(record[key])}`;
      });

    return `{${properties.join(",")}}`;
  }

  throw new Error("Tool arguments must be valid JSON values.");
}

export function createToolApprovalKey(toolCall: ToolCall): string {
  return `${toolCall.name}:${canonicalJson(toolCall.arguments)}`;
}
