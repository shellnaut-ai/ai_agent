import type {
  AgentTool,
  ToolCall,
  ToolDefinition,
  ToolErrorCode,
  ToolResultMessage,
} from "../core/contracts.js";

export interface ToolExecutionHooks {
  readonly onStart?: (toolCall: ToolCall) => void | Promise<void>;
  readonly onEnd?: (result: ToolResultMessage) => void | Promise<void>;
}

export interface ToolRegistryOptions {
  readonly createResultId?: () => string;
  readonly now?: () => string;
  readonly hooks?: ToolExecutionHooks;
}

/**
 * 모델이 만든 tool call을 신뢰 가능한 ToolResult로 바꾸는 단일 실행 경계다.
 *
 * 이름 조회, JSON 파싱, 도구별 schema 검증, 실제 실행을 순서대로 분리하면 실패 원인을
 * 모델에게 다시 알려줄 수 있다. 검증 실패도 throw로 사라지지 않고 실패 ToolResult가 된다.
 */
export class ToolRegistry {
  readonly definitions: readonly ToolDefinition[];
  private readonly toolsByName: ReadonlyMap<string, AgentTool>;
  private readonly createResultId: () => string;
  private readonly now: () => string;
  private readonly hooks: ToolExecutionHooks | undefined;

  constructor(tools: readonly AgentTool[], options: ToolRegistryOptions = {}) {
    // Provider에는 실행 객체가 아니라 직렬화 가능한 공개 정의만 전달한다.
    this.definitions = tools.map(({ name, description, inputSchema }) => ({
      name,
      description,
      inputSchema,
    }));
    this.toolsByName = new Map(tools.map((tool) => [tool.name, tool]));
    this.createResultId = options.createResultId ?? (() => crypto.randomUUID());
    this.now = options.now ?? (() => new Date().toISOString());
    this.hooks = options.hooks;
  }

  async executeBatch(
    toolCalls: readonly ToolCall[],
    batchHooks?: ToolExecutionHooks,
  ): Promise<ToolResultMessage[]> {
    const hooks = batchHooks ?? this.hooks;
    const results: ToolResultMessage[] = [];
    // for-of와 await를 함께 써서 모델이 만든 source order대로 정확히 하나씩 실행한다.
    // 병렬 실행은 파일/프로세스 도구가 서로 의존할 수 있으므로 첫 단계에서 의도적으로 제외한다.
    for (const toolCall of toolCalls) {
      await hooks?.onStart?.(toolCall);
      const result = await this.executeOne(toolCall);
      results.push(result);
      await hooks?.onEnd?.(result);
    }
    return results;
  }

  private async executeOne(toolCall: ToolCall): Promise<ToolResultMessage> {
    // 1) 이름 검증: 등록되지 않은 도구에 임의 코드를 연결하지 않는다.
    const tool = this.toolsByName.get(toolCall.name);
    if (tool === undefined) {
      return this.errorResult(toolCall, "unknown_tool", `Unknown tool: ${toolCall.name}`);
    }

    let parsedJson: unknown;
    try {
      // 2) 문법 검증: JSON.parse 결과는 아직 안전한 도구 인자가 아니므로 unknown으로 둔다.
      parsedJson = JSON.parse(toolCall.argumentsJson) as unknown;
    } catch (error) {
      return this.errorResult(toolCall, "invalid_json", this.errorMessage(error));
    }

    let argumentsValue: unknown;
    try {
      // 3) 의미 검증: 각 Tool이 자신의 schema와 타입 규칙을 가장 잘 안다.
      argumentsValue = tool.parse(parsedJson);
    } catch (error) {
      return this.errorResult(toolCall, "invalid_arguments", this.errorMessage(error));
    }

    try {
      // 4) 실행: 여기서 난 예외도 Agent run을 깨지 않고 모델이 읽을 결과로 정규화한다.
      const execution = await tool.execute(argumentsValue);
      return {
        id: this.createResultId(),
        role: "tool",
        toolCallId: toolCall.id,
        toolName: toolCall.name,
        ok: true,
        content: execution.content,
        createdAt: this.now(),
      };
    } catch (error) {
      return this.errorResult(toolCall, "execution_error", this.errorMessage(error));
    }
  }

  private errorResult(
    toolCall: ToolCall,
    code: ToolErrorCode,
    message: string,
  ): ToolResultMessage {
    return {
      id: this.createResultId(),
      role: "tool",
      toolCallId: toolCall.id,
      toolName: toolCall.name,
      ok: false,
      content: message,
      error: { code, message },
      createdAt: this.now(),
    };
  }

  private errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }
}
