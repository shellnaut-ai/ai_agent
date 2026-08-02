import { createInterface, type Interface } from "node:readline/promises";
import type { Readable, Writable } from "node:stream";

import type { CliIo } from "./auth-commands.js";
import type { ChatIo } from "./chat-command.js";

export interface NodeCliIoOptions {
  readonly input?: Readable;
  readonly output?: Writable;
}

/**
 * 실제 Node stdin/stdout을 CLI의 작은 IO 계약으로 번역한다.
 *
 * readline의 question promise는 pipe EOF에서 끝나지 않을 수 있다. close event와 race해
 * undefined로 바꾸면 `chat < NUL` 같은 비대화 환경도 정상 종료할 수 있다.
 */
export class NodeCliIo implements CliIo, ChatIo {
  readonly #input: Readable;
  readonly #output: Writable;
  #readline: Interface | undefined;
  #closed: Promise<undefined> | undefined;
  #inputEnded = false;

  constructor(options: NodeCliIoOptions = {}) {
    this.#input = options.input ?? process.stdin;
    this.#output = options.output ?? process.stdout;
  }

  write(line: string): void {
    this.#output.write(`${line}\n`);
  }

  writeChunk(chunk: string): void {
    this.#output.write(chunk);
  }

  async prompt(question: string): Promise<string | undefined> {
    if (this.#inputEnded) return undefined;
    const readline = this.#ensureReadline();
    return Promise.race([
      readline.question(question),
      this.#closed as Promise<undefined>,
    ]);
  }

  close(): void {
    this.#readline?.close();
    this.#readline = undefined;
  }

  #ensureReadline(): Interface {
    if (this.#readline !== undefined) return this.#readline;
    const readline = createInterface({
      input: this.#input,
      output: this.#output,
    });
    this.#readline = readline;
    this.#closed = new Promise<undefined>((resolve) => {
      readline.once("close", () => {
        this.#inputEnded = true;
        resolve(undefined);
      });
    });
    return readline;
  }
}
