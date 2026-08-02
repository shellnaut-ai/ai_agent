import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { OAuthCredential } from "./oauth-contracts.js";
import { FileOAuthStore, defaultOAuthFilePath } from "./file-oauth-store.js";
import { MemoryOAuthStore } from "./memory-oauth-store.js";

const temporaryDirectories: string[] = [];
const first: OAuthCredential = {
  accessToken: "access-1",
  refreshToken: "refresh-1",
  expiresAt: 100,
  accountId: "account-1",
};
const second: OAuthCredential = {
  accessToken: "access-2",
  refreshToken: "refresh-2",
  expiresAt: 200,
  accountId: "account-1",
};

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { force: true, recursive: true })),
  );
});

async function tempAuthFile(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "pi-clone-auth-"));
  temporaryDirectories.push(directory);
  const nested = join(directory, "nested");
  await mkdir(nested);
  return join(nested, "auth.json");
}

describe("MemoryOAuthStore", () => {
  it("stores, reads, and deletes a provider credential", async () => {
    const store = new MemoryOAuthStore();

    await expect(store.get("openai-codex")).resolves.toBeUndefined();
    await store.set("openai-codex", first);
    await expect(store.get("openai-codex")).resolves.toEqual(first);
    await store.delete("openai-codex");
    await expect(store.get("openai-codex")).resolves.toBeUndefined();
  });

  it("serializes modify calls and gives each callback the latest value", async () => {
    const store = new MemoryOAuthStore({ "openai-codex": first });
    const seen: number[] = [];

    await Promise.all([
      store.modify("openai-codex", async (current) => {
        seen.push(current?.expiresAt ?? -1);
        await Promise.resolve();
        return second;
      }),
      store.modify("openai-codex", (current) => {
        seen.push(current?.expiresAt ?? -1);
        return {
          ...second,
          expiresAt: (current?.expiresAt ?? 0) + 1,
        };
      }),
    ]);

    expect(seen).toEqual([100, 200]);
    await expect(store.get("openai-codex")).resolves.toMatchObject({ expiresAt: 201 });
  });
});

describe("FileOAuthStore", () => {
  it("creates the parent directory and persists validated provider credentials", async () => {
    const filePath = await tempAuthFile();
    const store = new FileOAuthStore(filePath);

    await store.set("openai-codex", first);

    await expect(store.get("openai-codex")).resolves.toEqual(first);
    expect(JSON.parse(await readFile(filePath, "utf8"))).toEqual({
      "openai-codex": first,
    });
    if (process.platform !== "win32") {
      expect((await stat(filePath)).mode & 0o777).toBe(0o600);
    }
  });

  it("rejects malformed JSON and credential shapes with the auth file path", async () => {
    const filePath = await tempAuthFile();
    await writeFile(filePath, "{\"openai-codex\":", { encoding: "utf8", mode: 0o600 });
    const store = new FileOAuthStore(filePath);

    await expect(store.get("openai-codex")).rejects.toThrow(
      `Cannot read OAuth credentials from ${filePath}`,
    );

    await writeFile(filePath, JSON.stringify({
      "openai-codex": { accessToken: "secret-but-incomplete" },
    }), "utf8");
    await expect(store.get("openai-codex")).rejects.toThrow(
      `Cannot read OAuth credentials from ${filePath}`,
    );
  });

  it("locks modify across store instances and re-reads the latest file value", async () => {
    const filePath = await tempAuthFile();
    const firstStore = new FileOAuthStore(filePath, { lockRetryMs: 5 });
    const secondStore = new FileOAuthStore(filePath, { lockRetryMs: 5 });
    await firstStore.set("openai-codex", first);

    let releaseFirst: (() => void) | undefined;
    let announceFirst: (() => void) | undefined;
    const firstEntered = new Promise<void>((resolve) => { announceFirst = resolve; });
    const firstMayFinish = new Promise<void>((resolve) => { releaseFirst = resolve; });
    let secondEntered = false;

    const firstModify = firstStore.modify("openai-codex", async (current) => {
      expect(current).toEqual(first);
      announceFirst?.();
      await firstMayFinish;
      return second;
    });
    await firstEntered;

    const secondModify = secondStore.modify("openai-codex", (current) => {
      secondEntered = true;
      expect(current).toEqual(second);
      return { ...second, expiresAt: 201 };
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(secondEntered).toBe(false);

    releaseFirst?.();
    await Promise.all([firstModify, secondModify]);
    await expect(firstStore.get("openai-codex")).resolves.toMatchObject({ expiresAt: 201 });
  });

  it("recovers a stale lock left by a terminated process", async () => {
    const filePath = await tempAuthFile();
    const lockPath = `${filePath}.lock`;
    await writeFile(lockPath, "terminated-owner", "utf8");
    const old = new Date(Date.now() - 10_000);
    await utimes(lockPath, old, old);
    const store = new FileOAuthStore(filePath, {
      lockRetryMs: 5,
      lockTimeoutMs: 100,
      lockStaleMs: 20,
    });

    await expect(store.set("openai-codex", first)).resolves.toBeUndefined();
    await expect(store.get("openai-codex")).resolves.toEqual(first);
  });

  it("heartbeats a slow active modify so another Store does not steal its lock", async () => {
    const filePath = await tempAuthFile();
    const options = { lockRetryMs: 5, lockTimeoutMs: 500, lockStaleMs: 30 };
    const firstStore = new FileOAuthStore(filePath, options);
    const secondStore = new FileOAuthStore(filePath, options);
    await firstStore.set("openai-codex", first);
    let secondEntered = false;

    const slow = firstStore.modify("openai-codex", async () => {
      await new Promise((resolve) => setTimeout(resolve, 90));
      return second;
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    const waiting = secondStore.modify("openai-codex", (current) => {
      secondEntered = true;
      expect(current).toEqual(second);
      return current;
    });

    await new Promise((resolve) => setTimeout(resolve, 45));
    expect(secondEntered).toBe(false);
    await Promise.all([slow, waiting]);
    expect(secondEntered).toBe(true);
  });

  it("uses a user-home path outside the repository by default", () => {
    expect(defaultOAuthFilePath("C:\\Users\\student")).toBe(
      join("C:\\Users\\student", ".pi-clone", "auth.json"),
    );
  });
});
