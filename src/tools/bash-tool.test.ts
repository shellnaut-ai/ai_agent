import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import { BashTool } from "./bash-tool.js";

describe("BashTool", () => {
  test("declares and parses command with an optional bounded timeout", () => {
    const tool = new BashTool("C:/workspace");

    expect(tool.inputSchema).toEqual({
      type: "object",
      properties: {
        command: { type: "string" },
        timeoutMs: { type: "integer", minimum: 1, maximum: 120_000 },
      },
      required: ["command"],
      additionalProperties: false,
    });
    expect(tool.parse({ command: "node --version" })).toEqual({ command: "node --version" });
    expect(tool.parse({ command: "node --version", timeoutMs: 500 })).toEqual({
      command: "node --version",
      timeoutMs: 500,
    });
  });

  test("rejects empty commands, invalid timeout values, and extra fields", () => {
    const tool = new BashTool("C:/workspace");
    const message = "Expected command and optional timeoutMs between 1 and 120000";

    expect(() => tool.parse({ command: "" })).toThrow(message);
    expect(() => tool.parse({ command: "ok", timeoutMs: 0 })).toThrow(message);
    expect(() => tool.parse({ command: "ok", timeoutMs: 1.5 })).toThrow(message);
    expect(() => tool.parse({ command: "ok", timeoutMs: 120_001 })).toThrow(message);
    expect(() => tool.parse({ command: "ok", timeoutMs: 10, env: {} })).toThrow(message);
  });

  test("runs in the workspace and returns stdout, stderr, and exit code", async () => {
    const rootDir = await temporaryWorkspace();

    const result = await new BashTool(rootDir).execute({
      command: nodeCommand(
        "process.stdout.write(process.cwd()); process.stderr.write('warning')",
      ),
    });

    expect(result.content).toContain("Exit code: 0");
    expect(result.content).toContain(rootDir);
    expect(result.content).toContain("stderr:\nwarning");
  });

  test("rejects a non-zero exit with captured stdout and stderr", async () => {
    const rootDir = await temporaryWorkspace();

    await expect(
      new BashTool(rootDir).execute({
        command: nodeCommand(
          "process.stdout.write('partial'); process.stderr.write('bad'); process.exit(3)",
        ),
      }),
    ).rejects.toThrow(/Exit code: 3[\s\S]*partial[\s\S]*bad/);
  });

  test("reports a requested timeout", async () => {
    const rootDir = await temporaryWorkspace();

    await expect(
      new BashTool(rootDir).execute({
        command: nodeCommand("setTimeout(() => {}, 250)"),
        timeoutMs: 30,
      }),
    ).rejects.toThrow("Command timed out after 30ms");
  });

  test("stops capturing after stdout and stderr exceed 1 MiB together", async () => {
    const rootDir = await temporaryWorkspace();

    await expect(
      new BashTool(rootDir).execute({
        command: nodeCommand(
          "process.stdout.write('a'.repeat(700000)); process.stderr.write('b'.repeat(400000))",
        ),
      }),
    ).rejects.toThrow("Command output exceeded 1048576 bytes");
  });
});

const cleanupPaths: string[] = [];

function nodeCommand(script: string): string {
  return `"${process.execPath}" -e ${JSON.stringify(script)}`;
}

async function temporaryWorkspace(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "pi-clone-bash-"));
  cleanupPaths.push(path);
  return path;
}

afterEach(async () => {
  await Promise.all(cleanupPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});
