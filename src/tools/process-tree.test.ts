import { spawn, type ChildProcess } from "node:child_process";
import { readFileSync } from "node:fs";
import {
  access,
  chmod,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";

import { afterEach, expect, test, vi } from "vitest";

import {
  posixProcessTableRuntime,
  readPosixProcessTable,
  terminateProcessTree,
} from "./process-tree.js";

const originalProcessTableExecutor = posixProcessTableRuntime.execute;

afterEach(() => {
  posixProcessTableRuntime.execute = originalProcessTableExecutor;
  vi.restoreAllMocks();
  vi.useRealTimers();
});

const CHILD_PROGRAM = `
process.on("SIGTERM", () => {});
setInterval(() => {}, 1_000);
`;

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);

    if (process.platform === "linux") {
      try {
        const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
        const state = stat.slice(stat.lastIndexOf(")") + 2, -1)[0];

        if (state === "Z" || state === "X" || state === "x") {
          return false;
        }
      } catch (error: unknown) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          return false;
        }

        throw error;
      }
    }

    return true;
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") {
      return false;
    }

    throw error;
  }
}

async function waitForJsonFile(path: string): Promise<{
  readonly leader: number;
  readonly holder: number;
  readonly zombie: number;
}> {
  const deadline = Date.now() + 5_000;

  while (Date.now() < deadline) {
    try {
      const value = JSON.parse(await readFile(path, "utf8")) as {
        leader?: unknown;
        holder?: unknown;
        zombie?: unknown;
      };

      if (
        Number.isInteger(value.leader) &&
        Number.isInteger(value.holder) &&
        Number.isInteger(value.zombie)
      ) {
        return value as {
          readonly leader: number;
          readonly holder: number;
          readonly zombie: number;
        };
      }
    } catch (error: unknown) {
      if (
        (error as NodeJS.ErrnoException).code !== "ENOENT" &&
        !(error instanceof SyntaxError)
      ) {
        throw error;
      }
    }

    await new Promise((resolve) => setTimeout(resolve, 25));
  }

  throw new Error(`Timed out waiting for process state file: ${path}`);
}

