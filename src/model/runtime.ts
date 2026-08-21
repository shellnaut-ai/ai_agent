import {
  isModelInputTokenCounter,
  type StreamOptions,
} from "./provider.js";
import type { ProviderRegistry } from "./registry.js";
import type { ModelRequest, StreamEvent } from "./types.js";

export interface ModelRetryEvent {
  readonly type: "retry";
  readonly attempt: number;
  readonly maxRetries: number;
  readonly delayMs: number;
  readonly error: Error;
}

export type ModelRuntimeEvent = StreamEvent | ModelRetryEvent;

export interface ModelStreamRunner {
  stream(
    request: ModelRequest,
    options?: StreamOptions,
  ): AsyncIterable<ModelRuntimeEvent>;
}

export interface ModelInputTokenCounter {
  countInputTokens(
    request: ModelRequest,
    options?: StreamOptions,
  ): Promise<number | undefined>;
}

export function isModelInputTokenCounterRunner(
  runner: ModelStreamRunner,
): runner is ModelStreamRunner & ModelInputTokenCounter {
  return typeof Reflect.get(runner, "countInputTokens") === "function";
}

export class ModelRuntime implements ModelStreamRunner, ModelInputTokenCounter {
  private readonly registry: ProviderRegistry;

  constructor(registry: ProviderRegistry) {
    this.registry = registry;
  }

  async *stream(
    request: ModelRequest,
    options?: StreamOptions,
  ): AsyncIterable<ModelRuntimeEvent> {
    const provider = this.registry.getProvider(request.model.provider);

    if (!provider) {
      yield {
        type: "error",
        reason: "error",
        error: new Error(
          `Provider "${request.model.provider}" is not registered.`,
        ),
      };

      return;
    }

    yield* provider.stream(request, options);
  }

  async countInputTokens(
    request: ModelRequest,
    options?: StreamOptions,
  ): Promise<number | undefined> {
    const provider = this.registry.getProvider(request.model.provider);

    if (!provider || !isModelInputTokenCounter(provider)) {
      return undefined;
    }

    return await provider.countInputTokens(request, options);
  }
}
