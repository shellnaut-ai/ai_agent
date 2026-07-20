import { FakeProvider } from "./providers/fake-provider.js";
import type { ModelRequest } from "./model/types.js";
import { ProviderRegistry } from "./model/registry.js";
import { ModelRuntime } from "./model/runtime.js";
import { LlamaProvider } from "./providers/llama/provider.js";

async function main(): Promise<void> {
    const registry = new ProviderRegistry();
    registry.register(new LlamaProvider({
        serverUrl: "http://127.0.0.1:8080",
        contextWindow:4096,
        maxOutputTokens:1024,
        modelId:"gemma-local",
        modelName:"Local Gemma"
    }));


    const resolved = await registry.resolveModel(
        "llama",
        "gemma-local",
    )

    if(!resolved){
        throw new Error("model was not found");
    }

    const runtime = new ModelRuntime(registry);

    const request: ModelRequest = {
        model: resolved.model,
        messages:[
            {
                role: "user",
                content: "너는 gemma-local 맞지? 한국어로 짧게 자기 소개 좀 부탁할께.",
            }
        ]
    }

    for await (const event of runtime.stream(request)) {
        if (event.type === "text-delta") {
            process.stdout.write(event.delta);
        }

        if (event.type === "done") {
            process.stdout.write("\n");
        }

        if (event.type === "error") {
            console.error(event.error.message);
        }
    }
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