function linuxProcessState(pid: number): string | undefined {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    return stat.slice(stat.lastIndexOf(")") + 2).split(" ", 1)[0];
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
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
try {
  writeFileSync(process.argv[1], String(child.pid), "utf8");
} catch {
  // Keep the known parent PID alive so test cleanup retains a valid tree root.
}
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

test("terminateProcessTree rejects a non-positive child PID", async () => {
  const child = {
    pid: 0,
    exitCode: null,
    signalCode: null,
  } as ChildProcess;

  await expect(terminateProcessTree(child, process.platform)).rejects.toThrow(
    "positive integer child PID",
  );
});

test("POSIX process-table lookup falls back across portable state selectors", async () => {
  const selectors: string[] = [];
  posixProcessTableRuntime.execute = async (selector) => {
    selectors.push(selector);

    if (selector !== "s") {
      throw new Error(`Unsupported selector: ${selector}`);
    }

    return " 42 42 Z\n";
  };

  await expect(readPosixProcessTable()).resolves.toBe(" 42 42 Z\n");
  expect(selectors).toEqual(["state", "stat", "s"]);
});

test.each(["", "not-a-process-row\n", "42\n", "42 42 ?\n"])(
  "POSIX process-table lookup rejects malformed output %j",
  async (output) => {
    posixProcessTableRuntime.execute = async () => output;

    await expect(readPosixProcessTable()).rejects.toThrow(
      /process table|supported state selector/i,
    );
  },
);

test("POSIX empty process-table output fails closed as a runnable group", async () => {
  vi.useFakeTimers();
  posixProcessTableRuntime.execute = async () => "";
  const signals: Array<NodeJS.Signals | 0 | undefined> = [];
  vi.spyOn(process, "kill").mockImplementation(((_pid, signal) => {
    signals.push(signal as NodeJS.Signals | 0 | undefined);
    return true;
  }) as typeof process.kill);
  const child = {
    pid: 42,
    exitCode: null,
    signalCode: null,
  } as ChildProcess;

  const termination = terminateProcessTree(child, "darwin");
  const rejection = expect(termination).rejects.toThrow(
    /retained runnable members/i,
  );
  await vi.advanceTimersByTimeAsync(2_000);

  await rejection;
  expect(signals).toContain("SIGKILL");
});

test("POSIX process-table lookup bounds a hung ps execution", async () => {
  vi.useFakeTimers();
  posixProcessTableRuntime.execute = async () =>
    new Promise<string>(() => undefined);
  vi.spyOn(process, "kill").mockImplementation(((_pid, signal) => {
    if (signal === 0) return true;
    return true;
  }) as typeof process.kill);
  const child = {
    pid: 42,
    exitCode: null,
    signalCode: null,
  } as ChildProcess;
  let outcome: "pending" | "resolved" | "rejected" = "pending";
  void terminateProcessTree(child, "darwin").then(
    () => { outcome = "resolved"; },
    () => { outcome = "rejected"; },
  );

  await vi.advanceTimersByTimeAsync(5_000);

  expect(outcome).toBe("rejected");
});

test("POSIX process-table parses zombie and runnable states", async () => {
  vi.useFakeTimers();
  let output = " 42 42 Z+\n";
  posixProcessTableRuntime.execute = async () => output;
  let alive = true;
  const signals: Array<NodeJS.Signals | 0 | undefined> = [];
  vi.spyOn(process, "kill").mockImplementation(((_pid, signal) => {
    signals.push(signal as NodeJS.Signals | 0 | undefined);
    if (signal === 0 && !alive) {
      throw Object.assign(new Error("gone"), { code: "ESRCH" });
    }
    if (signal === "SIGKILL") alive = false;
    return true;
  }) as typeof process.kill);
  const child = {
    pid: 42,
    exitCode: null,
    signalCode: null,
  } as ChildProcess;

  await expect(terminateProcessTree(child, "darwin")).resolves.toBeUndefined();
  expect(signals).not.toContain("SIGKILL");

  output = " 42 42 S+\n";
  signals.length = 0;
  alive = true;
  const runnableTermination = terminateProcessTree(child, "darwin");
  await vi.advanceTimersByTimeAsync(1_000);
  await expect(runnableTermination).resolves.toBeUndefined();
  expect(signals).toContain("SIGKILL");
});

test("Darwin treats EPERM from a process-group probe as existing and verifies its state", async () => {
  posixProcessTableRuntime.execute = async () => " 42 42 Z+\n";
  vi.spyOn(process, "kill").mockImplementation(((pid, signal) => {
    if (pid === -42 && signal === 0) {
      throw Object.assign(new Error("kill EPERM"), { code: "EPERM" });
    }
    return true;
  }) as typeof process.kill);
  const child = {
    pid: 42,
    exitCode: null,
    signalCode: null,
  } as ChildProcess;

  await expect(terminateProcessTree(child, "darwin")).resolves.toBeUndefined();
});

test("Linux fails closed when a process-group probe returns EPERM", async () => {
  vi.spyOn(process, "kill").mockImplementation(((pid, signal) => {
    if (pid === -42 && signal === 0) {
      throw Object.assign(new Error("kill EPERM"), { code: "EPERM" });
    }
    return true;
  }) as typeof process.kill);
  const child = {
    pid: 42,
    exitCode: null,
    signalCode: null,
  } as ChildProcess;

  await expect(terminateProcessTree(child, "linux")).rejects.toThrow(/EPERM/u);
});

test("Darwin signals each visible group member when a group signal returns EPERM", async () => {
  const runnable = new Set([42, 43]);
  posixProcessTableRuntime.execute = async () =>
    [...runnable].map((pid) => ` ${pid} 42 S+`).join("\n") + "\n";
  const signals: Array<readonly [number, NodeJS.Signals | 0 | undefined]> = [];
  vi.spyOn(process, "kill").mockImplementation(((pid, signal) => {
    signals.push([pid, signal as NodeJS.Signals | 0 | undefined]);
    if (pid === -42 && signal === 0 && runnable.size === 0) {
      throw Object.assign(new Error("kill ESRCH"), { code: "ESRCH" });
    }
    if (pid === -42 && signal !== 0) {
      throw Object.assign(new Error("kill EPERM"), { code: "EPERM" });
    }
    if (pid > 0 && signal === "SIGKILL") {
      runnable.delete(pid);
    }
    return true;
  }) as typeof process.kill);
  const child = {
    pid: 42,
    exitCode: null,
    signalCode: null,
  } as ChildProcess;

  await expect(terminateProcessTree(child, "darwin")).resolves.toBeUndefined();
  expect(signals).toContainEqual([42, "SIGTERM"]);
  expect(signals).toContainEqual([43, "SIGTERM"]);
  expect(signals).toContainEqual([42, "SIGKILL"]);
  expect(signals).toContainEqual([43, "SIGKILL"]);
});

test("Darwin accepts a validated zombie-only snapshot after group EPERM", async () => {
  let snapshots = 0;
  posixProcessTableRuntime.execute = async () => {
    snapshots += 1;
    return " 42 42 Z+\n";
  };
  vi.spyOn(process, "kill").mockImplementation(((pid, signal) => {
    if (pid === -42 && signal !== 0) {
      throw Object.assign(new Error("group EPERM"), { code: "EPERM" });
    }
    return true;
  }) as typeof process.kill);
  const child = {
    pid: 42,
    exitCode: null,
    signalCode: null,
  } as ChildProcess;

  await expect(terminateProcessTree(child, "darwin")).resolves.toBeUndefined();
  expect(snapshots).toBe(1);
});

test("Darwin fails closed when an EPERM member snapshot is malformed", async () => {
  posixProcessTableRuntime.execute = async () => "not-a-process-row\n";
  vi.spyOn(process, "kill").mockImplementation(((pid, signal) => {
    if (pid === -42 && signal !== 0) {
      throw Object.assign(new Error("group EPERM"), { code: "EPERM" });
    }
    return true;
  }) as typeof process.kill);
  const child = {
    pid: 42,
    exitCode: null,
    signalCode: null,
  } as ChildProcess;

  await expect(terminateProcessTree(child, "darwin")).rejects.toThrow(
    /member enumeration failed/u,
  );
});

test("Darwin fails closed when an enumerated group member cannot be signaled", async () => {
  posixProcessTableRuntime.execute = async () => " 42 42 S+\n 43 42 S+\n";
  const signals: Array<readonly [number, NodeJS.Signals | 0 | undefined]> = [];
  vi.spyOn(process, "kill").mockImplementation(((pid, signal) => {
    signals.push([pid, signal as NodeJS.Signals | 0 | undefined]);
    if (pid === -42 && signal !== 0) {
      throw Object.assign(new Error("group EPERM"), { code: "EPERM" });
    }
    if (pid === 43 && signal !== 0) {
      throw Object.assign(new Error("member EPERM"), { code: "EPERM" });
    }
    return true;
  }) as typeof process.kill);
  const child = {
    pid: 42,
    exitCode: null,
    signalCode: null,
  } as ChildProcess;

  await expect(terminateProcessTree(child, "darwin")).rejects.toThrow(/EPERM/u);
  expect(signals).toContainEqual([42, "SIGTERM"]);
  expect(signals).toContainEqual([43, "SIGTERM"]);
});

test.skipIf(process.platform === "win32")(
  "POSIX process-table lookup ignores a PATH-shadowed ps executable",
  async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "ai-agent-shadow-ps-"));
    const marker = join(rootDir, "shadow-ran");
    const shadow = join(rootDir, "ps");
    const originalPath = process.env["PATH"];

    try {
      await writeFile(
        shadow,
        `#!/bin/sh\nprintf shadow > ${JSON.stringify(marker)}\nprintf ' 42 S\\n'\n`,
        "utf8",
      );
      await chmod(shadow, 0o700);
      process.env["PATH"] = `${rootDir}${delimiter}${originalPath ?? ""}`;

      await expect(originalProcessTableExecutor("state")).resolves.toMatch(
        /\d/u,
      );
      await expect(access(marker)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      if (originalPath === undefined) {
        delete process.env["PATH"];
      } else {
        process.env["PATH"] = originalPath;
      }
      await rm(rootDir, { recursive: true, force: true });
    }
  },
);

