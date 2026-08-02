import {
  accountIdFromAccessToken,
  type OAuthCredential,
} from "./oauth-contracts.js";
import {
  createOAuthState,
  createPkcePair,
  type RandomBytesSource,
} from "./pkce.js";

export const OPENAI_CODEX_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
export const OPENAI_CODEX_REDIRECT_URI = "http://localhost:1455/auth/callback";
export const OPENAI_CODEX_DEVICE_REDIRECT_URI =
  "https://auth.openai.com/deviceauth/callback";

const AUTH_BASE_URL = "https://auth.openai.com";
const AUTHORIZE_URL = `${AUTH_BASE_URL}/oauth/authorize`;
const TOKEN_URL = `${AUTH_BASE_URL}/oauth/token`;
const DEVICE_USER_CODE_URL = `${AUTH_BASE_URL}/api/accounts/deviceauth/usercode`;
const DEVICE_TOKEN_URL = `${AUTH_BASE_URL}/api/accounts/deviceauth/token`;
const DEVICE_VERIFICATION_URI = `${AUTH_BASE_URL}/codex/device`;
const SCOPE = "openid profile email offline_access";
const DEVICE_TIMEOUT_MS = 15 * 60 * 1_000;

export interface BrowserLoginAttempt {
  readonly url: string;
  readonly state: string;
  readonly verifier: string;
  readonly redirectUri: string;
}

export interface DeviceLoginAttempt {
  readonly deviceAuthId: string;
  readonly userCode: string;
  readonly verificationUri: string;
  readonly intervalSeconds: number;
}

export interface OpenAICodexOAuthOptions {
  readonly fetch?: typeof fetch;
  readonly now?: () => number;
  readonly randomBytes?: RandomBytesSource;
  readonly sleep?: (milliseconds: number) => Promise<void>;
  readonly originator?: string;
}

/**
 * OpenAI Codex OAuth의 HTTP 프로토콜만 담당한다.
 *
 * 이 클래스는 token을 파일에 저장하거나 브라우저를 열지 않는다. OAuthStore와 CLI를
 * 의존하지 않아 로그인 프로토콜 자체를 fake HTTP로 검증할 수 있고, UI가 달라도 재사용된다.
 */
export class OpenAICodexOAuth {
  readonly #fetch: typeof fetch;
  readonly #now: () => number;
  readonly #randomBytes: RandomBytesSource | undefined;
  readonly #sleep: (milliseconds: number) => Promise<void>;
  readonly #originator: string;

  constructor(options: OpenAICodexOAuthOptions = {}) {
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#now = options.now ?? Date.now;
    this.#randomBytes = options.randomBytes;
    this.#sleep = options.sleep ?? delay;
    this.#originator = options.originator ?? "pi";
  }

