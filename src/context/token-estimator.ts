import {
  CONTINUATION_INSTRUCTION,
  combineSystemPrompts,
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
    const systemPrompt = combineSystemPrompts(
      request.model.systemPrompt,
      request.systemPrompt,
    );
    return this.estimateValue({
      ...(systemPrompt === undefined
        ? {}
        : { systemPrompt }),
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
