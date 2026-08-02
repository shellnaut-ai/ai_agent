import { stderr, stdin, stdout } from "node:process";
import type { Key } from "node:readline";
import { createInterface } from "node:readline/promises";

export class CliIO {
  private readonly readline = createInterface({
    input: stdin,
    output: stdout,
    escapeCodeTimeout: 50,
  });

  private readonly escapeListeners = new Set<() => void>();
  private readonly interruptListeners = new Set<() => void>();

  private readonly handleKeypress = (
    _character: string | undefined,
    key: Key,
  ): void => {
    if (key.name !== "escape") {
      return;
    }

    for (const listener of this.escapeListeners) {
      listener();
    }
  };

  private readonly handleInterrupt = (): void => {
    for (const listener of this.interruptListeners) {
      listener();
    }
  };

  constructor() {
    if (stdin.isTTY) {
      stdin.on("keypress", this.handleKeypress);
    }
  }

  async question(
    prompt: string,
    signal?: AbortSignal,
  ): Promise<string | undefined> {
    try {
      if (signal) {
        return await this.readline.question(prompt, {
          signal,
        });
      }

      return await this.readline.question(prompt);
    } catch (error: unknown) {
      if (
        error instanceof Error &&
        (error.message === "readline was closed" ||
          ("code" in error && error.code === "ERR_USE_AFTER_CLOSE"))
      ) {
        return undefined;
      }
      throw error;
    }
  }

  write(content: string): void {
    stdout.write(content);
  }

  writeError(content: string): void {
    stderr.write(content);
  }

  onEscape(listener: () => void): () => void {
    this.escapeListeners.add(listener);
    stdin.resume();

    return () => {
      this.escapeListeners.delete(listener);
    };
  }

  onInterrupt(listener: () => void): () => void {
    if (this.interruptListeners.size === 0) {
      process.on("SIGINT", this.handleInterrupt);
    }
    this.interruptListeners.add(listener);

    return () => {
      this.interruptListeners.delete(listener);
      if (this.interruptListeners.size === 0) {
        process.off("SIGINT", this.handleInterrupt);
      }
    };
  }

  close(): void {
    stdin.off("keypress", this.handleKeypress);
    process.off("SIGINT", this.handleInterrupt);
    this.escapeListeners.clear();
    this.interruptListeners.clear();
    this.readline.close();
  }
}
