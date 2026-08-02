import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const temporaryDirectory = await mkdtemp(join(tmpdir(), "pi-clone-eof-"));
const sessionPath = join(temporaryDirectory, "session.jsonl");

try {
  // `< NUL`은 Windows 콘솔 호스트와 실행기 조합에 따라 debugger status를 외부로
  // 전달할 수 있다. 실제 검증 대상은 콘솔 redirection이 아니라 "stdin pipe EOF 뒤
  // CLI가 스스로 정상 종료하는가"이므로 자식 stdin만 명시적으로 닫는다.
  const child = spawn(
    process.execPath,
    [
      "--enable-source-maps",
      join(projectRoot, "dist", "cli.js"),
      "chat",
      "--session",
      sessionPath,
    ],
    {
      cwd: projectRoot,
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

  // 질문을 읽고 있는 실제 CLI에 EOF를 전달한다.
  child.stdin.end();

  const exitCode = await waitForExit(child, 10_000);
  if (exitCode !== 0) {
    throw new Error(`CLI EOF smoke failed with exit code ${String(exitCode)}\n${stderr}`);
  }
  if (stderr !== "") {
    throw new Error(`CLI EOF smoke wrote to stderr:\n${stderr}`);
  }
  if (!stdout.includes("대화를 종료합니다.")) {
    throw new Error(`CLI EOF smoke missed the shutdown message:\n${stdout}`);
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
