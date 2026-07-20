import { StreamOptions } from "node:fs";
import { ModelProvider } from "../../model/provider";
import { Model, ModelRequest, ProviderId, StreamEvent } from "../../model/types";
import { readSseData } from "./sse";

export interface LlamaProviderOptions{
    serverUrl: string;
    modelId: string;
    modelName?: string;
    contextWindow: number;
    maxOutputTokens: number;
}

interface ParsedChunk{
    content?: string;
    finishReason?: string;
}

function isRecord(value: unknown,): value is Record<string, unknown>{
    return typeof value === "object" && value !== null;
}

function parseChatChunk(data: string):ParsedChunk{
    const value: unknown = JSON.parse(data);

    if(!isRecord(value)){
        throw new Error("Invalid llama.cpp stream chunk");
    }

    const choices = value.choices;

    if(!Array.isArray(choices) || choices.length === 0){
        return {};
    }

    const choice: unknown = choices[0];

    if (!isRecord(choice)) {
    throw new Error("Invalid llama.cpp stream choice");
  }

  const delta = choice.delta;

  const content =
    isRecord(delta) && typeof delta.content === "string"
      ? delta.content
      : undefined;

  const finishReason =
    typeof choice.finish_reason === "string"
      ? choice.finish_reason
      : undefined;

  return {
    content,
    finishReason,
  };
}

export class LlamaProvider implements ModelProvider{
    readonly id: ProviderId = "llama";
    readonly name = "llama.cpp";

    private readonly serverUrl: string;
    private readonly model: Model;

    constructor(options: LlamaProviderOptions){
        this.serverUrl = options.serverUrl.replace(/\/+$/,"");

        this.model = {
            id: options.modelId,
            name: options.modelName ?? options.modelId,
            provider: this.id,
            contextWindow: options.contextWindow,
            maxOutputTokens: options.maxOutputTokens,
        };
    }

    async listModels(options?: { signal?: AbortSignal; }): Promise<readonly Model[]> {
        if(options?.signal?.aborted){
            throw new Error("Model listing aborted");
        }

        return [this.model];
    }

    async *stream(
        request: ModelRequest,
        options?: StreamOptions,
    ): AsyncIterable<StreamEvent>{
        yield{
            type: "error",
            reason: "error",
            error: new Error(
                "LlamaProvider.stream() is not implemented yet",
            )
        }

        if(options?.signal?.aborted){
            yield{
                type: "error",
                reason: "aborted",
                error: new Error("Request abprted"),
            }

            return;
        }

        yield{
            type: "start",
        }


        try{
            const response = await fetch(
                `${this.serverUrl}/v1/chat/completions`,
                {
                    method:"POST",
                    headers:{
                        "Content-Type": "application/json",
                    },
                    body: JSON.stringify({
                        model: request.model.id,
                        messages: request.messages.map((message) => ({
                            role: message.role,
                            content: message.content,
                        })),
                        max_tokens: request.model.maxOutputTokens,
                        stream: true
                    }),
                    signal: options?.signal,
                }
            );

            if(!response.ok){
                const responseBody = await response.text();
                throw new Error(
                    `llama.cpp returned HTTP ${response.status}: ` +
                    responseBody,
                );
            }

            const responseBody = response.body;

            if(!responseBody){
                throw new Error(
                    "llama.cpp returned an empty response body.",
                )
            }

            let finishReason: string | undefined;

            for await (const data of readSseData(responseBody)){
                if(data === "[DONE]"){
                    yield{
                        type: "done",
                        reason:
                        finishReason === "length" ? "length" : "stop"
                    };
                    return;
                }

                const chunk = parseChatChunk(data);

                if(chunk.content){
                    yield{
                        type: "text-delta",
                        delta: chunk.content,
                    }
                }

                if(chunk.finishReason){
                    finishReason = chunk.finishReason;
                }
            }

            throw new Error(
                "llama.cpp stream ended without [DONE]",
            )
        }catch(error:unknown){
            const aborted = options?.signal?.aborted === true;

            yield {
            type: "error",
            reason: aborted ? "aborted" : "error",
            error:
                error instanceof Error
                ? error
                : new Error(String(error)),
            };
        }
      
    }
}