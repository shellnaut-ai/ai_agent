const SESSION_ID_PATTERN = /^[A-Za-z0-9_-]{1,100}$/;

export function assertValidSessionId(sessionId: string): void {
  if (!SESSION_ID_PATTERN.test(sessionId)) {
    throw new Error(
      "Session ID may contain only letters, numbers, underscores, " +
        "and hyphens.",
    );
  }
}
