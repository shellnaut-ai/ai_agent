import { cloneToolDefinition } from "../tools/definition.js";
import type { ModelRequest } from "./types.js";

export function cloneModelRequest(request: ModelRequest): ModelRequest {
  return {
    model: structuredClone(request.model),
    ...(request.systemPrompt === undefined
      ? {}
      : { systemPrompt: request.systemPrompt }),
    messages: structuredClone(request.messages),
    tools: request.tools.map(cloneToolDefinition),
    ...(request.maxOutputTokens === undefined
      ? {}
      : { maxOutputTokens: request.maxOutputTokens }),
  };
}
