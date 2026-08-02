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

  constructor() {
    if (stdin.isTTY) {
      stdin.on("keypress", this.handleKeypress);
    }
  }

  question(prompt: string, signal?: AbortSignal): Promise<string> {
    if (signal) {
      return this.readline.question(prompt, {
        signal,
      });
    }

    return this.readline.question(prompt);
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

  close(): void {
    stdin.off("keypress", this.handleKeypress);
    this.escapeListeners.clear();
    this.readline.close();
  }
}
