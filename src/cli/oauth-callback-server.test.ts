import { describe, expect, it } from "vitest";

import { startOAuthCallbackServer } from "./oauth-callback-server.js";

describe("OAuth callback server", () => {
  it("refuses to bind the OAuth callback outside a loopback address", async () => {
    await expect(startOAuthCallbackServer({
      redirectUri: "http://0.0.0.0:0/auth/callback",
    })).rejects.toThrow("loopback");
  });

  it("captures one matching localhost callback and returns a safe success page", async () => {
    const server = await startOAuthCallbackServer({
      redirectUri: "http://127.0.0.1:0/auth/callback",
      timeoutMs: 1_000,
    });
    const callback = new URL(server.redirectUri);
    callback.searchParams.set("code", "code-1");
    callback.searchParams.set("state", "state-1");

    const response = await fetch(callback);

    expect(response.status).toBe(200);
    await expect(response.text()).resolves.toContain("로그인이 완료되었습니다");
    await expect(server.wait).resolves.toBe(callback.toString());
    await expect(server.close()).resolves.toBeUndefined();
  });

  it("rejects a mismatched state without consuming the real callback", async () => {
    const server = await startOAuthCallbackServer({
      redirectUri: "http://127.0.0.1:0/auth/callback",
      expectedState: "expected-state",
      timeoutMs: 1_000,
    });
    const wrong = new URL(server.redirectUri);
    wrong.searchParams.set("code", "wrong-code");
    wrong.searchParams.set("state", "wrong-state");
    const correct = new URL(server.redirectUri);
    correct.searchParams.set("code", "correct-code");
    correct.searchParams.set("state", "expected-state");

    expect((await fetch(wrong)).status).toBe(400);
    expect((await fetch(correct)).status).toBe(200);
    await expect(server.wait).resolves.toBe(correct.toString());
    await server.close();
  });

  it("rejects a callback without a code and keeps waiting", async () => {
    const server = await startOAuthCallbackServer({
      redirectUri: "http://127.0.0.1:0/auth/callback",
      expectedState: "expected-state",
      timeoutMs: 1_000,
    });
    const missingCode = new URL(server.redirectUri);
    missingCode.searchParams.set("state", "expected-state");
    const correct = new URL(missingCode);
    correct.searchParams.set("code", "code-1");

    expect((await fetch(missingCode)).status).toBe(400);
    expect((await fetch(correct)).status).toBe(200);
    await expect(server.wait).resolves.toBe(correct.toString());
    await server.close();
  });
});
