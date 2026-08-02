import { randomUUID } from "node:crypto";
import {
  mkdir,
  open,
  readFile,
  rename,
  stat,
  unlink,
  utimes,
  type FileHandle,
} from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import {
  parseOAuthCredential,
  type OAuthCredential,
} from "./oauth-contracts.js";
import type { OAuthCredentialUpdater, OAuthStore } from "./oauth-store.js";

export interface FileOAuthStoreOptions {
  readonly lockRetryMs?: number;
  readonly lockTimeoutMs?: number;
  readonly lockStaleMs?: number;
}

export function defaultOAuthFilePath(home: string = homedir()): string {
  // 소스 저장소 안에 token이 생기지 않도록 사용자별 설정 디렉터리를 기본값으로 둔다.
  return join(home, ".pi-clone", "auth.json");
}

/**
 * OAuth 자격 증명을 저장소 밖 JSON 파일에 보존하는 실제 Store다.
 *
 * lock file은 여러 CLI 프로세스의 modify 임계 구역을 직렬화한다. 본문은 임시 파일에
 * 완전히 기록한 뒤 rename하여 get이 절반짜리 JSON을 읽는 시간을 만들지 않는다.
 */
export class FileOAuthStore implements OAuthStore {
  readonly #filePath: string;
  readonly #lockRetryMs: number;
  readonly #lockTimeoutMs: number;
  readonly #lockStaleMs: number;

  constructor(
    filePath: string = defaultOAuthFilePath(),
    options: FileOAuthStoreOptions = {},
  ) {
    this.#filePath = filePath;
    this.#lockRetryMs = options.lockRetryMs ?? 20;
    // OAuth refresh는 일반 파일 쓰기보다 오래 걸릴 수 있어 기본 5초보다 넉넉히 기다린다.
    this.#lockTimeoutMs = options.lockTimeoutMs ?? 30_000;
    this.#lockStaleMs = options.lockStaleMs ?? 60_000;
  }

  async get(provider: string): Promise<OAuthCredential | undefined> {
    const document = await this.#readDocument();
    return document[provider];
  }

  async set(provider: string, credential: OAuthCredential): Promise<void> {
    await this.modify(provider, () => credential);
  }

  async delete(provider: string): Promise<void> {
    await this.modify(provider, () => undefined);
  }

  async modify(
    provider: string,
    update: OAuthCredentialUpdater,
  ): Promise<OAuthCredential | undefined> {
    await mkdir(dirname(this.#filePath), { recursive: true, mode: 0o700 });
    const release = await this.#acquireLock();

    try {
      // 잠금을 얻기 전에 읽은 값은 이미 낡았을 수 있으므로 반드시 여기서 다시 읽는다.
      const document = await this.#readDocument();
      const next = await update(document[provider]);
      if (next === undefined) {
        delete document[provider];
      } else {
        // 메모리에서 만든 값도 같은 runtime validator를 통과시켜 파일 구조를 일정하게 둔다.
        document[provider] = parseOAuthCredential(next);
      }
      await this.#writeDocument(document);
      return next;
    } finally {
      await release();
    }
  }

  async #readDocument(): Promise<Record<string, OAuthCredential>> {
    let contents: string;
    try {
      contents = await readFile(this.#filePath, "utf8");
    } catch (error: unknown) {
      if (isNodeError(error, "ENOENT")) return {};
      throw new Error(`Cannot read OAuth credentials from ${this.#filePath}`, { cause: error });
    }

    try {
      const parsed = JSON.parse(contents) as unknown;
      if (!isRecord(parsed)) throw new Error("auth document must be an object");
      return Object.fromEntries(
        Object.entries(parsed).map(([provider, credential]) => [
          provider,
          parseOAuthCredential(credential),
        ]),
      );
    } catch (error: unknown) {
      // JSON이나 token 원문은 오류에 포함하지 않는다. 경로와 cause만으로 진단한다.
      throw new Error(`Cannot read OAuth credentials from ${this.#filePath}`, { cause: error });
    }
  }

  async #writeDocument(document: Readonly<Record<string, OAuthCredential>>): Promise<void> {
    const temporaryPath = `${this.#filePath}.${randomUUID()}.tmp`;
    let handle: FileHandle | undefined;
    try {
      handle = await open(temporaryPath, "wx", 0o600);
      await handle.writeFile(`${JSON.stringify(document, null, 2)}\n`, "utf8");
      await handle.sync();
      await handle.close();
      handle = undefined;
      await rename(temporaryPath, this.#filePath);
    } catch (error) {
      await handle?.close().catch(() => undefined);
      await unlink(temporaryPath).catch(() => undefined);
      throw error;
    }
  }

  async #acquireLock(): Promise<() => Promise<void>> {
    const lockPath = `${this.#filePath}.lock`;
    const deadline = Date.now() + this.#lockTimeoutMs;

    while (true) {
      try {
        const handle = await open(lockPath, "wx", 0o600);
        await handle.writeFile(JSON.stringify({
          pid: process.pid,
          acquiredAt: new Date().toISOString(),
        }), "utf8");
        let heartbeatWork = Promise.resolve();
        const heartbeat = setInterval(() => {
          const now = new Date();
          heartbeatWork = heartbeatWork
            .then(() => utimes(lockPath, now, now))
            .catch(() => undefined);
        }, Math.max(10, Math.floor(this.#lockStaleMs / 3)));
        heartbeat.unref();
        let released = false;
        return async () => {
          if (released) return;
          released = true;
          clearInterval(heartbeat);
          // clearInterval은 이미 시작된 비동기 utimes까지 취소하지 않는다. Windows에서
          // 그 작업과 unlink가 겹치면 EPERM이 날 수 있으므로 모든 heartbeat를 기다린다.
          await heartbeatWork;
          try {
            await handle.close();
          } finally {
            await unlink(lockPath).catch((error: unknown) => {
              if (!isNodeError(error, "ENOENT")) throw error;
            });
          }
        };
      } catch (error: unknown) {
        if (!isNodeError(error, "EEXIST")) throw error;
        if (await this.#isStaleLock(lockPath)) {
          // 소유 process가 죽어 heartbeat가 멈춘 lock만 회수한다.
          await unlink(lockPath).catch((unlinkError: unknown) => {
            if (!isNodeError(unlinkError, "ENOENT")) throw unlinkError;
          });
          continue;
        }
        if (Date.now() >= deadline) {
          throw new Error(`Timed out waiting for OAuth store lock: ${lockPath}`);
        }
        await delay(this.#lockRetryMs);
      }
    }
  }

  async #isStaleLock(lockPath: string): Promise<boolean> {
    try {
      const lockStat = await stat(lockPath);
      return Date.now() - lockStat.mtimeMs > this.#lockStaleMs;
    } catch (error: unknown) {
      if (isNodeError(error, "ENOENT")) return false;
      throw error;
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
