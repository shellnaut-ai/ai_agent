import { spawn } from "node:child_process";
import {
  access,
  mkdir,
  mkdtemp,
  readdir,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const repositoryRoot = new URL("../", import.meta.url);
const smokeRoot = await mkdtemp(join(tmpdir(), "ai-agent-package-smoke-"));

try {
  // Prove the package lifecycle can reconstruct every runtime asset from a
  // clean dist directory, rather than accidentally packing a stale checkout.
  await rm(new URL("../dist/", import.meta.url), {
    recursive: true,
    force: true,
  });
  const archiveRoot = join(smokeRoot, "archive");
  const consumerRoot = join(smokeRoot, "consumer");
  const workspaceRoot = join(smokeRoot, "workspace");
  await Promise.all(
    [archiveRoot, consumerRoot, workspaceRoot].map((path) =>
      mkdir(path, { recursive: true }),
    ),
  );

  const packed = await runNpm(
    ["pack", "--json", "--pack-destination", archiveRoot],
    { cwd: repositoryRoot },
  );
  const packResult = JSON.parse(packed.stdout);

  if (
    !Array.isArray(packResult) ||
    packResult.length !== 1 ||
    typeof packResult[0]?.filename !== "string"
  ) {
    throw new Error("npm pack returned an unexpected manifest.");
  }

  const archivePath = join(archiveRoot, packResult[0].filename);
  await runNpm(
    [
      "install",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      "--prefix",
      consumerRoot,
      archivePath,
    ],
    { cwd: repositoryRoot },
  );

  const installedPackage = join(consumerRoot, "node_modules", "ai_agent");
  const installedTools = join(installedPackage, "dist", "tools");
  await access(join(installedTools, "windows-bash-supervisor-helper.cs"));
  const prohibitedArtifacts = (await listFiles(join(installedPackage, "dist")))
    .filter((path) =>
      /windows-bash-supervisor-assembly|\.(?:b64|dll|exe)$/iu.test(path),
    );

  if (prohibitedArtifacts.length > 0) {
    throw new Error(
      `Packed dist contains obsolete binary artifacts: ${prohibitedArtifacts.join(", ")}`,
    );
  }

  let supervisorPid;
  let restoreSupervisorSpawn = () => undefined;

  if (process.platform === "win32") {
    const supervisorModule = await import(
      pathToFileURL(
        join(installedTools, "windows-bash-supervisor.js"),
      ).href
    );
    const originalSpawn = supervisorModule.windowsBashSupervisorRuntime.spawn;
    supervisorModule.windowsBashSupervisorRuntime.spawn = async (options) => {
      const supervisor = await originalSpawn(options);
      supervisorPid = supervisor.child.pid;
      return supervisor;
    };
    restoreSupervisorSpawn = () => {
      supervisorModule.windowsBashSupervisorRuntime.spawn = originalSpawn;
    };
  }

  const { BashTool } = await import(
    pathToFileURL(join(installedPackage, "dist", "index.js")).href
  );
  const tool = new BashTool({
    rootDir: workspaceRoot,
    timeoutMs: 30_000,
  });
  const result = await tool
    .execute({ command: "printf package-dist-ok" })
    .finally(restoreSupervisorSpawn);
  const parsed = JSON.parse(result.content);

  if (
    result.isError ||
    parsed.exitCode !== 0 ||
    parsed.stdout !== "package-dist-ok" ||
    parsed.stderr !== ""
  ) {
    throw new Error(`Packed Bash execution failed: ${result.content}`);
  }

  const leakedScratch = (await readdir(workspaceRoot)).filter((name) =>
    name.startsWith("pi-clone-bash-supervisor-"),
  );

  if (leakedScratch.length > 0) {
    throw new Error(
      `Packed Bash execution leaked supervisor scratch: ${leakedScratch.join(", ")}`,
    );
  }

  if (process.platform === "win32") {
    if (!Number.isInteger(supervisorPid) || supervisorPid <= 0) {
      throw new Error("Packed Bash execution did not expose its supervisor PID.");
    }

    await waitForProcessExit(supervisorPid, 5_000);
  }

  process.stdout.write(
    "Packed dist includes reviewed helper source and executes Bash without leaks.\n",
  );
} finally {
  await rm(smokeRoot, { recursive: true, force: true });
}

async function listFiles(root) {
  const files = [];

  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name);

    if (entry.isDirectory()) {
      files.push(...await listFiles(path));
    } else {
      files.push(path);
    }
  }

  return files;
}

async function waitForProcessExit(pid, timeoutMs) {
  const deadline = performance.now() + timeoutMs;

  while (isProcessAlive(pid)) {
    if (performance.now() >= deadline) {
      throw new Error(`Packed Bash supervisor ${String(pid)} leaked.`);
    }

    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error?.code === "ESRCH") {
      return false;
    }

    throw error;
  }
}

async function runNpm(args, options) {
  const npmCli = process.env.npm_execpath;

  if (npmCli === undefined) {
    throw new Error("npm_execpath is required for the package smoke.");
  }

  return run(process.execPath, [npmCli, ...args], options);
}

function run(command, args, options) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    const stdout = [];
    const stderr = [];
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`Command timed out: ${command} ${args.join(" ")}`));
    }, 120_000);
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (exitCode) => {
      clearTimeout(timer);
      const result = {
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
      };

      if (exitCode === 0) {
        resolve(result);
      } else {
        reject(
          new Error(
            `Command exited ${String(exitCode)}: ${command} ${args.join(" ")}\n` +
              result.stderr.slice(-4_096),
          ),
        );
      }
    });
  });
}
