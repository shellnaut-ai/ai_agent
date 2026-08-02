import type { OAuthCredential } from "./oauth-contracts.js";
import type { OAuthCredentialUpdater, OAuthStore } from "./oauth-store.js";

/**
 * 실제 홈 디렉터리와 비밀 파일을 건드리지 않는 결정론적 저장소다.
 *
 * fake가 아니라 OAuthStore의 완전한 메모리 구현으로 두어 login, refresh, CLI 테스트가
 * 제품과 같은 modify 계약을 사용하게 한다.
 */
export class MemoryOAuthStore implements OAuthStore {
  readonly #credentials = new Map<string, OAuthCredential>();
  #modifyTail: Promise<void> = Promise.resolve();

  constructor(initial: Readonly<Record<string, OAuthCredential>> = {}) {
    for (const [provider, credential] of Object.entries(initial)) {
      this.#credentials.set(provider, credential);
    }
  }

  async get(provider: string): Promise<OAuthCredential | undefined> {
    return this.#credentials.get(provider);
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
    // Promise tail은 테스트 안의 동시 호출도 파일 저장소와 같은 순서 보장을 갖게 한다.
    const previous = this.#modifyTail;
    let release: (() => void) | undefined;
    this.#modifyTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;

    try {
      const next = await update(this.#credentials.get(provider));
      if (next === undefined) {
        this.#credentials.delete(provider);
      } else {
        this.#credentials.set(provider, next);
      }
      return next;
    } finally {
      release?.();
    }
  }
}
