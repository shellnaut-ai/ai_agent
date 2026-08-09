import { spawn, type ChildProcess } from "node:child_process";

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
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    if (!processGroupExists(pid)) {
      return true;
    }

    await new Promise((resolve) =>
      setTimeout(resolve, POSIX_POLL_INTERVAL_MS),
    );
  }

  return !processGroupExists(pid);
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

async function terminatePosixProcessGroup(pid: number): Promise<void> {
  if (!signalProcessGroup(pid, "SIGTERM")) {
    return;
  }

  if (await waitForProcessGroupExit(pid, POSIX_TERMINATION_GRACE_MS)) {
    return;
  }

  if (!signalProcessGroup(pid, "SIGKILL")) {
    return;
  }

  if (!(await waitForProcessGroupExit(pid, POSIX_TERMINATION_GRACE_MS))) {
    throw new Error(`Process group ${pid} remained alive after SIGKILL.`);
  }
}

export async function terminateProcessTree(
  child: ChildProcess,
  platform: NodeJS.Platform,
): Promise<void> {
  const pid = child.pid;

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

  await terminatePosixProcessGroup(pid);
}
