export const OPENAI_AUTH_CLAIM = "https://api.openai.com/auth";

/**
 * OAuth token endpoint의 결과를 저장 가능한 내부 값으로 정규화한 계약이다.
 *
 * access/refresh token은 실제 비밀이고 accountId는 ChatGPT 계정을 선택하는 식별자다.
 * 서로 쓰임이 다르므로 하나의 불투명 문자열이나 환경 변수로 합치지 않는다.
 */
export interface OAuthCredential {
  readonly accessToken: string;
  readonly refreshToken: string;
  readonly expiresAt: number;
  readonly accountId: string;
}

/**
 * auth.json이나 HTTP 응답은 TypeScript 바깥에서 들어오므로 unknown부터 검사한다.
 * 타입 단언으로 통과시키면 손상된 저장 파일이 Provider 요청 단계에서 늦게 폭발한다.
 */
export function parseOAuthCredential(value: unknown): OAuthCredential {
  if (!isRecord(value)) {
    throw new Error("OAuth credential must be an object");
  }

  const accessToken = requireNonEmptyString(value.accessToken, "accessToken");
  const refreshToken = requireNonEmptyString(value.refreshToken, "refreshToken");
  if (typeof value.expiresAt !== "number" || !Number.isFinite(value.expiresAt)) {
    throw new Error("OAuth credential expiresAt is invalid");
  }
  const accountId = requireNonEmptyString(value.accountId, "accountId");

  return {
    accessToken,
    refreshToken,
    expiresAt: value.expiresAt,
    accountId,
  };
}

/**
 * access token의 payload에서 ChatGPT 계정 식별자만 꺼낸다.
 *
 * 여기서는 JWT 서명을 검증해 인증 결정을 내리는 것이 아니다. token endpoint가 돌려준
 * access token에 Provider 요청용 account id가 들어 있는지만 구조적으로 읽는다.
 */
export function accountIdFromAccessToken(accessToken: string): string {
  const parts = accessToken.split(".");
  const payloadPart = parts[1];
  if (parts.length !== 3 || payloadPart === undefined) {
    throw new Error("OpenAI access token is not a JWT");
  }

  let payload: unknown;
  try {
    payload = JSON.parse(Buffer.from(payloadPart, "base64url").toString("utf8")) as unknown;
  } catch {
    // 원본 token을 오류 문장에 넣지 않아 진단 로그로 비밀이 새지 않게 한다.
    throw new Error("OpenAI access token contains an invalid JWT payload");
  }

  if (!isRecord(payload)) {
    throw new Error("OpenAI access token contains an invalid JWT payload");
  }
  const authClaim = payload[OPENAI_AUTH_CLAIM];
  const accountId = isRecord(authClaim) ? authClaim.chatgpt_account_id : undefined;
  if (typeof accountId !== "string" || accountId.length === 0) {
    throw new Error("OpenAI access token does not contain a ChatGPT account id");
  }
  return accountId;
}

function requireNonEmptyString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`OAuth credential ${field} is invalid`);
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
