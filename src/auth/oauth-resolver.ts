import type { OAuthCredential } from "./oauth-contracts.js";
import type { OAuthStore } from "./oauth-store.js";

export type AuthRequiredReason = "missing" | "refresh_failed";

/**
 * Provider가 UI를 직접 열지 않고 "로그인이 필요하다"는 상태만 상위에 알리는 오류다.
 * CLI는 reason을 사용자 문장으로 바꾸고, 서버 사용자는 자신의 인증 흐름으로 처리할 수 있다.
 */
export class AuthRequiredError extends Error {
  readonly name = "AuthRequiredError";
  readonly reason: AuthRequiredReason;

  constructor(reason: AuthRequiredReason, options?: ErrorOptions) {
    super(
      reason === "missing"
        ? "OpenAI Codex login is required"
        : "OpenAI Codex login must be renewed",
      options,
    );
    this.reason = reason;
  }
}

export interface OAuthRefresher {
  refresh(refreshToken: string, signal?: AbortSignal): Promise<OAuthCredential>;
}

export interface OAuthResolverOptions {
  readonly provider: string;
  readonly store: OAuthStore;
  readonly refresher: OAuthRefresher;
  readonly now?: () => number;
  readonly expirySkewMs?: number;
}

/**
 * 저장된 credential을 Provider가 지금 사용할 수 있는 credential로 해석한다.
 *
 * 빠른 경로의 get은 유효 token을 잠금 없이 반환한다. 만료 경로만 modify를 사용하고
 * 잠금 안에서 다시 확인하므로 동시 호출 중 먼저 갱신된 token을 뒤 호출이 재사용한다.
 */
export class OAuthResolver {
  readonly #provider: string;
  readonly #store: OAuthStore;
  readonly #refresher: OAuthRefresher;
  readonly #now: () => number;
  readonly #expirySkewMs: number;

  constructor(options: OAuthResolverOptions) {
    this.#provider = options.provider;
    this.#store = options.store;
    this.#refresher = options.refresher;
    this.#now = options.now ?? Date.now;
    this.#expirySkewMs = options.expirySkewMs ?? 60_000;
  }

  async resolve(signal?: AbortSignal): Promise<OAuthCredential> {
    const current = await this.#store.get(this.#provider);
    if (current === undefined) throw new AuthRequiredError("missing");
    if (!this.#isExpired(current)) return current;

    const resolved = await this.#store.modify(this.#provider, async (latest) => {
      if (latest === undefined) throw new AuthRequiredError("missing");
      // 잠금을 기다리는 동안 다른 호출이 갱신했다면 network refresh를 반복하지 않는다.
      if (!this.#isExpired(latest)) return latest;

      try {
        return await this.#refresher.refresh(latest.refreshToken, signal);
      } catch {
        // 하위 구현이 token을 오류 문장에 넣었을 가능성까지 차단하려고 raw cause를 보존하지 않는다.
        throw new AuthRequiredError("refresh_failed", {
          cause: new Error("OpenAI Codex credential refresh failed"),
        });
      }
    });

    if (resolved === undefined) {
      // 현재 updater는 undefined를 반환하지 않지만 Store 구현 교체에도 반환 계약을 방어한다.
      throw new AuthRequiredError("missing");
    }
    return resolved;
  }

  #isExpired(credential: OAuthCredential): boolean {
    // 요청 중 만료되는 경계값을 피하려고 실제 만료보다 조금 일찍 refresh한다.
    return credential.expiresAt <= this.#now() + this.#expirySkewMs;
  }
}
