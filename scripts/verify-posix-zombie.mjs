import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { terminateProcessTree } from "../dist/tools/process-tree.js";

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
        json.dump({"holder": os.getpid(), "zombie": zombie}, output)
        output.flush()
        os.fsync(output.fileno())
    while True:
        time.sleep(1)
while True:
    time.sleep(1)
`;

function processState(pid) {
  try {
    const stat = requireStat(pid);
    return stat.slice(stat.lastIndexOf(")") + 2).split(" ", 1)[0];
  } catch (error) {
    if (error?.code === "ENOENT") return undefined;
    throw error;
  }
}

function requireStat(pid) {
  return readFileSync(`/proc/${pid}/stat`, "utf8");
}

async function waitForState(path) {
  const deadline = Date.now() + 5_000;

  while (Date.now() < deadline) {
    try {
      const state = JSON.parse(await readFile(path, "utf8"));
      if (Number.isInteger(state.holder) && Number.isInteger(state.zombie)) {
        return state;
      }
    } catch (error) {
      if (error?.code !== "ENOENT" && !(error instanceof SyntaxError)) {
        throw error;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("POSIX zombie fixture did not initialize.");
}

const rootDir = await mkdtemp(join(tmpdir(), "pi-clone-zombie-smoke-"));
const statePath = join(rootDir, "state.json");
const leader = spawn("python3", ["-c", fixture, statePath], {
  detached: true,
  stdio: "ignore",
});
let state;

try {
  state = await waitForState(statePath);
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline && processState(state.zombie) !== "Z") {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  if (processState(state.zombie) !== "Z") {
    throw new Error("POSIX zombie fixture did not reach zombie state.");
  }

  await terminateProcessTree(leader, "linux");
  process.stdout.write("POSIX zombie process-group smoke passed.\n");
} finally {
  if (state?.holder !== undefined && processState(state.holder) !== undefined) {
    try {
      process.kill(state.holder, "SIGUSR1");
    } catch (error) {
      if (error?.code !== "ESRCH") throw error;
    }
  }
  try {
    process.kill(-leader.pid, "SIGKILL");
  } catch (error) {
    if (error?.code !== "ESRCH") throw error;
  }
  await rm(rootDir, { recursive: true, force: true });
}
