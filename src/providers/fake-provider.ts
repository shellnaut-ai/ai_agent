import type { ModelProvider, StreamOptions } from "../model/provider.js";
import type { Model, ModelRequest, StreamEvent } from "../model/types.js";

const FAKE_MODEL: Model = {
  id: "fake-model",
  name: "Fake Model",
  provider: "fake",
  contextWindow: 4096,
  maxOutputTokens: 1024,
};

const READ_CALL_ID = "fake-read-package-json";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseDevCommand(content: string): string | undefined {
  let value: unknown;

  try {
    value = JSON.parse(content);
  } catch {
    return undefined;
  }

  if (!isRecord(value)) {
    return undefined;
  }

  const scripts = value.scripts;

  if (!isRecord(scripts)) {
    return undefined;
  }

  return typeof scripts.dev === "string" ? scripts.dev : undefined;
}

export class FakeProvider implements ModelProvider {
  readonly id = "fake";
  readonly name = "Fake Provider";

  async listModels(options?: {
    signal?: AbortSignal;
  }): Promise<readonly Model[]> {
    if (options?.signal?.aborted) {
      throw new Error("Model listing aborted.");
    }

    return [FAKE_MODEL];
  }

  async *stream(
    request: ModelRequest,
    options?: StreamOptions,
  ): AsyncIterable<StreamEvent> {
    if (request.model.provider !== this.id) {
      yield {
        type: "error",
        reason: "error",
        error: new Error(
          `FakeProvider cannot run model from ` +
            `"${request.model.provider}".`,
        ),
      };

      return;
    }

    if (options?.signal?.aborted) {
      yield {
        type: "error",
        reason: "aborted",
        error: new Error("Request aborted."),
      };

      return;
    }

    yield {
      type: "start",
    };

    const readAvailable = request.tools.some(
      (definition) => definition.name === "read",
    );

    if (!readAvailable) {
      yield {
        type: "error",
        reason: "error",
        error: new Error('Tool "read" is not available.'),
      };

      return;
    }

    const lastMessage = request.messages.at(-1);

    if (
      lastMessage?.role !== "tool" ||
      lastMessage.toolCallId !== READ_CALL_ID
    ) {
      yield {
        type: "tool-call",
        toolCall: {
          id: READ_CALL_ID,
          name: "read",
          arguments: {
            path: "package.json",
          },
        },
      };

      yield {
        type: "done",
        reason: "tool-call",
      };

      return;
    }

    if (lastMessage.isError) {
      yield {
        type: "text-delta",
        delta: `read Tool failed: ` + lastMessage.content,
      };

      yield {
        type: "done",
        reason: "stop",
      };

      return;
    }

    const devCommand = parseDevCommand(lastMessage.content);

    if (!devCommand) {
      yield {
        type: "text-delta",
        delta: "package.json에 scripts.dev가 없습니다.",
      };

      yield {
        type: "done",
        reason: "stop",
      };

      return;
    }

    yield {
      type: "text-delta",
      delta: "package.json의 scripts.dev 명령은 ",
    };

    yield {
      type: "text-delta",
      delta: `"${devCommand}"입니다.`,
    };

    yield {
      type: "done",
      reason: "stop",
    };
  }
}
