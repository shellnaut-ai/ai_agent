import type {
  ModelRequest,
  StreamEvent,
} from "./types";

import type {
  StreamOptions,
} from "./provider";

import type {
  ProviderRegistry,
} from "./registry";

export class ModelRuntime{
    private readonly registry:ProviderRegistry;

    constructor(registry:ProviderRegistry){
        this.registry = registry;
    }

    async *stream(
        request:ModelRequest,
        options?: StreamOptions,
    ): AsyncIterable<StreamEvent>{
        const provider = this.registry.getProvider(
            request.model.provider,
        );

        if(!provider){
            yield {
                type:"error",
                reason:"error",
                error:new Error(
                     `Provider "${request.model.provider}" is not registered.`,
                )
            }

            return;
        }

        yield* provider.stream(request, options);
    }

}