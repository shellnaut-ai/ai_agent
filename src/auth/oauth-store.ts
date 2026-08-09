import type { OAuthCredential } from "./oauth-contracts.js";

export type OAuthCredentialUpdater = (
  current: OAuthCredential | undefined,
) => OAuthCredential | undefined | Promise<OAuthCredential | undefined>;

/**
 * 인증 사용자 경험과 저장 매체를 분리하는 최소 계약이다.
 *
 * 특히 modify는 "읽기 → 판단 → 쓰기" 전체를 하나의 임계 구역으로 묶는다. refresh처럼
 * 현재 값에 의존하는 변경을 get/set 두 호출로 구현하면 다른 프로세스의 갱신을 덮어쓸 수 있다.
 */
export interface OAuthStore {
  get(provider: string): Promise<OAuthCredential | undefined>;
  set(provider: string, credential: OAuthCredential): Promise<void>;
  delete(provider: string): Promise<void>;
  modify(provider: string, update: OAuthCredentialUpdater): Promise<OAuthCredential | undefined>;
}
