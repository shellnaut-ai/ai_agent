import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
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
const treePath = process.argv[2];
const mode = process.argv[3];
const fixtureToken = process.argv[4];
try {
  writeFileSync(
    treePath,
    JSON.stringify({ parentPid: process.pid }),
    "utf8",
  );
} catch {
  process.exit(1);
}
const child = spawn(
  process.execPath,
  [
    "-e",
    'process.on("SIGTERM", () => {}); setInterval(() => {}, 1_000);',
    fixtureToken,
  ],
  {
    detached: process.platform === "win32",
    stdio: "ignore",
    windowsHide: true,
  },
);
try {
  writeFileSync(
    treePath,
    JSON.stringify({ parentPid: process.pid, descendantPid: child.pid }),
    "utf8",
  );
} catch {
  // The token remains an independent cleanup handle for both live processes.
}
if (mode === "flood") {
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

async function captureCommandOutput(
  command: string,
  args: readonly string[],
  env?: NodeJS.ProcessEnv,
): Promise<string> {
  return await new Promise<string>((resolve, reject) => {
    const child = spawn(command, args, {
      env,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];

    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.once("error", reject);
    child.once("close", (exitCode) => {
      if (exitCode === 0) {
        resolve(Buffer.concat(stdout).toString("utf8"));
        return;
      }

      reject(
        new Error(
          `${command} fixture scan failed (exit ${String(exitCode)}): ${Buffer.concat(stderr).toString("utf8")}`,
        ),
      );
    });
  });
}

async function findFixturePids(token: string): Promise<number[]> {
  let output: string;

  if (process.platform === "win32") {
    output = await captureCommandOutput(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "$value = $env:PI_CLONE_FIXTURE_TOKEN; " +
          "Get-CimInstance Win32_Process | " +
          "Where-Object { ($_.Name -eq 'node.exe' -or $_.Name -eq 'bash.exe') " +
          "-and $_.CommandLine -like ('*' + $value + '*') } | " +
          "ForEach-Object { $_.ProcessId }",
      ],
      {
        ...process.env,
        PI_CLONE_FIXTURE_TOKEN: token,
      },
    );
  } else {
    output = await captureCommandOutput("ps", ["-eo", "pid=,args="]);
  }

  return output
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => {
      if (line.length === 0) {
        return false;
      }

      return process.platform === "win32"
        ? true
        : line.includes(token) && /\b(?:node|bash)\b/u.test(line);
    })
    .map((line) => Number.parseInt(line, 10))
    .filter((pid) => Number.isInteger(pid) && pid > 0 && pid !== process.pid);
}

async function forceCleanupToken(token: string): Promise<void> {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const pids = await findFixturePids(token);

    if (pids.length === 0) {
      return;
    }

    for (const pid of pids) {
      await forceKillProcess(pid);
    }

    await new Promise((resolve) => setTimeout(resolve, 25));
  }

  const remainingPids = await findFixturePids(token);

  if (remainingPids.length > 0) {
    throw new Error(
      `Fixture token ${token} still owns PIDs: ${remainingPids.join(", ")}`,
    );
  }
}

async function cleanupBashFixture(
  token: string,
  tree: RecordedProcessTree | undefined,
  execution: Promise<unknown> | undefined,
): Promise<void> {
  const errors: unknown[] = [];

  for (const cleanupAction of [
    async () => forceCleanupToken(token),
    async () => forceCleanupTree(tree),
    async () => execution?.catch(() => undefined),
  ]) {
    try {
      await cleanupAction();
    } catch (error: unknown) {
      errors.push(error);
    }
  }

  if (errors.length > 0) {
    throw errors[0];
  }
}

async function createBashTreeFixture(
  rootDir: string,
  token: string,
  mode?: "flood",
): Promise<{ readonly command: string; readonly treePath: string }> {
  const fixturePath = join(rootDir, "bash-process-tree-fixture.cjs");
  const treePath = join(rootDir, "bash-process-tree.json");
  await writeFile(fixturePath, BASH_TREE_FIXTURE, "utf8");

  return {
    command:
      "node bash-process-tree-fixture.cjs bash-process-tree.json " +
      `${mode ?? "hold"} ${token}`,
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
      const token = `pi-clone-${randomUUID()}`;
      const fixture = await createBashTreeFixture(rootDir, token);
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
        await cleanupBashFixture(token, tree, execution);
      }
    },
    20_000,
  );

  test(
    "bash abort throws its existing abort error after stopping the descendant tree",
    async () => {
      const rootDir = await mkdtemp(join(tmpdir(), "ai-agent-bash-abort-"));
      cleanup.push(rootDir);
      const token = `pi-clone-${randomUUID()}`;
      const fixture = await createBashTreeFixture(rootDir, token);
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
        await cleanupBashFixture(token, tree, execution);
      }
    },
    15_000,
  );

  test(
    "bash output limit returns its truncated result after stopping the descendant tree",
    async () => {
      const rootDir = await mkdtemp(join(tmpdir(), "ai-agent-bash-output-"));
      cleanup.push(rootDir);
      const token = `pi-clone-${randomUUID()}`;
      const fixture = await createBashTreeFixture(rootDir, token, "flood");
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
        await cleanupBashFixture(token, tree, execution);
      }
    },
    20_000,
  );

  test.skipIf(process.platform !== "win32")(
    "bash timeout settles and kills a pipe-inheriting background tree after the user shell exits",
    async () => {
      const rootDir = await mkdtemp(
        join(tmpdir(), "ai-agent-bash-exited-root-"),
      );
      cleanup.push(rootDir);
      const token = `pi-clone-${randomUUID()}`;
      const fixture = await createBashTreeFixture(rootDir, token);
      const tool = new BashTool({
        rootDir,
        shellPath: bashPath(),
        timeoutMs: 1_000,
      });
      let tree: RecordedProcessTree | undefined;
      let execution: Promise<Awaited<ReturnType<BashTool["execute"]>>> | undefined;

      try {
        execution = tool.execute({
          command: `${fixture.command} & exit 7`,
        });
        tree = await waitForRecordedTree(fixture.treePath);
        const result = await withDeadline(
          execution,
          "Bash exited-root termination did not settle.",
        );

        expect(result.isError).toBe(true);
        expect(JSON.parse(result.content)).toMatchObject({
          timedOut: true,
          outputTruncated: false,
        });
        await Promise.all([
          waitForProcessExit(tree.parentPid),
          waitForProcessExit(tree.descendantPid),
        ]);
      } finally {
        await cleanupBashFixture(token, tree, execution);
      }
    },
    20_000,
  );
});
