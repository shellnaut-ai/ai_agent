import { describe, expect, it } from "vitest";

import {
  OPENAI_CODEX_CLIENT_ID,
  OPENAI_CODEX_DEVICE_REDIRECT_URI,
  OpenAICodexOAuth,
} from "./openai-codex-oauth.js";

function accessToken(accountId: string): string {
  const payload = Buffer.from(JSON.stringify({
    "https://api.openai.com/auth": { chatgpt_account_id: accountId },
  }), "utf8").toString("base64url");
  return `header.${payload}.signature`;
}

describe("OpenAICodexOAuth browser flow", () => {
  it("builds the Pi-compatible authorization URL with PKCE and state", () => {
    const oauth = new OpenAICodexOAuth({
      fetch: async () => { throw new Error("network must not be called"); },
      randomBytes: (size) => Buffer.alloc(size, 7),
    });

    const attempt = oauth.beginBrowserLogin();
    const url = new URL(attempt.url);

    expect(url.origin + url.pathname).toBe("https://auth.openai.com/oauth/authorize");
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      response_type: "code",
      client_id: OPENAI_CODEX_CLIENT_ID,
      redirect_uri: "http://localhost:1455/auth/callback",
      scope: "openid profile email offline_access",
      code_challenge_method: "S256",
      state: attempt.state,
      id_token_add_organizations: "true",
      codex_cli_simplified_flow: "true",
      originator: "pi",
    });
    expect(url.searchParams.get("code_challenge")).not.toBe(attempt.verifier);
  });

  it("validates callback state before exchanging a code", async () => {
    let calls = 0;
    const oauth = new OpenAICodexOAuth({
      fetch: async () => {
        calls += 1;
        throw new Error("must not exchange a mismatched callback");
      },
      randomBytes: (size) => Buffer.alloc(size, 1),
    });
    const attempt = oauth.beginBrowserLogin();

    await expect(oauth.completeBrowserLogin(
      "http://localhost:1455/auth/callback?code=code-1&state=other",
      attempt,
    )).rejects.toThrow("OAuth callback state does not match the login request");
    expect(calls).toBe(0);
  });

  it("exchanges the authorization code and returns a validated credential", async () => {
    let captured: Request | undefined;
    const oauth = new OpenAICodexOAuth({
      fetch: async (input, init) => {
        captured = new Request(input, init);
        return Response.json({
          access_token: accessToken("account-1"),
          refresh_token: "refresh-1",
          expires_in: 3600,
        });
      },
      now: () => 1_000,
      randomBytes: (size) => Buffer.alloc(size, 2),
    });
    const attempt = oauth.beginBrowserLogin();

    await expect(oauth.completeBrowserLogin(
      `${attempt.redirectUri}?code=code-1&state=${attempt.state}`,
      attempt,
    )).resolves.toEqual({
      accessToken: accessToken("account-1"),
      refreshToken: "refresh-1",
      expiresAt: 3_601_000,
      accountId: "account-1",
    });

    expect(captured?.url).toBe("https://auth.openai.com/oauth/token");
    expect(captured?.method).toBe("POST");
    expect(captured?.headers.get("content-type")).toContain(
      "application/x-www-form-urlencoded",
    );
    expect(await captured?.text()).toBe(new URLSearchParams({
      grant_type: "authorization_code",
      code: "code-1",
      redirect_uri: attempt.redirectUri,
      client_id: OPENAI_CODEX_CLIENT_ID,
      code_verifier: attempt.verifier,
    }).toString());
  });

  it("refreshes without returning token response details in malformed-response errors", async () => {
    const oauth = new OpenAICodexOAuth({
      fetch: async () => Response.json({
        access_token: "secret-access",
        refresh_token: "secret-refresh",
      }),
    });

    await expect(oauth.refresh("old-secret-refresh")).rejects.toThrow(
      "OpenAI Codex token refresh response is malformed",
    );
    await expect(oauth.refresh("old-secret-refresh")).rejects.not.toThrow(
      /secret-access|secret-refresh|old-secret-refresh/,
    );
  });
});

describe("OpenAICodexOAuth device flow", () => {
  it("polls pending authorization and exchanges the device code", async () => {
    const requests: Request[] = [];
    const responses = [
      Response.json({
        device_auth_id: "device-1",
        user_code: "ABCD-EFGH",
        interval: "0",
      }),
      new Response("", { status: 403 }),
      Response.json({
        authorization_code: "authorization-1",
        code_verifier: "device-verifier",
      }),
      Response.json({
        access_token: accessToken("account-device"),
        refresh_token: "refresh-device",
        expires_in: 60,
      }),
    ];
    const oauth = new OpenAICodexOAuth({
      fetch: async (input, init) => {
        requests.push(new Request(input, init));
        const response = responses.shift();
        if (response === undefined) throw new Error("unexpected request");
        return response;
      },
      now: () => 5_000,
      sleep: async () => undefined,
    });

    const device = await oauth.beginDeviceLogin();
    expect(device).toEqual({
      deviceAuthId: "device-1",
      userCode: "ABCD-EFGH",
      verificationUri: "https://auth.openai.com/codex/device",
      intervalSeconds: 0,
    });
    await expect(oauth.completeDeviceLogin(device)).resolves.toMatchObject({
      accountId: "account-device",
      refreshToken: "refresh-device",
      expiresAt: 65_000,
    });

    expect(requests.map((request) => request.url)).toEqual([
      "https://auth.openai.com/api/accounts/deviceauth/usercode",
      "https://auth.openai.com/api/accounts/deviceauth/token",
      "https://auth.openai.com/api/accounts/deviceauth/token",
      "https://auth.openai.com/oauth/token",
    ]);
    await expect(requests[3]?.text()).resolves.toContain(
      `redirect_uri=${encodeURIComponent(OPENAI_CODEX_DEVICE_REDIRECT_URI)}`,
    );
  });
});
