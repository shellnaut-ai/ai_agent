import type {ModelProvider, StreamOptions} from "../model/provider"
import { Model, ModelRequest, ProviderId, StreamEvent } from "../model/types";


const FAKE_MODEL:Model ={
    id: "fake-model",
    name: 'Fake Model',
    provider: 'fake',
    contextWindow: 4096,
    maxOutputTokens: 1024,
}

export class FakeProvider implements ModelProvider {
    readonly id = "fake";
    readonly name = "Fake Provider";

    async listModels(options?:{signal?:AbortSignal}): Promise<readonly Model[]> {
        if(options?.signal?.aborted){
            throw new Error("Model listing aborted");
        }

        return [FAKE_MODEL];
    }

    async *stream(
        request: ModelRequest,
        options?: StreamOptions,
    ): AsyncIterable<StreamEvent>{
        if(request.model.provider !== this.id){
            yield{
                type:"error",
                reason:"error",
                error: new Error( `FakeProvider cannot run model from ${request.model.provider}`,)
            };
            return;
        }

        yield { type: "start"};

        const chunks = ["안녕하세요", ", ","가짜 모델입니다."];

        for (const chunk of chunks){
            if(options?.signal?.aborted){
                yield{
                    type: "error",
                    reason:"aborted",
                    error: new Error("Request aborted"),
                };
                return;
            }

            await new Promise<void>((resolve) => {
                setTimeout(resolve, 200);
            });

            yield{
                type: "text-delta",
                delta:chunk,
            };
        }

        yield{
            type:"done",
            reason:"stop",
        }
    }

}
