import { describe, expect, it } from "vitest";

import type { OAuthCredential } from "../auth/oauth-contracts.js";
import { MemoryOAuthStore } from "../auth/memory-oauth-store.js";
import {
  runAuthCommand,
  type AuthCommandDependencies,
  type CliIo,
} from "./auth-commands.js";

const credential: OAuthCredential = {
  accessToken: "access",
  refreshToken: "refresh",
  expiresAt: 5_000,
  accountId: "account-1",
};

describe("auth CLI commands", () => {
  it("shows login status without printing token values", async () => {
    const output: string[] = [];
    const store = new MemoryOAuthStore({ "openai-codex": credential });

    await expect(runAuthCommand(["status"], dependencies(store, output))).resolves.toBe(true);

    expect(output.join("\n")).toContain("로그인됨");
    expect(output.join("\n")).toContain("account-1");
    expect(output.join("\n")).not.toMatch(/access|refresh/);
  });

  it("runs browser login, waits for the callback, and stores the credential", async () => {
    const output: string[] = [];
    const store = new MemoryOAuthStore();
    const deps = dependencies(store, output);
    let openedUrl: string | undefined;
    deps.openUrl = async (url) => {
      openedUrl = url;
      return true;
    };

    await expect(runAuthCommand(["login"], deps)).resolves.toBe(true);

    expect(openedUrl).toBe("https://auth.example/authorize");
    await expect(store.get("openai-codex")).resolves.toEqual(credential);
    expect(output.join("\n")).toContain("로그인이 완료되었습니다");
  });

  it("supports device login and prints the verification code", async () => {
    const output: string[] = [];
    const store = new MemoryOAuthStore();

    await expect(runAuthCommand(
      ["login", "--device"],
      dependencies(store, output),
    )).resolves.toBe(true);

    expect(output.join("\n")).toContain("https://auth.example/device");
    expect(output.join("\n")).toContain("ABCD-EFGH");
    await expect(store.get("openai-codex")).resolves.toEqual(credential);
  });

  it("deletes the credential on logout", async () => {
    const output: string[] = [];
    const store = new MemoryOAuthStore({ "openai-codex": credential });

    await expect(runAuthCommand(["logout"], dependencies(store, output))).resolves.toBe(true);

    await expect(store.get("openai-codex")).resolves.toBeUndefined();
    expect(output.join("\n")).toContain("로그아웃되었습니다");
  });
});

function dependencies(
  store: MemoryOAuthStore,
  output: string[],
): AuthCommandDependencies {
  const io: CliIo = {
    write(line) {
      output.push(line);
    },
  };
  return {
    provider: "openai-codex",
    store,
    io,
    oauth: {
      beginBrowserLogin() {
        return {
          url: "https://auth.example/authorize",
          state: "state-1",
          verifier: "verifier-1",
          redirectUri: "http://localhost:1455/auth/callback",
        };
      },
      async completeBrowserLogin(callback, attempt) {
        expect(callback).toContain(`state=${attempt.state}`);
        return credential;
      },
      async beginDeviceLogin() {
        return {
          deviceAuthId: "device-1",
          userCode: "ABCD-EFGH",
          verificationUri: "https://auth.example/device",
          intervalSeconds: 0,
        };
      },
      async completeDeviceLogin() {
        return credential;
      },
    },
    openUrl: async () => true,
    prepareCallback: async (attempt) => ({
      wait: Promise.resolve(
        `${attempt.redirectUri}?code=code-1&state=${attempt.state}`,
      ),
      close: async () => undefined,
    }),
  };
}
