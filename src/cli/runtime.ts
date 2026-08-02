import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";

import { Agent, type MessageIdKind } from "../agent/agent.js";
import type { CredentialResolver } from "../providers/openai-codex-provider.js";
import { OpenAICodexProvider } from "../providers/openai-codex-provider.js";
import { JsonlSessionStore } from "../session/jsonl-session-store.js";
import { BashTool } from "../tools/bash-tool.js";
import { EditTool } from "../tools/edit-tool.js";
import { ReadTool } from "../tools/read-tool.js";
import { ToolRegistry } from "../tools/tool-registry.js";
import { WriteTool } from "../tools/write-tool.js";

export interface AgentRuntimeOptions {
  readonly workspace: string;
  readonly sessionPath: string;
  readonly sessionId?: string;
  readonly model: string;
  readonly resolver: CredentialResolver;
  readonly fetch?: typeof fetch;
  readonly instructions?: string;
  readonly createMessageId?: (kind: MessageIdKind) => string;
  readonly createToolResultId?: () => string;
  readonly now?: () => string;
}

/**
 * 실행 가능한 한 Agent에 기존 학습 모듈들을 조립하는 composition root다.
 *
 * Agent나 Provider 생성자 안에서 cwd와 파일 경로를 암묵적으로 읽지 않는다. CLI가 선택한
 * workspace/session/model을 여기로 넘겨 테스트와 실제 실행이 같은 조립 코드를 사용한다.
 */
export async function createAgentRuntime(
  options: AgentRuntimeOptions,
): Promise<Agent> {
  await mkdir(dirname(options.sessionPath), { recursive: true });
  const provider = new OpenAICodexProvider({
    resolver: options.resolver,
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
    ...(options.instructions === undefined
      ? {}
      : { instructions: options.instructions }),
  });
  const tools = new ToolRegistry(
    [
      // 배열 순서는 Provider가 보는 definition 순서이자 학습 문서의 기본 도구 순서다.
      // 실제 batch 실행 순서는 모델이 만든 tool call source index가 결정하며 Registry가 보존한다.
      new ReadTool(options.workspace),
      new WriteTool(options.workspace),
      new EditTool(options.workspace),
      new BashTool(options.workspace),
    ],
    {
      ...(options.createToolResultId === undefined
        ? {}
        : { createResultId: options.createToolResultId }),
      ...(options.now === undefined ? {} : { now: options.now }),
    },
  );

  return new Agent({
    sessionId: options.sessionId ?? randomUUID(),
    model: options.model,
    provider,
    tools,
    session: new JsonlSessionStore(options.sessionPath),
    ...(options.createMessageId === undefined
      ? {}
      : { createMessageId: options.createMessageId }),
    ...(options.now === undefined ? {} : { now: options.now }),
  });
}
