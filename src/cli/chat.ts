import type { ChatSession } from "../session/chat-session.js";
import { formatSessionTree } from "../session/tree.js";
import type { CliIO } from "./io.js";

export async function runChat(session: ChatSession, io: CliIO): Promise<void> {
  while (true) {
    const input = await io.question("You>_ ");
    const content = input.trim();

    if (content.length === 0) {
      continue;
    }

    if (content === "/exit") {
      return;
    }

    if (content === "/tree") {
      io.write(
        `${formatSessionTree(session.getTree(), session.getLeafId())}\n`,
      );
      continue;
    }

    if (content === "/clone") {
      try {
        const result = await session.clone();
        io.write(
          `Cloned to session ${result.sessionId}.\n` +
            `Session file: ${result.filePath}\n`,
        );
      } catch (error: unknown) {
        io.writeError(
          `Error: ${error instanceof Error ? error.message : String(error)}\n`,
        );
      }

      continue;
    }

    if (content === "/goto" || content.startsWith("/goto ")) {
      const entryId = content.slice("/goto".length).trim();

      if (entryId.length === 0) {
        io.writeError("Usage: /goto <entryId>\n");
        continue;
      }

      try {
        await session.moveTo(entryId);
        io.write(`Moved to session entry ${entryId}.\n`);
      } catch (error: unknown) {
        io.writeError(
          `Error: ${error instanceof Error ? error.message : String(error)}\n`,
        );
      }

      continue;
    }

    if (content === "/fork" || content.startsWith("/fork ")) {
      const entryId = content.slice("/fork".length).trim();

      if (entryId.length === 0) {
        io.writeError("Usage: /fork <userMessageEntryId>\n");
        continue;
      }

      try {
        const result = await session.fork(entryId);
        io.write(
          `Forked to session ${result.sessionId}.\n` +
            `Session file: ${result.filePath}\n`,
        );
      } catch (error: unknown) {
        io.writeError(
          `Error: ${error instanceof Error ? error.message : String(error)}\n`,
        );
      }

      continue;
    }

    let assistantLineOpen = false;
    const controller = new AbortController();

    const removeEscapeListener = io.onEscape(() => {
      if (controller.signal.aborted) {
        return;
      }

      io.write("\nCancelling current turn...\n");
      controller.abort();
    });

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
    }
  }
}
