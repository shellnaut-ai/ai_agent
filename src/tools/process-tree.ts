import { execFile, spawn, type ChildProcess } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";

const POSIX_TERMINATION_GRACE_MS = 500;
const POSIX_POLL_INTERVAL_MS = 25;

function processExists(pid: number): boolean {
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

function processGroupExists(pid: number): boolean {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") {
      return false;
    }

    throw error;
  }
}

function isNonRunnableProcessState(state: string): boolean {
  return state === "Z" || state === "X" || state === "x";
}

async function linuxGroupHasRunnableMembers(pid: number): Promise<boolean> {
  const entries = await readdir("/proc", { withFileTypes: true });

  for (const entry of entries) {
    if (!entry.isDirectory() || !/^\d+$/u.test(entry.name)) {
      continue;
    }

    let stat: string;

    try {
      stat = await readFile(`/proc/${entry.name}/stat`, "utf8");
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        continue;
      }

      throw error;
    }

    const commandEnd = stat.lastIndexOf(")");

    if (commandEnd < 0) {
      throw new Error(`Invalid Linux process stat for PID ${entry.name}.`);
    }

    const fields = stat.slice(commandEnd + 2).trim().split(/\s+/u);
    const state = fields[0];
    const processGroup = Number(fields[2]);

    if (
      processGroup === pid &&
      state !== undefined &&
      !isNonRunnableProcessState(state)
    ) {
      return true;
    }
  }

  return false;
}

export const posixProcessTableRuntime: {
  execute(stateSelector: string): Promise<string>;
} = {
  execute(stateSelector: string): Promise<string> {
    return executePosixProcessTable(stateSelector);
  },
};

function executePosixProcessTable(stateSelector: string): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    execFile(
      "ps",
      ["-A", "-o", "pgid=", "-o", `${stateSelector}=`],
      {
        encoding: "utf8",
        env: { ...process.env, LC_ALL: "C" },
      },
      (error, stdout) => {
        if (error !== null) {
          reject(error);
          return;
        }

        resolve(stdout);
      },
    );
  });
}

export async function readPosixProcessTable(): Promise<string> {
  const errors: unknown[] = [];

  for (const selector of ["state", "stat", "s"] as const) {
    try {
      return await posixProcessTableRuntime.execute(selector);
    } catch (error: unknown) {
      errors.push(error);
    }
  }

  throw new AggregateError(
    errors,
    "Unable to read a POSIX process table with a supported state selector.",
  );
}

async function genericPosixGroupHasRunnableMembers(
  pid: number,
): Promise<boolean> {
  const table = await readPosixProcessTable();

  for (const line of table.split(/\r?\n/u)) {
    const match = /^\s*(\d+)\s+(\S)/u.exec(line);

    if (
      match !== null &&
      Number(match[1]) === pid &&
      !isNonRunnableProcessState(match[2]!)
    ) {
      return true;
    }
  }

  return false;
}

async function processGroupHasRunnableMembers(
  pid: number,
  platform: NodeJS.Platform,
): Promise<boolean> {
  if (!processGroupExists(pid)) {
    return false;
  }

  try {
    return platform === "linux"
      ? await linuxGroupHasRunnableMembers(pid)
      : await genericPosixGroupHasRunnableMembers(pid);
  } catch {
    // Enumeration is an optimization over the conservative kernel existence
    // check. If it fails, never claim that a potentially live group is gone.
    return processGroupExists(pid);
  }
}

function signalProcessGroup(pid: number, signal: NodeJS.Signals): boolean {
  try {
    process.kill(-pid, signal);
    return true;
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") {
      return false;
    }

    throw error;
  }
}

async function waitForProcessGroupExit(
  pid: number,
  timeoutMs: number,
  platform: NodeJS.Platform,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    if (!(await processGroupHasRunnableMembers(pid, platform))) {
      return true;
    }

    await new Promise((resolve) =>
      setTimeout(resolve, POSIX_POLL_INTERVAL_MS),
    );
  }

  return !(await processGroupHasRunnableMembers(pid, platform));
}

async function terminateWindowsProcessTree(pid: number): Promise<void> {
  const exitCode = await new Promise<number | null>((resolve, reject) => {
    const taskkill = spawn(
      "taskkill.exe",
      ["/PID", String(pid), "/T", "/F"],
      {
        stdio: "ignore",
        windowsHide: true,
      },
    );

    taskkill.once("error", reject);
    taskkill.once("close", resolve);
  });

  if (exitCode !== 0 && processExists(pid)) {
    throw new Error(
      `taskkill.exe failed to terminate process tree ${pid} (exit ${String(exitCode)}).`,
    );
  }
}

async function terminatePosixProcessGroup(
  pid: number,
  platform: NodeJS.Platform,
): Promise<void> {
  if (!signalProcessGroup(pid, "SIGTERM")) {
    return;
  }

  if (await waitForProcessGroupExit(
    pid,
    POSIX_TERMINATION_GRACE_MS,
    platform,
  )) {
    return;
  }

  if (!signalProcessGroup(pid, "SIGKILL")) {
    return;
  }

  if (!(await waitForProcessGroupExit(
    pid,
    POSIX_TERMINATION_GRACE_MS,
    platform,
  ))) {
    throw new Error(
      `Process group ${pid} retained runnable members after SIGKILL.`,
    );
  }
}

export async function terminateProcessTree(
  child: ChildProcess,
  platform: NodeJS.Platform,
): Promise<void> {
  const pid = child.pid;

  if (pid !== undefined && (!Number.isInteger(pid) || pid <= 0)) {
    throw new Error("Cannot terminate a process tree without a positive integer child PID.");
  }

  if (pid === undefined) {
    if (child.exitCode !== null || child.signalCode !== null) {
      return;
    }

    throw new Error("Cannot terminate a process tree without a child PID.");
  }

  if (platform === "win32") {
    await terminateWindowsProcessTree(pid);
    return;
  }

  await terminatePosixProcessGroup(pid, platform);
}
