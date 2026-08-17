import { assertValidSessionId } from "../session/session-id.js";

export function parseSessionId(
  argumentsValue: readonly string[],
): string | undefined {
  const sessionIndexes = argumentsValue
    .map((value, index) => ({
      value,
      index,
    }))
    .filter(({ value }) => value === "--session")
    .map(({ index }) => index);

  if (sessionIndexes.length === 0) {
    return undefined;
  }

  if (sessionIndexes.length > 1) {
    throw new Error("--session may be provided only once.");
  }

  const sessionId = argumentsValue[sessionIndexes[0] + 1];

  if (!sessionId || sessionId.startsWith("--")) {
    throw new Error("--session requires a session ID.");
  }

  assertValidSessionId(sessionId);
  return sessionId;
}
