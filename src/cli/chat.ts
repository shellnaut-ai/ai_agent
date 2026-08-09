import type { AgentLoopOptions } from "../agent/types.js";
import type { ChatEvent } from "../session/types.js";

export interface ChatSessionLike {
  streamTurn(
    userContent: string,
    options?: AgentLoopOptions,
  ): AsyncIterable<ChatEvent>;
}

export interface ChatIO {
  question(prompt: string, signal?: AbortSignal): Promise<string | undefined>;
  write(content: string): void;
  writeError(content: string): void;
  onEscape(listener: () => void): () => void;
  onInterrupt(listener: () => void): () => void;
}

export async function runChat(
  session: ChatSessionLike,
  io: ChatIO,
): Promise<void> {
  while (true) {
    const input = await io.question("You>_ ");
    if (input === undefined) {
      return;
    }
    const content = input.trim();

    if (content.length === 0) {
      continue;
    }

    if (content === "/exit") {
      return;
    }

    let assistantLineOpen = false;
    const controller = new AbortController();

    const cancelTurn = (): void => {
      if (controller.signal.aborted) {
        return;
      }

      io.write("\nCancelling current turn...\n");
      controller.abort();
    };
    const removeEscapeListener = io.onEscape(cancelTurn);
    const removeInterruptListener = io.onInterrupt(cancelTurn);

    try {
      for await (const event of session.streamTurn(content, {
        signal: controller.signal,
      })) {
        if (event.type === "compaction-start") {
          io.write(
            `[Compaction] Summarizing ${event.tokensBefore} tokens...\n`,
          );
        }

        if (event.type === "compaction-done") {
          io.write(
            `[Compaction] Context reduced from ` +
              `${event.tokensBefore} to ${event.tokensAfter} tokens.\n`,
          );
        }

        if (event.type === "retry") {
          if (assistantLineOpen) {
            io.write("\n");
            assistantLineOpen = false;
          }

          io.write(
            `[Model] Retrying ${event.attempt}/${event.maxRetries} ` +
              `in ${event.delayMs}ms...\n`,
          );
        }

        if (event.type === "text-delta") {
          if (!assistantLineOpen) {
            io.write("Assistant> ");
            assistantLineOpen = true;
          }

          io.write(event.delta);
        }

        if (event.type === "tool-call") {
          if (assistantLineOpen) {
            io.write("\n");
            assistantLineOpen = false;
          }

          io.write(`[Tool] ${event.toolCall.name}\n`);
        }

        if (event.type === "tool-result") {
          const status = event.result.isError ? "failed" : "completed";
          io.write(`[Tool] ${status}\n`);
        }

        if (event.type === "done" && assistantLineOpen) {
          io.write("\n");
        }

        if (event.type === "error") {
          if (assistantLineOpen) {
            io.write("\n");
          }

          if (event.reason === "aborted") {
            io.write("Turn cancelled.\n");
          } else {
            io.writeError(`Error: ${event.error.message}\n`);
          }
        }
      }
    } finally {
      removeEscapeListener();
      removeInterruptListener();
    }
  }
}
