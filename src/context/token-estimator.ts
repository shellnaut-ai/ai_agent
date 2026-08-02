import type { Message } from "../model/types.js";
import type { ToolDefinition } from "../tools/types.js";

export class TokenEstimator {
  private readonly charsPerToken: number;

  constructor(charsPerToken: number) {
    if (!Number.isFinite(charsPerToken) || charsPerToken <= 0) {
      throw new Error(
        "TokenEstimator charsPerToken must be a positive number.",
      );
    }

    this.charsPerToken = charsPerToken;
  }

  estimateValue(value: unknown): number {
    const serialized = JSON.stringify(value);
    const text = serialized === undefined ? String(value) : serialized;

    return Math.ceil(text.length / this.charsPerToken);
  }

  estimateMessages(messages: readonly Message[]): number {
    return this.estimateValue(messages);
  }

  estimateRequest(
    messages: readonly Message[],
    tools: readonly ToolDefinition[],
  ): number {
    return this.estimateValue({
      messages,
      tools,
    });
  }
}
