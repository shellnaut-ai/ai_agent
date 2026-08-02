import type {
  Tool,
  ToolCall,
  ToolCallPreparation,
  ToolDefinition,
  ToolExecutionOptions,
  PreparedToolCall,
  ToolResult,
} from "./types.js";
import {
  createToolInputValidator,
  type ToolInputValidator,
  type ToolValidationResult,
} from "./validation.js";

interface RegisteredTool {
  readonly tool: Tool;
  readonly validator: ToolInputValidator;
}

export class ToolRegistry {
  private readonly tools = new Map<string, RegisteredTool>();

  register(tool: Tool): void {
    if (this.tools.has(tool.definition.name)) {
      throw new Error(`Tool "${tool.definition.name}" is already registered`);
    }
    this.tools.set(tool.definition.name, {
      tool,
      validator: createToolInputValidator(
        tool.definition.name,
        tool.definition.inputSchema,
      ),
    });
  }

  getTool(name: string): Tool | undefined {
    return this.tools.get(name)?.tool;
  }

  listDefinitions(): readonly ToolDefinition[] {
    return [...this.tools.values()].map(
      ({ tool }) => tool.definition,
    );
  }

  prepare(call: ToolCall): ToolCallPreparation {
    const registered = this.tools.get(call.name);

    if (!registered) {
      return {
        ok: false,
        result: {
          toolCallId: call.id,
          content: `Tool "${call.name}" is not registered.`,
          isError: true,
        },
      };
    }

    let validation: ToolValidationResult;

    try {
      validation = registered.validator.validate(call.arguments);
    } catch (error: unknown) {
      return {
        ok: false,
        result: {
          toolCallId: call.id,
          content:
            error instanceof Error ? error.message : String(error),
          isError: true,
        },
      };
    }

    if (!validation.ok) {
      return {
        ok: false,
        result: {
          toolCallId: call.id,
          content: validation.message,
          isError: true,
        },
      };
    }

    return {
      ok: true,
      tool: registered.tool,
      originalCall: call,
      executableCall: {
        ...call,
        arguments: validation.value,
      },
    };
  }

  async executePrepared(
    prepared: PreparedToolCall,
    options?: ToolExecutionOptions,
  ): Promise<ToolResult> {
    if (options?.signal?.aborted) {
      throw new Error("Tool execution aborted.");
    }

    try {
      const output = await prepared.tool.execute(
        prepared.executableCall.arguments,
        options,
      );

      if (options?.signal?.aborted) {
        throw new Error("Tool execution aborted.");
      }

      return {
        toolCallId: prepared.originalCall.id,
        content: output.content,
        isError: output.isError,
      };
    } catch (error: unknown) {
      if (options?.signal?.aborted) {
        throw error;
      }

      return {
        toolCallId: prepared.originalCall.id,
        content: error instanceof Error ? error.message : String(error),
        isError: true,
      };
    }
  }

  async executeBatch(
    calls: readonly ToolCall[],
    options?: ToolExecutionOptions,
  ): Promise<readonly ToolResult[]> {
    const results: ToolResult[] = [];

    for (const call of calls) {
      const preparation = this.prepare(call);
      results.push(
        preparation.ok
          ? await this.executePrepared(preparation, options)
          : preparation.result,
      );
    }

    return results;
  }
}