test.skipIf(process.platform !== "linux")(
  "terminateProcessTree treats a zombie-only process group as terminated",
  async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "ai-agent-zombie-group-"));
    const statePath = join(rootDir, "state.json");
    const fixture = String.raw`
import json, os, signal, sys, time
state_path = sys.argv[1]
leader = os.getpid()
signal.signal(signal.SIGTERM, signal.SIG_IGN)
holder = os.fork()
if holder == 0:
    os.setpgid(0, 0)
    zombie = os.fork()
    if zombie == 0:
        os.setpgid(0, leader)
        os._exit(0)
    def cleanup(_signal, _frame):
        try:
            os.waitpid(zombie, 0)
        finally:
            os._exit(0)
    signal.signal(signal.SIGUSR1, cleanup)
    with open(state_path, "w", encoding="utf-8") as output:
        json.dump({"leader": leader, "holder": os.getpid(), "zombie": zombie}, output)
        output.flush()
        os.fsync(output.fileno())
    while True:
        time.sleep(1)
while True:
    time.sleep(1)
`;
    const leader = spawn("python3", ["-c", fixture, statePath], {
      detached: true,
      stdio: "ignore",
    });
    let holderPid: number | undefined;
    let zombiePid: number | undefined;

    try {
      const state = await waitForJsonFile(statePath);
      holderPid = state.holder;
      zombiePid = state.zombie;
      expect(state.leader).toBe(leader.pid);

      const deadline = Date.now() + 5_000;
      while (Date.now() < deadline && linuxProcessState(zombiePid) !== "Z") {
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      expect(linuxProcessState(zombiePid)).toBe("Z");

      await expect(terminateProcessTree(leader, "linux")).resolves.toBeUndefined();
      expect(isProcessAlive(state.leader)).toBe(false);
      expect(linuxProcessState(zombiePid)).toBe("Z");
    } finally {
      if (holderPid !== undefined && isProcessAlive(holderPid)) {
        process.kill(holderPid, "SIGUSR1");
        await waitForProcessExit(holderPid);
      }
      await forceCleanup(leader.pid, zombiePid);
      await rm(rootDir, { recursive: true, force: true });
    }
  },
  15_000,
);
