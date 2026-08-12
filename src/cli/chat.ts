import type { AgentLoopOptions } from "../agent/types.js";
import type { ChatEvent } from "../session/types.js";
import type { AssistantContinuationSegment } from "../model/types.js";

export interface ChatSessionLike {
  streamTurn(
    userContent: string,
    options?: AgentLoopOptions,
  ): AsyncIterable<ChatEvent>;
  getPendingContinuation?(): AssistantContinuationSegment | undefined;
  streamContinuation?(options?: AgentLoopOptions): AsyncIterable<ChatEvent>;
  abandonPendingContinuation?(): Promise<void>;
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
    const pending = session.getPendingContinuation?.();
    if (pending !== undefined) {
      const choices = pending.resumeAllowed
        ? "[r]esume, [a]bandon, or [e]xit"
        : "[a]bandon or [e]xit (resume is unsafe)";
      const decision = (await io.question(
        `[Recovery] Partial assistant output found: ${choices}>_ `,
      ))?.trim().toLowerCase();
      if (decision === undefined || decision === "e" || decision === "exit") {
        return;
      }
      if (decision === "a" || decision === "abandon") {
        if (session.abandonPendingContinuation === undefined) {
          io.writeError("Error: this session cannot abandon continuations.\n");
          return;
        }
        await session.abandonPendingContinuation();
        io.write("[Recovery] Partial output kept and continuation abandoned.\n");
        continue;
      }
      if ((decision === "r" || decision === "resume") && pending.resumeAllowed) {
        if (session.streamContinuation === undefined) {
          io.writeError("Error: this session cannot resume continuations.\n");
          return;
        }
        const controller = new AbortController();
        const cancelContinuation = (): void => {
          if (controller.signal.aborted) return;
          io.write("\nCancelling current turn...\n");
          controller.abort();
        };
        const removeEscapeListener = io.onEscape(cancelContinuation);
        const removeInterruptListener = io.onInterrupt(cancelContinuation);
        try {
          await renderContinuation(
            session.streamContinuation({ signal: controller.signal }),
            io,
          );
        } finally {
          removeEscapeListener();
          removeInterruptListener();
        }
        continue;
      }
      io.write("[Recovery] Choose one of the listed options.\n");
      continue;
    }

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

        if (event.type === "session-recovery") {
          for (const toolCallId of event.recoveredToolCallIds) {
            io.write(
              `[Recovery] Tool call ${toolCallId} outcome is unknown. ` +
                `Inspect workspace state before retrying.\n`,
            );
          }
        }

        if (event.type === "continuation-recovery-required") {
          io.write(
            "[Recovery] Partial assistant output requires explicit resume " +
              "or abandon before a new turn.\n",
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

async function renderContinuation(
  stream: AsyncIterable<ChatEvent>,
  io: ChatIO,
): Promise<void> {
  let assistantLineOpen = false;
  for await (const event of stream) {
    if (event.type === "text-delta") {
      if (!assistantLineOpen) {
        io.write("Assistant> ");
        assistantLineOpen = true;
      }
      io.write(event.delta);
    } else if (event.type === "compaction-start") {
      io.write(`[Compaction] Summarizing ${event.tokensBefore} tokens...\n`);
    } else if (event.type === "compaction-done") {
      io.write(
        `[Compaction] Context reduced from ${event.tokensBefore} ` +
          `to ${event.tokensAfter} tokens.\n`,
      );
    } else if (event.type === "retry") {
      if (assistantLineOpen) io.write("\n");
      assistantLineOpen = false;
      io.write(
        `[Model] Retrying ${event.attempt}/${event.maxRetries} ` +
          `in ${event.delayMs}ms...\n`,
      );
    } else if (event.type === "tool-call") {
      if (assistantLineOpen) io.write("\n");
      assistantLineOpen = false;
      io.write(`[Tool] ${event.toolCall.name}\n`);
    } else if (event.type === "tool-result") {
      io.write(`[Tool] ${event.result.isError ? "failed" : "completed"}\n`);
    } else if (event.type === "error") {
      if (assistantLineOpen) io.write("\n");
      assistantLineOpen = false;
      if (event.reason === "aborted") io.write("Turn cancelled.\n");
      else io.writeError(`Error: ${event.error.message}\n`);
    } else if (event.type === "done" && assistantLineOpen) {
      io.write("\n");
      assistantLineOpen = false;
    }
  }
}
