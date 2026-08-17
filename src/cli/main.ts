import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { AgentLoop } from "../agent/loop.js";
import { FileOAuthStore } from "../auth/file-oauth-store.js";
import { OpenAICodexOAuth } from "../auth/openai-codex-oauth.js";
import { OAuthResolver } from "../auth/oauth-resolver.js";
import { SessionToolApprovalHandler } from "../approval/session.js";
import { CompactionService } from "../context/compaction.js";
import { ContextBudgetCalculator } from "../context/budget.js";
import { TokenEstimator } from "../context/token-estimator.js";
import { createOutputContinuationPolicy } from "../agent/output-continuation.js";
import type { Model, ProviderId } from "../model/types.js";
import { ProviderRegistry } from "../model/registry.js";
import { RetryingModelRuntime } from "../model/retry.js";
import { ModelRuntime } from "../model/runtime.js";
import { OpenAICodexProvider } from "../providers/openai-codex-provider.js";
import {
  CODEX_DEFAULT_MODEL_ID,
  createCodexModel,
} from "../providers/openai-codex-models.js";
import { OpenAICompatibleProvider } from "../providers/openai-compatible-provider.js";
import { LlamaProvider } from "../providers/llama/provider.js";
import { ChatSession } from "../session/chat-session.js";
import { JsonlSessionStore } from "../session/jsonl-store.js";
import { assertValidSessionId } from "../session/session-id.js";
import { Session } from "../session/session.js";
import { SessionContextCoordinator } from "../session/session-context-coordinator.js";
import { BashTool } from "../tools/bash.js";
import { EditTool } from "../tools/edit.js";
import { ReadTool } from "../tools/read.js";
import { ToolRegistry } from "../tools/registry.js";
import { WriteTool } from "../tools/write.js";
import { CliToolApprovalHandler } from "./approval.js";
import { parseSessionId } from "./arguments.js";
import { runAuthCommand } from "./auth-commands.js";
import { runChat } from "./chat.js";
import { CliIO } from "./io.js";
import { startOAuthCallbackServer } from "./oauth-callback-server.js";
import { openExternalUrl } from "./open-url.js";

type ChatProvider = "llama" | "openai-compatible" | "openai-codex";

export interface ChatOptions {
  readonly provider: ChatProvider;
  readonly model: string;
  readonly sessionId?: string;
  readonly resumeModelFromSession?: boolean;
}

const defaultModels: Record<ChatProvider, string> = {
  llama: "gemma-local",
  "openai-compatible": "gemma3",
  "openai-codex": CODEX_DEFAULT_MODEL_ID,
};

export function parseChatOptions(args: readonly string[]): ChatOptions {
  const rawProvider = optionValue(args, "--provider") ?? "llama";
  if (
    rawProvider !== "llama" &&
    rawProvider !== "openai-compatible" &&
    rawProvider !== "openai-codex"
  ) {
    throw new Error(`Unsupported provider "${rawProvider}".`);
  }

  const sessionId = parseSessionId(args);
  const explicitModel = optionValue(args, "--model");
  return {
    provider: rawProvider,
    model: explicitModel ?? defaultModels[rawProvider],
    ...(sessionId === undefined ? {} : { sessionId }),
    ...(sessionId !== undefined && explicitModel === undefined
      ? { resumeModelFromSession: true }
      : {}),
  };
}

export async function resolveChatModel(
  options: ChatOptions,
  rootDir: string,
): Promise<string> {
  if (!options.resumeModelFromSession || options.sessionId === undefined) {
    return options.model;
  }

  assertValidSessionId(options.sessionId);
  const filePath = resolve(rootDir, "sessions", `${options.sessionId}.jsonl`);
  let content: string;
  try {
    content = await readFile(filePath, "utf8");
  } catch (error: unknown) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      return options.model;
    }
    throw error;
  }

  const firstLine = content.split(/\r?\n/u).find((line) => line.trim() !== "");
  if (firstLine === undefined) return options.model;
  try {
    const header = JSON.parse(firstLine) as unknown;
    if (
      typeof header === "object" &&
      header !== null &&
      "model" in header &&
      typeof header.model === "object" &&
      header.model !== null &&
      "id" in header.model &&
      typeof header.model.id === "string" &&
      header.model.id.length > 0
    ) {
      return header.model.id;
    }
  } catch {
    // JsonlSessionStore reports the authoritative header error during load.
  }
  return options.model;
}

export async function main(args: readonly string[]): Promise<number> {
  const cli = new CliIO();
  const oauthStore = new FileOAuthStore();
  const oauth = new OpenAICodexOAuth();

  try {
    const authArgs = args[0] === "auth" ? args.slice(1) : args;
    if (
      authArgs[0] === "login" ||
      authArgs[0] === "status" ||
      authArgs[0] === "logout"
    ) {
      await runAuthCommand(authArgs, {
        provider: "openai-codex",
        store: oauthStore,
        oauth,
        io: {
          write: (line) => cli.write(`${line}\n`),
          prompt: (question) => cli.question(question),
        },
        openUrl: openExternalUrl,
        prepareCallback: async (attempt) => {
          const callback = await startOAuthCallbackServer({
            redirectUri: attempt.redirectUri,
            expectedState: attempt.state,
          });
          return {
            wait: callback.wait,
            close: () => callback.close(),
          };
        },
      });
      return 0;
    }

    if (args[0] !== "chat") {
      writeUsage(cli);
      return args.length === 0 || args[0] === "help" || args[0] === "--help"
        ? 0
        : 1;
    }

    const options = parseChatOptions(args);
    await runConfiguredChat(options, cli, oauthStore, oauth);
    return 0;
  } finally {
    cli.close();
  }
}

