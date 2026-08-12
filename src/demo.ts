import { randomUUID } from "node:crypto";

import { AgentLoop } from "./agent/loop.js";
import { SessionToolApprovalHandler } from "./approval/session.js";
import { CliToolApprovalHandler } from "./cli/approval.js";
import { parseSessionId } from "./cli/arguments.js";
import { runChat } from "./cli/chat.js";
import { CliIO } from "./cli/io.js";
import { CompactionService } from "./context/compaction.js";
import { ContextBudgetCalculator } from "./context/budget.js";
import { TokenEstimator } from "./context/token-estimator.js";
import { createOutputContinuationPolicy } from "./agent/output-continuation.js";
import { ProviderRegistry } from "./model/registry.js";
import { RetryingModelRuntime } from "./model/retry.js";
import { ModelRuntime } from "./model/runtime.js";
import { LlamaProvider } from "./providers/llama/provider.js";
import { ChatSession } from "./session/chat-session.js";
import { JsonlSessionStore } from "./session/jsonl-store.js";
import { Session } from "./session/session.js";
import { SessionContextCoordinator } from "./session/session-context-coordinator.js";
import { BashTool } from "./tools/bash.js";
import { EditTool } from "./tools/edit.js";
import { ReadTool } from "./tools/read.js";
import { ToolRegistry } from "./tools/registry.js";
import { WriteTool } from "./tools/write.js";

async function main(): Promise<void> {
  const cli = new CliIO();
  const registry = new ProviderRegistry();

  try {
    registry.register(
      new LlamaProvider({
        serverUrl: "http://127.0.0.1:8080",
        contextWindow: 4096,
        maxOutputTokens: 1024,
        modelId: "gemma-local",
        modelName: "Local Gemma",
      }),
    );

    const resolved = await registry.resolveModel("llama", "gemma-local");

    if (!resolved) {
      throw new Error("Llama model was not found.");
    }

    const sessionId = parseSessionId(process.argv.slice(2)) ?? randomUUID();

    const sessionStore = new JsonlSessionStore({
      rootDir: process.cwd(),
      sessionId,
      model: resolved.model,
    });

    const loadedSession = await sessionStore.load();
    const session = new Session(sessionStore);

    cli.write(`Session: ${sessionId}\n`);
    cli.write(`Session file: ${sessionStore.filePath}\n`);
    cli.write("Press Esc to cancel the current turn.\n");

    const toolRegistry = new ToolRegistry();
    toolRegistry.register(
      new ReadTool({
        rootDir: process.cwd(),
      }),
    );

    toolRegistry.register(
      new WriteTool({
        rootDir: process.cwd(),
      }),
    );

    toolRegistry.register(
      new EditTool({
        rootDir: process.cwd(),
      }),
    );

    toolRegistry.register(
      new BashTool({
        rootDir: process.cwd(),
        shellPath: process.env.AI_AGENT_BASH_PATH ?? "bash",
      }),
    );

    const runtime = new ModelRuntime(registry);
    const retryingRuntime = new RetryingModelRuntime(runtime, {
      maxRetries: 2,
      initialDelayMs: 500,
    });
    const compactionService = new CompactionService(retryingRuntime, {
      reserveTokens: 1280,
      keepRecentTokens: 1024,
      charsPerToken: 2,
      maxSummaryOutputTokens: 1024,
      toolResultMaxChars: 2000,
    });
    const cliApprovalHandler = new CliToolApprovalHandler(cli);
    const approvalHandler = new SessionToolApprovalHandler({
      delegate: cliApprovalHandler,
      store: sessionStore,
      initialApprovalKeys: loadedSession.approvalKeys,
    });
    const coordinator = new SessionContextCoordinator(
      session,
      compactionService,
      new ContextBudgetCalculator(new TokenEstimator(2)),
    );
    const agentLoop = new AgentLoop(
      retryingRuntime,
      toolRegistry,
      approvalHandler,
      coordinator,
      createOutputContinuationPolicy(resolved.model),
    );
    const chatSession = new ChatSession(agentLoop, resolved.model, {
      session,
      contextCoordinator: coordinator,
      toolDefinitions: toolRegistry.listDefinitions(),
    });

    await runChat(chatSession, cli);
  } finally {
    cli.close();
  }
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
