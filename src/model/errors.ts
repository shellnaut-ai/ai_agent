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

export function isRetryableModelError(error: Error): boolean {
  return !(error instanceof ModelHttpError) || error.retryable;
}
