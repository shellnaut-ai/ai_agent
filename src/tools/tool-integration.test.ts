import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Type } from "typebox";
import { afterEach, describe, expect, test } from "vitest";

import { BashTool } from "./bash.js";
import { ToolRegistry } from "./registry.js";
import type { Tool } from "./types.js";
import { WriteTool } from "./write.js";

const cleanup: string[] = [];

interface RecordedProcessTree {
  readonly parentPid: number;
  readonly descendantPid: number;
}

const BASH_TREE_FIXTURE = `
const { spawn } = require("node:child_process");
const { writeFileSync } = require("node:fs");
const child = spawn(
  process.execPath,
  [
    "-e",
    'process.on("SIGTERM", () => {}); setInterval(() => {}, 1_000);',
  ],
  {
    detached: process.platform === "win32",
    stdio: "ignore",
    windowsHide: true,
  },
);
writeFileSync(
  process.argv[2],
  JSON.stringify({ parentPid: process.pid, descendantPid: child.pid }),
  "utf8",
);
if (process.argv[3] === "flood") {
  process.stdout.write("x".repeat(8_192));
}
setInterval(() => {}, 1_000);
`;

function bashPath(): string {
  return process.platform === "win32"
    ? join(
        process.env["ProgramFiles"] ?? "C:\\Program Files",
        "Git",
        "bin",
        "bash.exe",
      )
    : "bash";
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") {
      return false;
    }

    throw error;
  }
}

async function waitForRecordedTree(
  path: string,
): Promise<RecordedProcessTree> {
  const deadline = Date.now() + 5_000;

  while (Date.now() < deadline) {
    try {
      const value = JSON.parse(await readFile(path, "utf8")) as unknown;

      if (
        typeof value === "object" &&
        value !== null &&
        Number.isInteger(Reflect.get(value, "parentPid")) &&
        Number.isInteger(Reflect.get(value, "descendantPid"))
      ) {
        return value as RecordedProcessTree;
      }
    } catch (error: unknown) {
      if (
        !(
          error instanceof SyntaxError ||
          (error as NodeJS.ErrnoException).code === "ENOENT"
        )
      ) {
        throw error;
      }
    }

    await new Promise((resolve) => setTimeout(resolve, 25));
  }

  throw new Error(`Timed out waiting for process tree file: ${path}`);
}

async function waitForProcessExit(pid: number): Promise<void> {
  const deadline = Date.now() + 5_000;

  while (Date.now() < deadline) {
    if (!isProcessAlive(pid)) {
      return;
    }

    await new Promise((resolve) => setTimeout(resolve, 25));
  }

  throw new Error(`Process ${pid} remained alive.`);
}

async function withDeadline<T>(
  promise: Promise<T>,
  message: string,
): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;

  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error(message)), 5_000);
      }),
    ]);
  } finally {
    if (timeout !== undefined) {
      clearTimeout(timeout);
    }
  }
}

async function forceKillProcess(pid: number): Promise<void> {
  if (!isProcessAlive(pid)) {
    return;
  }

  if (process.platform === "win32") {
    await new Promise<void>((resolve) => {
      const killer = spawn(
        "taskkill.exe",
        ["/PID", String(pid), "/T", "/F"],
        { stdio: "ignore", windowsHide: true },
      );
      killer.once("error", () => resolve());
      killer.once("close", () => resolve());
    });
  } else {
    try {
      process.kill(pid, "SIGKILL");
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") {
        throw error;
      }
    }
  }

  if (isProcessAlive(pid)) {
    await waitForProcessExit(pid);
  }
}

async function forceCleanupTree(
  tree: RecordedProcessTree | undefined,
): Promise<void> {
  if (tree === undefined) {
    return;
  }

  await forceKillProcess(tree.parentPid);
  await forceKillProcess(tree.descendantPid);
}

async function createBashTreeFixture(
  rootDir: string,
  mode?: "flood",
): Promise<{ readonly command: string; readonly treePath: string }> {
  const fixturePath = join(rootDir, "bash-process-tree-fixture.cjs");
  const treePath = join(rootDir, "bash-process-tree.json");
  await writeFile(fixturePath, BASH_TREE_FIXTURE, "utf8");

  return {
    command: `node bash-process-tree-fixture.cjs bash-process-tree.json${
      mode === undefined ? "" : ` ${mode}`
    }`,
    treePath,
  };
}

