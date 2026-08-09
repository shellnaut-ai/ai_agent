import {
  CONTINUATION_INSTRUCTION,
  type Message,
  type ModelRequest,
} from "../model/types.js";

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

  estimateRequest(request: ModelRequest): number {
    return this.estimateValue({
      ...(request.systemPrompt === undefined
        ? {}
        : { systemPrompt: request.systemPrompt }),
      messages: request.messages,
      tools: request.tools,
      ...(request.continuation === undefined
        ? {}
        : {
            continuation: {
              instruction: CONTINUATION_INSTRUCTION,
              ...request.continuation,
            },
          }),
    });
  }
}
