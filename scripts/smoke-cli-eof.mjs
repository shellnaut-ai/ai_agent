import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const temporaryDirectory = await mkdtemp(join(tmpdir(), "ai-agent-eof-"));

try {
  const child = spawn(
    process.execPath,
    [
      "--enable-source-maps",
      join(projectRoot, "dist", "cli.js"),
      "chat",
      "--session",
      "eof-smoke",
    ],
    {
      cwd: temporaryDirectory,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    },
  );

  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  child.stdin.end();

  const exitCode = await waitForExit(child, 10_000);
  if (exitCode !== 0) {
    throw new Error(
      `CLI EOF smoke failed with exit code ${String(exitCode)}\n${stderr}`,
    );
  }
  if (stderr !== "") {
    throw new Error(`CLI EOF smoke wrote to stderr:\n${stderr}`);
  }

  process.stdout.write("CLI EOF smoke passed (exit 0)\n");
} finally {
  await rm(temporaryDirectory, { recursive: true, force: true });
}

function waitForExit(child, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      child.kill();
      reject(new Error(`CLI EOF smoke timed out after ${String(timeoutMs)}ms`));
    }, timeoutMs);

    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once("exit", (code) => {
      clearTimeout(timeout);
      resolve(code);
    });
  });
}
