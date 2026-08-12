import { createHash } from "node:crypto";

import {
  CONTINUATION_INSTRUCTION,
  type ModelRequest,
} from "../model/types.js";

export function continuationInstruction(
  request: ModelRequest,
): string | undefined {
  const continuation = request.continuation;
  if (continuation === undefined) return undefined;
  const previous = request.messages.at(-1);
  if (
    previous?.role !== "assistant" ||
    previous.continuation === undefined ||
    previous.continuation.status !== "partial" ||
    !previous.continuation.resumeAllowed ||
    previous.continuation.logicalMessageId !== continuation.logicalMessageId ||
    previous.continuation.segmentIndex + 1 !== continuation.segmentIndex ||
    previous.continuation.tailHash !== continuation.previousTailHash ||
    !/^[a-f0-9]{64}$/.test(continuation.previousTailHash) ||
    Array.from(continuation.previousTail).length > 1024 ||
    hash(continuation.previousTail) !== continuation.previousTailHash
  ) {
    throw new Error(
      "Invalid continuation: the last assistant logical segment does not " +
        "match the requested continuation state.",
    );
  }
  return CONTINUATION_INSTRUCTION;
}

function hash(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
