import type {
  BrowserLoginAttempt,
  DeviceLoginAttempt,
} from "../auth/openai-codex-oauth.js";
import type { OAuthCredential } from "../auth/oauth-contracts.js";
import type { OAuthStore } from "../auth/oauth-store.js";

export interface CliIo {
  write(line: string): void;
  prompt?(question: string): Promise<string | undefined>;
}

export interface AuthOAuthClient {
  beginBrowserLogin(): BrowserLoginAttempt;
  completeBrowserLogin(
    callback: string,
    attempt: BrowserLoginAttempt,
  ): Promise<OAuthCredential>;
  beginDeviceLogin(): Promise<DeviceLoginAttempt>;
  completeDeviceLogin(attempt: DeviceLoginAttempt): Promise<OAuthCredential>;
}

export interface PreparedCallback {
  readonly wait: Promise<string>;
  close(): Promise<void>;
}

export interface AuthCommandDependencies {
  readonly provider: string;
  readonly store: OAuthStore;
  readonly io: CliIo;
  readonly oauth: AuthOAuthClient;
  openUrl(url: string): Promise<boolean>;
  prepareCallback(attempt: BrowserLoginAttempt): Promise<PreparedCallback>;
}

/**
 * 인증 관련 argv만 처리하고 자신의 명령이 아니면 false를 반환한다.
 *
 * 상위 CLI가 auth와 chat을 같은 process에 조립해도 이 함수는 Agent나 stdin 대화 루프를
 * 만들지 않는다. OAuth callback과 대화 prompt가 stdin을 동시에 점유하지 않게 하는 경계다.
 */
export async function runAuthCommand(
  args: readonly string[],
  dependencies: AuthCommandDependencies,
): Promise<boolean> {
  const command = args[0];
  if (command === "status") {
    const credential = await dependencies.store.get(dependencies.provider);
    if (credential === undefined) {
      dependencies.io.write("로그인되지 않았습니다.");
    } else {
      // access/refresh token은 절대 출력하지 않고 사용자가 구분할 최소 메타데이터만 보여준다.
      dependencies.io.write(
        `로그인됨 · 계정 ${credential.accountId} · 만료 ${new Date(credential.expiresAt).toISOString()}`,
      );
    }
    return true;
  }

  if (command === "logout") {
    await dependencies.store.delete(dependencies.provider);
    dependencies.io.write("로그아웃되었습니다.");
    return true;
  }

  if (command !== "login") return false;

  if (args.includes("--device")) {
    const attempt = await dependencies.oauth.beginDeviceLogin();
    dependencies.io.write(`브라우저에서 다음 주소를 여세요: ${attempt.verificationUri}`);
    dependencies.io.write(`인증 코드: ${attempt.userCode}`);
    await dependencies.openUrl(attempt.verificationUri);
    const credential = await dependencies.oauth.completeDeviceLogin(attempt);
    await dependencies.store.set(dependencies.provider, credential);
    dependencies.io.write("로그인이 완료되었습니다.");
    return true;
  }

  const attempt = dependencies.oauth.beginBrowserLogin();
  // localhost가 실제로 listen 중인 것을 확인한 다음 브라우저를 열어 빠른 redirect 유실을 막는다.
  const callback = await dependencies.prepareCallback(attempt);
  try {
    const opened = await dependencies.openUrl(attempt.url);
    if (!opened) {
      dependencies.io.write(`브라우저에서 다음 주소를 여세요: ${attempt.url}`);
    }
    let callbackInput: string;
    try {
      callbackInput = await callback.wait;
    } catch (error) {
      if (dependencies.io.prompt === undefined) throw error;
      dependencies.io.write("자동 callback을 받지 못했습니다. redirect URL을 붙여 넣으세요.");
      const pasted = await dependencies.io.prompt("redirect URL> ");
      if (pasted === undefined) throw new Error("OAuth redirect input was closed");
      callbackInput = pasted;
    }
    const credential = await dependencies.oauth.completeBrowserLogin(callbackInput, attempt);
    await dependencies.store.set(dependencies.provider, credential);
    dependencies.io.write("로그인이 완료되었습니다.");
  } finally {
    // callback이 이미 server.close를 호출했어도 close는 idempotent하게 안전해야 한다.
    await callback.close().catch(() => undefined);
  }
  return true;
}