afterEach(async () => {
  await Promise.all(
    cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("tool integration", () => {
  test("write creates missing parent directories inside the workspace", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "ai-agent-write-"));
    cleanup.push(rootDir);
    const tool = new WriteTool({ rootDir });

    const result = await tool.execute({
      path: "nested/deep/a.txt",
      content: "A",
    });

    expect(result.isError).toBe(false);
    await expect(
      readFile(join(rootDir, "nested", "deep", "a.txt"), "utf8"),
    ).resolves.toBe("A");
  });

  test("executeBatch preserves order and continues after a failure", async () => {
    const registry = new ToolRegistry();
    const executionOrder: string[] = [];

    const tool = (name: string, isError: boolean): Tool => ({
      approval: "never",
      definition: {
        name,
        description: name,
        inputSchema: Type.Object({}, { additionalProperties: false }),
      },
      async execute() {
        executionOrder.push(name);
        return { content: name, isError };
      },
    });
    registry.register(tool("first", true));
    registry.register(tool("second", false));

    const results = await registry.executeBatch([
      { id: "1", name: "first", arguments: {} },
      { id: "2", name: "second", arguments: {} },
    ]);

    expect(executionOrder).toEqual(["first", "second"]);
    expect(results).toEqual([
      { toolCallId: "1", content: "first", isError: true },
      { toolCallId: "2", content: "second", isError: false },
    ]);
  });

  test(
    "bash timeout returns its error result after stopping the descendant tree",
    async () => {
      const rootDir = await mkdtemp(join(tmpdir(), "ai-agent-bash-timeout-"));
      cleanup.push(rootDir);
      const fixture = await createBashTreeFixture(rootDir);
      const tool = new BashTool({
        rootDir,
        shellPath: bashPath(),
        timeoutMs: 1_000,
      });
      let tree: RecordedProcessTree | undefined;
      let execution: Promise<Awaited<ReturnType<BashTool["execute"]>>> | undefined;

      try {
        execution = tool.execute({ command: fixture.command });
        tree = await waitForRecordedTree(fixture.treePath);
        const result = await withDeadline(
          execution,
          "Bash timeout termination did not settle.",
        );

        expect(result.isError).toBe(true);
        expect(JSON.parse(result.content)).toMatchObject({
          timedOut: true,
          outputTruncated: false,
        });
        await waitForProcessExit(tree.descendantPid);
      } finally {
        await forceCleanupTree(tree);
        await execution?.catch(() => undefined);
      }
    },
    20_000,
  );

  test(
    "bash abort throws its existing abort error after stopping the descendant tree",
    async () => {
      const rootDir = await mkdtemp(join(tmpdir(), "ai-agent-bash-abort-"));
      cleanup.push(rootDir);
      const fixture = await createBashTreeFixture(rootDir);
      const tool = new BashTool({
        rootDir,
        shellPath: bashPath(),
        timeoutMs: 10_000,
      });
      const controller = new AbortController();
      let tree: RecordedProcessTree | undefined;
      let execution: Promise<Awaited<ReturnType<BashTool["execute"]>>> | undefined;

      try {
        execution = tool.execute(
          { command: fixture.command },
          { signal: controller.signal },
        );
        tree = await waitForRecordedTree(fixture.treePath);
        controller.abort();

        await expect(execution).rejects.toMatchObject({
          name: "AbortError",
          code: "ABORT_ERR",
        });
        await waitForProcessExit(tree.descendantPid);
      } finally {
        await forceCleanupTree(tree);
        await execution?.catch(() => undefined);
      }
    },
    15_000,
  );

  test(
    "bash output limit returns its truncated result after stopping the descendant tree",
    async () => {
      const rootDir = await mkdtemp(join(tmpdir(), "ai-agent-bash-output-"));
      cleanup.push(rootDir);
      const fixture = await createBashTreeFixture(rootDir, "flood");
      const tool = new BashTool({
        rootDir,
        shellPath: bashPath(),
        timeoutMs: 10_000,
        maxOutputBytes: 64,
      });
      let tree: RecordedProcessTree | undefined;
      let execution: Promise<Awaited<ReturnType<BashTool["execute"]>>> | undefined;

      try {
        execution = tool.execute({ command: fixture.command });
        tree = await waitForRecordedTree(fixture.treePath);
        const result = await withDeadline(
          execution,
          "Bash output-limit termination did not settle.",
        );

        expect(result.isError).toBe(true);
        expect(JSON.parse(result.content)).toMatchObject({
          timedOut: false,
          outputTruncated: true,
        });
        await waitForProcessExit(tree.descendantPid);
      } finally {
        await forceCleanupTree(tree);
        await execution?.catch(() => undefined);
      }
    },
    20_000,
  );
});
