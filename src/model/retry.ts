import type { StreamOptions } from "./provider.js";
import type {
  ModelRuntimeEvent,
  ModelStreamRunner,
} from "./runtime.js";
import type { ModelRequest } from "./types.js";
import { cloneModelRequest } from "./request-clone.js";
import { isRetryableModelError } from "./errors.js";

export interface RetryOptions {
  readonly maxRetries: number;
  readonly initialDelayMs: number;
}

function waitForRetry(
  delayMs: number,
  signal?: AbortSignal,
): Promise<void> {
  if (signal?.aborted) {
    return Promise.reject(new Error("Request aborted."));
  }

  return new Promise<void>((resolve, reject) => {
    const onAbort = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      reject(new Error("Request aborted."));
    };

    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, delayMs);

    signal?.addEventListener("abort", onAbort, {
      once: true,
    });
  });
}

export class RetryingModelRuntime implements ModelStreamRunner {
  private readonly runner: ModelStreamRunner;
  private readonly maxRetries: number;
  private readonly initialDelayMs: number;

  constructor(runner: ModelStreamRunner, options: RetryOptions) {
    if (!Number.isInteger(options.maxRetries) || options.maxRetries < 0) {
      throw new Error("Retry maxRetries must be a non-negative integer.");
    }

    if (
      !Number.isFinite(options.initialDelayMs) ||
      options.initialDelayMs < 0
    ) {
      throw new Error("Retry initialDelayMs must be a non-negative number.");
    }

    this.runner = runner;
    this.maxRetries = options.maxRetries;
    this.initialDelayMs = options.initialDelayMs;
  }

  async *stream(
    request: ModelRequest,
    options?: StreamOptions,
  ): AsyncIterable<ModelRuntimeEvent> {
    let startEmitted = false;
    const pristineRequest = cloneModelRequest(request);

    for (
      let attemptIndex = 0;
      attemptIndex <= this.maxRetries;
      attemptIndex += 1
    ) {
      let meaningfulEventSeen = false;
      let terminalEventSeen = false;
      let retryError: Error | undefined;

      const attemptRequest = cloneModelRequest(pristineRequest);

      for await (const event of this.runner.stream(attemptRequest, options)) {
        if (event.type === "start") {
          if (!startEmitted) {
            startEmitted = true;
            yield event;
          }

          continue;
        }

        if (event.type === "text-delta" || event.type === "tool-call") {
          meaningfulEventSeen = true;
        }

        if (event.type === "done") {
          terminalEventSeen = true;
          yield event;
          return;
        }

        if (event.type !== "error") {
          yield event;
          continue;
        }

        terminalEventSeen = true;

        if (
          event.reason === "aborted" ||
          meaningfulEventSeen ||
          !isRetryableModelError(event.error) ||
          attemptIndex === this.maxRetries
        ) {
          yield event;
          return;
        }

        retryError = event.error;
        break;
      }

      if (!terminalEventSeen && !retryError) {
        retryError = new Error(
          "Model stream ended without a terminal event.",
        );
      }

      if (!retryError) {
        return;
      }

      if (meaningfulEventSeen || attemptIndex === this.maxRetries) {
        yield {
          type: "error",
          reason: "error",
          error: retryError,
        };
        return;
      }

      const delayMs = this.initialDelayMs * 2 ** attemptIndex;

      yield {
        type: "retry",
        attempt: attemptIndex + 1,
        maxRetries: this.maxRetries,
        delayMs,
        error: retryError,
      };

      try {
        await waitForRetry(delayMs, options?.signal);
      } catch (error: unknown) {
        yield {
          type: "error",
          reason: "aborted",
          error: error instanceof Error ? error : new Error(String(error)),
        };
        return;
      }
    }
  }
}
