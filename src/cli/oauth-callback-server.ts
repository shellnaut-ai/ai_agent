import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

export interface OAuthCallbackServerOptions {
  readonly redirectUri: string;
  readonly expectedState?: string;
  readonly timeoutMs?: number;
}

export interface OAuthCallbackServer {
  readonly redirectUri: string;
  readonly wait: Promise<string>;
  close(): Promise<void>;
}

/**
 * 브라우저 OAuth redirect 한 번만 받는 localhost 서버를 연다.
 *
 * start 함수가 listen 완료 후 반환하므로 CLI는 이 함수를 먼저 await하고 브라우저를 연다.
 * 반대 순서면 빠른 redirect가 아직 열리지 않은 포트에 도착해 로그인에 실패할 수 있다.
 */
export async function startOAuthCallbackServer(
  options: OAuthCallbackServerOptions,
): Promise<OAuthCallbackServer> {
  const configured = new URL(options.redirectUri);
  if (configured.protocol !== "http:") {
    throw new Error("OAuth callback server requires an http redirect URI");
  }
  if (!isLoopbackHostname(configured.hostname)) {
    // OAuth code를 LAN/WAN 인터페이스에 노출하지 않도록 로컬 loopback만 허용한다.
    throw new Error("OAuth callback server requires a loopback redirect URI");
  }
  const timeoutMs = options.timeoutMs ?? 120_000;
  let resolveWait: ((value: string) => void) | undefined;
  let rejectWait: ((reason: Error) => void) | undefined;
  let settled = false;

  const wait = new Promise<string>((resolve, reject) => {
    resolveWait = resolve;
    rejectWait = reject;
  });
  const server = createServer((request, response) => {
    const actual = actualRedirectUri(server, configured);
    const requestUrl = new URL(request.url ?? "/", actual);
    if (requestUrl.pathname !== configured.pathname) {
      response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      response.end("Not found");
      return;
    }
    if (
      options.expectedState !== undefined
      && requestUrl.searchParams.get("state") !== options.expectedState
    ) {
      // 잘못된 state가 정상 callback보다 먼저 도착해 서버를 닫는 로컬 login CSRF/DoS를 막는다.
      response.writeHead(400, {
        "content-type": "text/plain; charset=utf-8",
        "cache-control": "no-store",
      });
      response.end("Invalid OAuth state");
      return;
    }
    const code = requestUrl.searchParams.get("code");
    if (code === null || code.length === 0) {
      response.writeHead(400, {
        "content-type": "text/plain; charset=utf-8",
        "cache-control": "no-store",
      });
      response.end("Missing OAuth code");
      return;
    }

    response.writeHead(200, {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
    });
    response.end(
      "<!doctype html><meta charset=\"utf-8\"><title>pi-clone OAuth</title>"
      + "<p>로그인이 완료되었습니다. 이 창을 닫아도 됩니다.</p>",
    );
    settled = true;
    resolveWait?.(requestUrl.toString());
    server.close();
  });

  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error): void => reject(error);
    server.once("error", onError);
    server.listen(
      Number(configured.port),
      configured.hostname,
      () => {
        server.off("error", onError);
        resolve();
      },
    );
  });

  const timeout = setTimeout(() => {
    if (settled) return;
    settled = true;
    rejectWait?.(new Error("OAuth callback timed out"));
    server.close();
  }, timeoutMs);
  timeout.unref();

  return {
    redirectUri: actualRedirectUri(server, configured),
    wait: wait.finally(() => clearTimeout(timeout)),
    close: async () => {
      clearTimeout(timeout);
      if (!settled) {
        settled = true;
        rejectWait?.(new Error("OAuth callback server was closed"));
      }
      await closeServer(server);
    },
  };
}

function isLoopbackHostname(hostname: string): boolean {
  return hostname === "localhost"
    || hostname === "127.0.0.1"
    || hostname === "[::1]";
}

function actualRedirectUri(server: Server, configured: URL): string {
  const address = server.address();
  if (address === null || typeof address === "string") return configured.toString();
  const actual = new URL(configured);
  actual.port = String((address as AddressInfo).port);
  return actual.toString();
}

async function closeServer(server: Server): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error === undefined) resolve();
      else reject(error);
    });
  });
}
