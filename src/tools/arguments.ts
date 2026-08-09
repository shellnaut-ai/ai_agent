import type { ToolCall } from "./types.js";

export function serializeToolCallArguments(call: ToolCall): string {
  if (call.arguments === undefined) {
    throw new Error(
      `Tool call "${call.id}" arguments must not be undefined.`,
    );
  }

  const serialized = JSON.stringify(call.arguments);

  if (serialized === undefined) {
    throw new Error(
      `Tool call "${call.id}" arguments are not serializable.`,
    );
  }

  return serialized;
}