  beginBrowserLogin(): BrowserLoginAttempt {
    const pkce = createPkcePair(this.#randomBytes);
    const state = createOAuthState(this.#randomBytes);
    const url = new URL(AUTHORIZE_URL);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("client_id", OPENAI_CODEX_CLIENT_ID);
    url.searchParams.set("redirect_uri", OPENAI_CODEX_REDIRECT_URI);
    url.searchParams.set("scope", SCOPE);
    url.searchParams.set("code_challenge", pkce.challenge);
    url.searchParams.set("code_challenge_method", pkce.method);
    url.searchParams.set("state", state);
    url.searchParams.set("id_token_add_organizations", "true");
    url.searchParams.set("codex_cli_simplified_flow", "true");
    url.searchParams.set("originator", this.#originator);

    return {
      url: url.toString(),
      state,
      verifier: pkce.verifier,
      redirectUri: OPENAI_CODEX_REDIRECT_URI,
    };
  }

  async completeBrowserLogin(
    callbackInput: string,
    attempt: BrowserLoginAttempt,
    signal?: AbortSignal,
  ): Promise<OAuthCredential> {
    const callback = parseCallbackInput(callbackInput);
    if (callback.state !== attempt.state) {
      // code를 교환하기 전에 state를 검사해야 공격자가 주입한 callback을 token으로 만들지 않는다.
      throw new Error("OAuth callback state does not match the login request");
    }
    if (callback.code === undefined || callback.code.length === 0) {
      throw new Error("OAuth callback does not contain an authorization code");
    }
    return this.#exchangeCode(
      callback.code,
      attempt.verifier,
      attempt.redirectUri,
      signal,
    );
  }

  async refresh(refreshToken: string, signal?: AbortSignal): Promise<OAuthCredential> {
    return this.#requestCredential(new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: OPENAI_CODEX_CLIENT_ID,
    }), "refresh", signal);
  }

  async beginDeviceLogin(signal?: AbortSignal): Promise<DeviceLoginAttempt> {
    const response = await this.#fetch(DEVICE_USER_CODE_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ client_id: OPENAI_CODEX_CLIENT_ID }),
      ...(signal === undefined ? {} : { signal }),
    });
    if (!response.ok) {
      throw new Error(`OpenAI Codex device code request failed (${response.status})`);
    }

    const body = await readJson(response, "device code");
    if (!isRecord(body)) throw malformedDeviceResponse();
    const interval = typeof body.interval === "string"
      ? Number(body.interval.trim())
      : body.interval;
    if (
      typeof body.device_auth_id !== "string"
      || body.device_auth_id.length === 0
      || typeof body.user_code !== "string"
      || body.user_code.length === 0
      || typeof interval !== "number"
      || !Number.isFinite(interval)
      || interval < 0
    ) {
      throw malformedDeviceResponse();
    }

    return {
      deviceAuthId: body.device_auth_id,
      userCode: body.user_code,
      verificationUri: DEVICE_VERIFICATION_URI,
      intervalSeconds: interval,
    };
  }

  async completeDeviceLogin(
    attempt: DeviceLoginAttempt,
    signal?: AbortSignal,
  ): Promise<OAuthCredential> {
    const deadline = this.#now() + DEVICE_TIMEOUT_MS;
    // interval=0인 테스트나 서버 응답에서도 무한 tight loop가 되지 않도록 횟수 상한을 함께 둔다.
    for (let pollCount = 0; pollCount < 900 && this.#now() <= deadline; pollCount += 1) {
      if (pollCount > 0) await this.#sleep(attempt.intervalSeconds * 1_000);
      const response = await this.#fetch(DEVICE_TOKEN_URL, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          device_auth_id: attempt.deviceAuthId,
          user_code: attempt.userCode,
        }),
        ...(signal === undefined ? {} : { signal }),
      });

      if (response.status === 403 || response.status === 404) continue;
      if (!response.ok) {
        const body = await readJson(response, "device polling", true);
        if (isPendingDeviceResponse(body)) continue;
        if (isSlowDownResponse(body)) {
          await this.#sleep(5_000);
          continue;
        }
        throw new Error(`OpenAI Codex device authorization failed (${response.status})`);
      }

      const body = await readJson(response, "device authorization");
      if (
        !isRecord(body)
        || typeof body.authorization_code !== "string"
        || typeof body.code_verifier !== "string"
      ) {
        throw new Error("OpenAI Codex device authorization response is malformed");
      }
      return this.#exchangeCode(
        body.authorization_code,
        body.code_verifier,
        OPENAI_CODEX_DEVICE_REDIRECT_URI,
        signal,
      );
    }
    throw new Error("OpenAI Codex device authorization timed out");
  }

  async #exchangeCode(
    code: string,
    verifier: string,
    redirectUri: string,
    signal?: AbortSignal,
  ): Promise<OAuthCredential> {
    return this.#requestCredential(new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri,
      client_id: OPENAI_CODEX_CLIENT_ID,
      code_verifier: verifier,
    }), "exchange", signal);
  }

  async #requestCredential(
    form: URLSearchParams,
    operation: "exchange" | "refresh",
    signal?: AbortSignal,
  ): Promise<OAuthCredential> {
    const response = await this.#fetch(TOKEN_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: form,
      ...(signal === undefined ? {} : { signal }),
    });
    if (!response.ok) {
      // token endpoint의 body에는 민감한 진단 정보가 섞일 수 있어 status만 상위로 전달한다.
      throw new Error(`OpenAI Codex token ${operation} failed (${response.status})`);
    }

    const body = await readJson(response, `token ${operation}`);
    if (
      !isRecord(body)
      || typeof body.access_token !== "string"
      || body.access_token.length === 0
      || typeof body.refresh_token !== "string"
      || body.refresh_token.length === 0
      || typeof body.expires_in !== "number"
      || !Number.isFinite(body.expires_in)
      || body.expires_in < 0
    ) {
      throw new Error(`OpenAI Codex token ${operation} response is malformed`);
    }

    return {
      accessToken: body.access_token,
      refreshToken: body.refresh_token,
      expiresAt: this.#now() + body.expires_in * 1_000,
      accountId: accountIdFromAccessToken(body.access_token),
    };
  }
}

function parseCallbackInput(value: string): {
  readonly code: string | undefined;
  readonly state: string | undefined;
} {
  try {
    const url = new URL(value);
    return {
      code: url.searchParams.get("code") ?? undefined,
      state: url.searchParams.get("state") ?? undefined,
    };
  } catch {
    const params = new URLSearchParams(value);
    return {
      code: params.get("code") ?? undefined,
      state: params.get("state") ?? undefined,
    };
  }
}

async function readJson(
  response: Response,
  operation: string,
  allowInvalid = false,
): Promise<unknown> {
  try {
    return await response.json() as unknown;
  } catch {
    if (allowInvalid) return undefined;
    throw new Error(`OpenAI Codex ${operation} response is not JSON`);
  }
}

function malformedDeviceResponse(): Error {
  return new Error("OpenAI Codex device code response is malformed");
}

function isPendingDeviceResponse(value: unknown): boolean {
  if (!isRecord(value)) return false;
  const error = value.error;
  if (error === "deviceauth_authorization_pending") return true;
  return isRecord(error) && error.code === "deviceauth_authorization_pending";
}

function isSlowDownResponse(value: unknown): boolean {
  if (!isRecord(value)) return false;
  const error = value.error;
  if (error === "slow_down") return true;
  return isRecord(error) && error.code === "slow_down";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
