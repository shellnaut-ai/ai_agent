import { createHash } from "node:crypto";

import type { Model } from "../model/types.js";

export interface OutputContinuationPolicy {
  readonly maxContinuations: number;
  readonly maxTotalOutputTokens: number;
  readonly overlapWindowChars: number;
}

export function createOutputContinuationPolicy(
  model: Model,
  overrides: Partial<OutputContinuationPolicy> = {},
): OutputContinuationPolicy {
  const policy: OutputContinuationPolicy = {
    maxContinuations: overrides.maxContinuations ?? 3,
    maxTotalOutputTokens:
      overrides.maxTotalOutputTokens ?? 4 * model.maxOutputTokens,
    overlapWindowChars: overrides.overlapWindowChars ?? 1024,
  };
  for (const [name, value] of Object.entries(policy)) {
    if (
      !Number.isInteger(value) ||
      (name === "maxContinuations" ? value < 0 : value <= 0)
    ) {
      throw new Error(`Output continuation ${name} must be a positive integer.`);
    }
  }
  return policy;
}

export class ContinuationOverlapGuard {
  readonly #previousTail: string[];
  #buffer: string[] = [];
  #resolved = false;

  constructor(previousTail: string, windowChars: number) {
    if (!Number.isInteger(windowChars) || windowChars <= 0) {
      throw new Error("Continuation overlap window must be a positive integer.");
    }
    this.#previousTail = Array.from(lastCodePoints(previousTail, windowChars));
    this.#resolved = this.#previousTail.length === 0;
  }

  push(delta: string): string {
    if (this.#resolved) return delta;
    const codePoints = Array.from(delta);
    const needed = this.#previousTail.length - this.#buffer.length;
    this.#buffer.push(...codePoints.slice(0, needed));
    if (this.#buffer.length < this.#previousTail.length) return "";
    const novelPrefix = this.#resolveBuffer();
    return novelPrefix + codePoints.slice(needed).join("");
  }

  finish(): string {
    return this.#resolved ? "" : this.#resolveBuffer();
  }

  #resolveBuffer(): string {
    const overlap = longestOverlap(this.#previousTail, this.#buffer);
    const novel = this.#buffer.slice(overlap).join("");
    this.#buffer = [];
    this.#resolved = true;
    return novel;
  }
}

export function continuationTail(value: string, maxCodePoints: number): string {
  return lastCodePoints(value, maxCodePoints);
}

export function continuationTailHash(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export function estimateOutputTokens(value: string): number {
  return Math.ceil(Buffer.byteLength(value, "utf8") / 2);
}

function longestOverlap(left: readonly string[], right: readonly string[]): number {
  const maximum = Math.min(left.length, right.length);
  for (let length = maximum; length > 0; length -= 1) {
    if (
      left.slice(left.length - length).join("") ===
      right.slice(0, length).join("")
    ) {
      return length;
    }
  }
  return 0;
}

function lastCodePoints(value: string, count: number): string {
  return Array.from(value).slice(-count).join("");
}
