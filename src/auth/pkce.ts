import { createHash, randomBytes } from "node:crypto";

export interface PkcePair {
  readonly verifier: string;
  readonly challenge: string;
  readonly method: "S256";
}

export type RandomBytesSource = (size: number) => Uint8Array;

/**
 * OAuth authorization code가 탈취돼도 verifier 없이는 token으로 교환하지 못하게 한다.
 * 난수 주입점은 보안 알고리즘을 바꾸기 위한 것이 아니라 테스트를 결정론적으로 만들기 위한 경계다.
 */
export function createPkcePair(
  randomSource: RandomBytesSource = randomBytes,
): PkcePair {
  const verifier = Buffer.from(randomSource(32)).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge, method: "S256" };
}

/** callback이 우리가 시작한 로그인과 같은 요청인지 대조할 일회성 state를 만든다. */
export function createOAuthState(
  randomSource: RandomBytesSource = randomBytes,
): string {
  return Buffer.from(randomSource(32)).toString("base64url");
}
