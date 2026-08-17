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
