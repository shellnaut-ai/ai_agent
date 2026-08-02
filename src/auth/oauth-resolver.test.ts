import { describe, expect, it } from "vitest";

import type { OAuthCredential } from "./oauth-contracts.js";
import { MemoryOAuthStore } from "./memory-oauth-store.js";
import {
  AuthRequiredError,
  OAuthResolver,
  type OAuthRefresher,
} from "./oauth-resolver.js";

const expired: OAuthCredential = {
  accessToken: "expired-access",
  refreshToken: "old-secret-refresh",
  expiresAt: 900,
  accountId: "account-1",
};
const fresh: OAuthCredential = {
  accessToken: "fresh-access",
  refreshToken: "fresh-refresh",
  expiresAt: 10_000,
  accountId: "account-1",
};

describe("OAuthResolver", () => {
  it("throws a typed login-required error when no credential is stored", async () => {
    const resolver = new OAuthResolver({
      provider: "openai-codex",
      store: new MemoryOAuthStore(),
      refresher: neverRefresh(),
      now: () => 1_000,
      expirySkewMs: 0,
    });

    await expect(resolver.resolve()).rejects.toMatchObject({
      name: "AuthRequiredError",
      reason: "missing",
      message: "OpenAI Codex login is required",
    });
  });

  it("returns a valid credential without calling the refresh endpoint", async () => {
    let refreshCalls = 0;
    const resolver = new OAuthResolver({
      provider: "openai-codex",
      store: new MemoryOAuthStore({ "openai-codex": fresh }),
      refresher: {
        async refresh() {
          refreshCalls += 1;
          throw new Error("unexpected refresh");
        },
      },
      now: () => 1_000,
      expirySkewMs: 0,
    });

    await expect(resolver.resolve()).resolves.toEqual(fresh);
    expect(refreshCalls).toBe(0);
  });

  it("refreshes an expired credential and stores the rotated token", async () => {
    const store = new MemoryOAuthStore({ "openai-codex": expired });
    const resolver = new OAuthResolver({
      provider: "openai-codex",
      store,
      refresher: { refresh: async () => fresh },
      now: () => 1_000,
      expirySkewMs: 0,
    });

    await expect(resolver.resolve()).resolves.toEqual(fresh);
    await expect(store.get("openai-codex")).resolves.toEqual(fresh);
  });

  it("double-checks under the Store lock so concurrent callers refresh once", async () => {
    const store = new MemoryOAuthStore({ "openai-codex": expired });
    let refreshCalls = 0;
    let releaseRefresh: (() => void) | undefined;
    const mayFinish = new Promise<void>((resolve) => { releaseRefresh = resolve; });
    const refresher: OAuthRefresher = {
      async refresh() {
        refreshCalls += 1;
        await mayFinish;
        return fresh;
      },
    };
    const resolver = new OAuthResolver({
      provider: "openai-codex",
      store,
      refresher,
      now: () => 1_000,
      expirySkewMs: 0,
    });

    const first = resolver.resolve();
    const second = resolver.resolve();
    await Promise.resolve();
    releaseRefresh?.();

    await expect(Promise.all([first, second])).resolves.toEqual([fresh, fresh]);
    expect(refreshCalls).toBe(1);
  });

  it("normalizes refresh failure without exposing the refresh token", async () => {
    const resolver = new OAuthResolver({
      provider: "openai-codex",
      store: new MemoryOAuthStore({ "openai-codex": expired }),
      refresher: {
        async refresh(refreshToken) {
          throw new Error(`endpoint rejected ${refreshToken}`);
        },
      },
      now: () => 1_000,
      expirySkewMs: 0,
    });

    const error = await resolver.resolve().catch((value: unknown) => value);
    expect(error).toBeInstanceOf(AuthRequiredError);
    expect(error).toMatchObject({
      reason: "refresh_failed",
      message: "OpenAI Codex login must be renewed",
    });
    expect(String(error)).not.toContain("old-secret-refresh");
    expect(String((error as Error).cause)).not.toContain("old-secret-refresh");
  });
});

function neverRefresh(): OAuthRefresher {
  return {
    async refresh() {
      throw new Error("refresh must not be called");
    },
  };
}
