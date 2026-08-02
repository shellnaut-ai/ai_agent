import { randomUUID } from "node:crypto";
import { cwd, env } from "node:process";
import { resolve } from "node:path";

import { FileOAuthStore } from "../auth/file-oauth-store.js";
import { OpenAICodexOAuth } from "../auth/openai-codex-oauth.js";
import { OAuthResolver } from "../auth/oauth-resolver.js";
import { runAuthCommand } from "./auth-commands.js";
import { runChatCommand } from "./chat-command.js";
import { runCliApplication } from "./cli-application.js";
import { NodeCliIo } from "./node-cli-io.js";
import { openExternalUrl } from "./open-url.js";
import { startOAuthCallbackServer } from "./oauth-callback-server.js";
import { createAgentRuntime } from "./runtime.js";

const PROVIDER_ID = "openai-codex";
// 최신 Pi의 openai-codex 기본값과 맞춰 ChatGPT OAuth에서 폐기된 모델을 고르지 않는다.
export const DEFAULT_CODEX_MODEL = "gpt-5.5";

/**
 * 실제 process 자원은 이 composition root 한 곳에서만 만든다.
 * 하위 모듈은 fetch, Store, IO가 주입되므로 credential 없이도 자동 테스트할 수 있다.
 */
export async function main(args: readonly string[]): Promise<number> {
  const io = new NodeCliIo();
  const store = new FileOAuthStore();
  const oauth = new OpenAICodexOAuth();
  const resolver = new OAuthResolver({
    provider: PROVIDER_ID,
    store,
    refresher: oauth,
  });

  try {
    return await runCliApplication(args, {
      write: (line) => io.write(line),
      runAuth: (authArgs) => runAuthCommand(authArgs, {
        provider: PROVIDER_ID,
        store,
        oauth,
        io,
        openUrl: openExternalUrl,
        prepareCallback: async (attempt) => {
          const callback = await startOAuthCallbackServer({
            redirectUri: attempt.redirectUri,
            expectedState: attempt.state,
          });
          return { wait: callback.wait, close: () => callback.close() };
        },
      }),
      runChat: (chatArgs) => runChatCommand(chatArgs, {
        io,
        defaultModel: env.PI_CLONE_MODEL ?? DEFAULT_CODEX_MODEL,
        createAgent: async (request) => {
          const workspace = cwd();
          const sessionPath = request.sessionPath === undefined
            ? resolve(
                workspace,
                ".pi-clone",
                "sessions",
                `${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID()}.jsonl`,
              )
            : resolve(workspace, request.sessionPath);
          io.write(`세션 기록: ${sessionPath}`);
          return createAgentRuntime({
            workspace,
            sessionPath,
            model: request.model,
            resolver,
            instructions:
              "You are a careful coding assistant. Use the read tool when file contents are needed.",
          });
        },
      }),
    });
  } finally {
    io.close();
  }
}
