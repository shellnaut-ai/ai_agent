import { describe, expect, it } from "vitest";

import {
  OPENAI_AUTH_CLAIM,
  accountIdFromAccessToken,
  parseOAuthCredential,
} from "./oauth-contracts.js";

function jwt(payload: Record<string, unknown>): string {
  const encoded = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  return `header.${encoded}.signature`;
}

describe("OAuth credential contracts", () => {
  it("accepts a complete credential from an untrusted JSON boundary", () => {
    expect(parseOAuthCredential({
      accessToken: "access",
      refreshToken: "refresh",
      expiresAt: 1_800_000_000_000,
      accountId: "account-1",
    })).toEqual({
      accessToken: "access",
      refreshToken: "refresh",
      expiresAt: 1_800_000_000_000,
      accountId: "account-1",
    });
  });

  it.each([
    [{ refreshToken: "refresh", expiresAt: 1, accountId: "account" }, "accessToken"],
    [{ accessToken: "access", expiresAt: 1, accountId: "account" }, "refreshToken"],
    [{ accessToken: "access", refreshToken: "refresh", expiresAt: Number.NaN, accountId: "account" }, "expiresAt"],
    [{ accessToken: "access", refreshToken: "refresh", expiresAt: 1 }, "accountId"],
  ])("rejects a malformed credential at field %s", (value, field) => {
    expect(() => parseOAuthCredential(value)).toThrow(`OAuth credential ${field} is invalid`);
  });

  it("reads the ChatGPT account id claim without trusting other JWT fields", () => {
    expect(accountIdFromAccessToken(jwt({
      sub: "user-1",
      [OPENAI_AUTH_CLAIM]: {
        chatgpt_account_id: "account-1",
        chatgpt_plan_type: "plus",
      },
    }))).toBe("account-1");
  });

  it("rejects an access token without a usable account id claim", () => {
    expect(() => accountIdFromAccessToken(jwt({ sub: "user-1" }))).toThrow(
      "OpenAI access token does not contain a ChatGPT account id",
    );
  });
});