async function runConfiguredChat(
  options: ChatOptions,
  cli: CliIO,
  oauthStore: FileOAuthStore,
  oauth: OpenAICodexOAuth,
): Promise<void> {
  const registry = new ProviderRegistry();
  const modelId = await resolveChatModel(options, process.cwd());
  const model = createModel(options.provider, modelId);

  if (options.provider === "llama") {
    registry.register(new LlamaProvider({
      serverUrl: process.env.AI_AGENT_LLAMA_URL ?? "http://127.0.0.1:8080",
      modelId: model.id,
      modelName: model.name,
      contextWindow: model.contextWindow,
      maxOutputTokens: model.maxOutputTokens,
    }));
  } else if (options.provider === "openai-compatible") {
    registry.register(new OpenAICompatibleProvider({
      baseUrl:
        process.env.AI_AGENT_OPENAI_BASE_URL ?? "http://127.0.0.1:11434/v1",
      apiKey: process.env.AI_AGENT_OPENAI_API_KEY,
      model,
    }));
  } else {
    registry.register(new OpenAICodexProvider({
      model,
      resolver: new OAuthResolver({
        provider: "openai-codex",
        store: oauthStore,
        refresher: oauth,
      }),
    }));
  }

  const resolved = await registry.resolveModel(options.provider, modelId);
  if (resolved === undefined) {
    throw new Error(
      `Model "${modelId}" was not found for "${options.provider}".`,
    );
  }

  const sessionId = options.sessionId ?? randomUUID();
  const sessionStore = new JsonlSessionStore({
    rootDir: process.cwd(),
    sessionId,
    model: resolved.model,
  });
  const loadedSession = await sessionStore.load();
  const tools = createTools(process.cwd());
  const runtime = new RetryingModelRuntime(new ModelRuntime(registry), {
    maxRetries: 2,
    initialDelayMs: 500,
  });
  const approval = new SessionToolApprovalHandler({
    delegate: new CliToolApprovalHandler(cli),
    store: sessionStore,
    initialApprovalKeys: loadedSession.approvalKeys,
  });
  const compaction = new CompactionService(runtime, {
    reserveTokens: 1280,
    keepRecentTokens: 1024,
    charsPerToken: 2,
    maxSummaryOutputTokens: 1024,
    toolResultMaxChars: 2000,
  });
  const session = new Session(sessionStore);
  const coordinator = new SessionContextCoordinator(
    session,
    compaction,
    new ContextBudgetCalculator(new TokenEstimator(2)),
  );
  const agent = new AgentLoop(
    runtime,
    tools,
    approval,
    coordinator,
    createOutputContinuationPolicy(resolved.model),
  );
  const chat = new ChatSession(agent, resolved.model, {
    session,
    contextCoordinator: coordinator,
    toolDefinitions: tools.listDefinitions(),
    systemPrompt:
      "You are a careful coding assistant. Use tools when files are needed.",
  });

  cli.write(`Provider: ${options.provider}\n`);
  cli.write(`Model: ${modelId}\n`);
  cli.write(`Session: ${sessionId}\n`);
  cli.write(`Session file: ${sessionStore.filePath}\n`);
  cli.write("Press Esc to cancel the current turn.\n");
  await runChat(chat, cli);
}

function createModel(provider: ChatProvider, id: string): Model {
  if (provider === "openai-codex") return createCodexModel(id);

  return {
    id,
    name: id,
    provider: provider satisfies ProviderId,
    contextWindow: 8192,
    maxOutputTokens: 1024,
  };
}

function createTools(rootDir: string): ToolRegistry {
  const tools = new ToolRegistry();
  tools.register(new ReadTool({ rootDir }));
  tools.register(new WriteTool({ rootDir }));
  tools.register(new EditTool({ rootDir }));
  tools.register(new BashTool({
    rootDir,
    shellPath: process.env.AI_AGENT_BASH_PATH ?? "bash",
  }));
  return tools;
}

function optionValue(
  args: readonly string[],
  option: string,
): string | undefined {
  const index = args.indexOf(option);
  if (index < 0) return undefined;
  const value = args[index + 1];
  if (value === undefined || value.startsWith("--")) {
    throw new Error(`${option} requires a value.`);
  }
  return value;
}

function writeUsage(cli: CliIO): void {
  cli.write("Usage:\n");
  cli.write("  ai-agent auth login [--device]\n");
  cli.write("  ai-agent auth status\n");
  cli.write("  ai-agent auth logout\n");
  cli.write(
    "  ai-agent chat [--provider llama|openai-compatible|openai-codex] " +
      "[--model MODEL] [--session ID]\n",
  );
}
