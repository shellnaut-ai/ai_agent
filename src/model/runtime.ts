import type { StreamOptions } from "./provider.js";
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

export class ModelRuntime implements ModelStreamRunner {
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
}
