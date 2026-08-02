import { PassThrough } from "node:stream";

import { describe, expect, it } from "vitest";

import { NodeCliIo } from "./node-cli-io.js";

describe("NodeCliIo", () => {
  it("resolves an active prompt with undefined when stdin reaches EOF", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const io = new NodeCliIo({ input, output });
    const prompt = io.prompt("> ");

    input.end();

    await expect(prompt).resolves.toBeUndefined();
    io.close();
  });
});
