import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, test } from "vitest";

import { terminateProcessTree } from "./process-tree.js";

const CHILD_PROGRAM = `
process.on("SIGTERM", () => {});
setInterval(() => {}, 1_000);
`;

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

async function waitForPidFile(path: string): Promise<number> {
  const deadline = Date.now() + 5_000;

  while (Date.now() < deadline) {
    try {
      const pid = Number.parseInt(await readFile(path, "utf8"), 10);

      if (Number.isInteger(pid) && pid > 0) {
        return pid;
      }
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
    }

    await new Promise((resolve) => setTimeout(resolve, 25));
  }

  throw new Error(`Timed out waiting for child PID file: ${path}`);
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

async function runTaskkill(pid: number): Promise<void> {
  await new Promise<void>((resolve) => {
    const killer = spawn(
      "taskkill.exe",
      ["/PID", String(pid), "/T", "/F"],
      {
        stdio: "ignore",
        windowsHide: true,
      },
    );

    killer.once("error", () => resolve());
    killer.once("close", () => resolve());
  });
}

async function forceCleanup(
  parentPid: number | undefined,
  childPid: number | undefined,
): Promise<void> {
  if (process.platform === "win32") {
    for (const pid of [parentPid, childPid]) {
      if (pid !== undefined && isProcessAlive(pid)) {
        await runTaskkill(pid);
      }
    }
  } else {
    if (parentPid !== undefined) {
      try {
        process.kill(-parentPid, "SIGKILL");
      } catch (error: unknown) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") {
          throw error;
        }
      }
    }

    if (childPid !== undefined && isProcessAlive(childPid)) {
      process.kill(childPid, "SIGKILL");
    }
  }

  await Promise.all(
    [parentPid, childPid]
      .filter((pid): pid is number => pid !== undefined)
      .map(async (pid) => {
        if (isProcessAlive(pid)) {
          await waitForProcessExit(pid);
        }
      }),
  );
}

test(
  "terminateProcessTree stops the spawned parent and its real descendant",
  async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "ai-agent-process-tree-"));
    const childPidPath = join(rootDir, "child.pid");
    const parentProgram = `
const { spawn } = require("node:child_process");
const { writeFileSync } = require("node:fs");
const child = spawn(process.execPath, ["-e", ${JSON.stringify(CHILD_PROGRAM)}], {
  detached: process.platform === "win32",
  stdio: "ignore",
  windowsHide: true,
});
writeFileSync(process.argv[1], String(child.pid), "utf8");
setInterval(() => {}, 1_000);
`;
    const parent = spawn(process.execPath, ["-e", parentProgram, childPidPath], {
      detached: process.platform !== "win32",
      stdio: "ignore",
      windowsHide: true,
    });
    const parentPid = parent.pid;
    let childPid: number | undefined;

    try {
      expect(parentPid).toBeTypeOf("number");
      childPid = await waitForPidFile(childPidPath);
      expect(isProcessAlive(parentPid!)).toBe(true);
      expect(isProcessAlive(childPid)).toBe(true);

      await terminateProcessTree(parent, process.platform);

      await Promise.all([
        waitForProcessExit(parentPid!),
        waitForProcessExit(childPid),
      ]);
      expect(isProcessAlive(parentPid!)).toBe(false);
      expect(isProcessAlive(childPid)).toBe(false);
    } finally {
      await forceCleanup(parentPid, childPid);
      await rm(rootDir, { recursive: true, force: true });
    }
  },
  15_000,
);
