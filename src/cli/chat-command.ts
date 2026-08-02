import { AuthRequiredError } from "../auth/oauth-resolver.js";
import type {
  AgentEventListener,
  Message,
} from "../core/contracts.js";

export interface ChatIo {
  write(line: string): void;
  writeChunk(chunk: string): void;
  prompt(question: string): Promise<string | undefined>;
}

export interface ChatAgent {
  subscribe(listener: AgentEventListener): () => void;
  prompt(content: string): Promise<readonly Message[]>;
}

export interface ChatAgentRequest {
  readonly model: string;
  readonly sessionPath?: string;
}

export interface ChatCommandDependencies {
  readonly io: ChatIo;
  readonly defaultModel: string;
  createAgent(request: ChatAgentRequest): Promise<ChatAgent>;
}

/**
 * 대화용 stdin과 AgentEvent 표시를 연결한다.
 *
 * Provider나 OAuthStore를 직접 만들지 않으므로 "로그인 필요"는 타입이 있는 오류만 보고
 * 안내한다. login을 자동 실행하지 않아 대화 prompt와 OAuth callback이 경쟁하지 않는다.
 */
export async function runChatCommand(
  args: readonly string[],
  dependencies: ChatCommandDependencies,
): Promise<boolean> {
  if (args[0] !== "chat") return false;
  const model = optionValue(args, "--model") ?? dependencies.defaultModel;
  const sessionPath = optionValue(args, "--session");
  const agent = await dependencies.createAgent({
    model,
    ...(sessionPath === undefined ? {} : { sessionPath }),
  });
  const unsubscribe = agent.subscribe(createEventPrinter(dependencies.io));

  dependencies.io.write(`대화를 시작합니다 · model=${model}`);
  dependencies.io.write("종료하려면 /exit를 입력하세요.");
  try {
    while (true) {
      const input = await dependencies.io.prompt("> ");
      if (input === undefined || input.trim() === "/exit") {
        dependencies.io.write("대화를 종료합니다.");
        return true;
      }
      if (input.trim() === "") continue;

      try {
        await agent.prompt(input);
      } catch (error) {
        if (error instanceof AuthRequiredError) {
          dependencies.io.write("로그인이 필요합니다.");
          dependencies.io.write("먼저 실행하세요: npm run cli -- login");
          return true;
        }
        throw error;
      }
    }
  } finally {
    unsubscribe();
  }
}

function createEventPrinter(io: ChatIo): AgentEventListener {
  return (event) => {
    if (event.type === "text_delta") {
      io.writeChunk(event.delta);
      return;
    }
    if (event.type === "message_end" && event.message.content !== "") {
      io.write("");
      return;
    }
    if (event.type === "tool_execution_start") {
      io.write(`[tool 시작] ${event.toolCall.name}`);
      return;
    }
    if (event.type === "tool_execution_end") {
      io.write(
        `[tool ${event.result.ok ? "완료" : "실패"}] ${event.result.toolName}`,
      );
    }
  };
}

function optionValue(args: readonly string[], option: string): string | undefined {
  const index = args.indexOf(option);
  if (index === -1) return undefined;
  const value = args[index + 1];
  if (value === undefined || value.startsWith("--")) {
    throw new Error(`${option} requires a value`);
  }
  return value;
}
