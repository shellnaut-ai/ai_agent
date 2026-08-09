import type { ModelProvider } from "./provider.js";
import type { Model, ProviderId } from "./types.js";

export interface RegistryOptions {
    signal?: AbortSignal;
}

export interface ResolvedModel{
    provider:ModelProvider;
    model:Model;
}

export class ProviderRegistry{
    private readonly providers = new Map<ProviderId, ModelProvider>();


    register(provider:ModelProvider): void{
        if(this.providers.has(provider.id)){
            throw new Error( `Provider "${provider.id}" is already registered.`,);
        }

        this.providers.set(provider.id,provider);
    }

    getProvider(providerId: ProviderId):ModelProvider | undefined {
        return this.providers.get(providerId);
    }

    listProviders(): readonly ModelProvider[]{
        return [...this.providers.values()];
    }

    async listModels(options?:RegistryOptions,):Promise<readonly Model[]>{
        const providers = this.listProviders();
        const pendingLists = providers.map((provider) =>{
            return provider.listModels(options);
        })

        // readonly Model[][]
        const modelLists = await Promise.all(pendingLists);

        return modelLists.flat();
    }

    async resolveModel(
        providerId: ProviderId,
        modelId: string,
        options?: RegistryOptions,
    ):Promise<ResolvedModel | undefined> {
        const provider = this.getProvider(providerId);

        if(!provider){
            return undefined;
        }

        const models = await provider.listModels(options);

        const model = models.find((candidate) => {
            return candidate.id === modelId;
        })

        if(!model){
            return undefined
        }

        return {
            provider,
            model,
        }
    }
}
