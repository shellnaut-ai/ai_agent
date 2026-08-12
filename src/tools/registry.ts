import type {
  Tool,
  ToolCall,
  ToolCallPreparation,
  ToolDefinition,
  ToolExecutionOptions,
  PreparedToolCall,
  ToolResult,
} from "./types.js";
import type { ToolResultBudget } from "../context/budget.js";
import {
  createToolInputValidator,
  type ToolInputValidator,
  type ToolValidationResult,
} from "./validation.js";
import {
  cloneFrozenToolDefinition,
  cloneToolDefinition,
} from "./definition.js";

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
    const definition = cloneFrozenToolDefinition(tool.definition);
    const approval = tool.approval;
    const execute = tool.execute.bind(tool);
    const registeredTool = Object.freeze<Tool>({
      definition,
      approval,
      execute: (input, options) => execute(input, options),
    });
    this.tools.set(definition.name, {
      tool: registeredTool,
      validator: createToolInputValidator(
        definition.name,
        definition.inputSchema,
      ),
    });
  }

  getTool(name: string): Tool | undefined {
    return this.tools.get(name)?.tool;
  }

  listDefinitions(): readonly ToolDefinition[] {
    return [...this.tools.values()].map(
      ({ tool }) => cloneToolDefinition(tool.definition),
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

      const boundedOutput = boundToolOutput(output, options?.resultBudget);
      return {
        toolCallId: prepared.originalCall.id,
        content: boundedOutput.content,
        isError: boundedOutput.isError,
      };
    } catch (error: unknown) {
      if (options?.signal?.aborted) {
        throw error;
      }

      const boundedOutput = boundToolOutput({
        content: error instanceof Error ? error.message : String(error),
        isError: true,
      }, options?.resultBudget);
      return {
        toolCallId: prepared.originalCall.id,
        content: boundedOutput.content,
        isError: boundedOutput.isError,
      };
    }
  }

  boundResult(
    result: ToolResult,
    budget: ToolResultBudget | undefined,
  ): ToolResult {
    const output = boundToolOutput(result, budget);
    return {
      toolCallId: result.toolCallId,
      content: output.content,
      isError: output.isError,
    };
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

function boundToolOutput(
  output: { readonly content: string; readonly isError: boolean },
  budget: ToolResultBudget | undefined,
): { readonly content: string; readonly isError: boolean } {
  if (budget === undefined) return output;
  if (
    !Number.isInteger(budget.maxBytes) || budget.maxBytes <= 0 ||
    !Number.isInteger(budget.maxTokens) || budget.maxTokens <= 0
  ) {
    throw new Error("Tool result budget must contain positive integer limits.");
  }
  const limit = Math.min(budget.maxBytes, budget.maxTokens * 4);
  const fits = budget.fits ?? (() => true);
  if (
    Buffer.byteLength(output.content, "utf8") <= limit &&
    fits(output.content, output.isError)
  ) return output;

  const marker =
    "\n\n<Tool output truncated; discarded content is not recoverable. " +
    "Redirect output to a workspace file and use read paging.>";
  const markerBytes = Buffer.byteLength(marker, "utf8");
  if (markerBytes > limit || !fits(marker, true)) {
    return {
      content: longestFittingPrefix(marker.trimStart(), limit, (content) =>
        fits(content, true)
      ),
      isError: true,
    };
  }
  const prefix = longestFittingPrefix(
    output.content,
    limit - markerBytes,
    (content) => fits(content + marker, true),
  );
  return {
    content: prefix + marker,
    isError: true,
  };
}

function longestFittingPrefix(
  value: string,
  maxBytes: number,
  fits: (content: string) => boolean,
): string {
  let low = 0;
  let high = Math.min(maxBytes, Buffer.byteLength(value, "utf8"));
  let best = "";
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const candidate = utf8Prefix(value, middle);
    if (fits(candidate)) {
      best = candidate;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  return best;
}

function utf8Prefix(value: string, maxBytes: number): string {
  const encoded = Buffer.from(value, "utf8");
  if (encoded.byteLength <= maxBytes) return value;
  for (let end = maxBytes; end >= Math.max(0, maxBytes - 3); end -= 1) {
    try {
      return new TextDecoder("utf-8", { fatal: true })
        .decode(encoded.subarray(0, end));
    } catch {
      // A UTF-8 code point uses at most four bytes.
    }
  }
  return "";
}
