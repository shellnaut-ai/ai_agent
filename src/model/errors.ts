export class ModelHttpError extends Error {
  readonly retryable: boolean;

  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "ModelHttpError";
    this.retryable =
      status === 408 ||
      status === 409 ||
      status === 429 ||
      (status >= 500 && status <= 599);
  }
}

const CONTEXT_OVERFLOW_PATTERN =
  /exceeds the available context size|context[_ ]length[_ ]exceeded/i;

export class ContextOverflowError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ContextOverflowError";
  }
}

export function isContextOverflowError(
  error: unknown,
): error is ContextOverflowError {
  return error instanceof ContextOverflowError;
}

export function isContextOverflowMessage(message: string): boolean {
  return CONTEXT_OVERFLOW_PATTERN.test(message);
}

export function isRetryableModelError(error: Error): boolean {
  if (error instanceof ContextOverflowError) {
    return false;
  }

  return !(error instanceof ModelHttpError) || error.retryable;
}
