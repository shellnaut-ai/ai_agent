import { spawn } from "node:child_process";
import { resolve } from "node:path";

import type { AgentTool, JsonObject, ToolExecution } from "../core/contracts.js";

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS = 120_000;
const MAX_OUTPUT_BYTES = 1_048_576;

export interface BashToolArguments {
  readonly command: string;
  readonly timeoutMs?: number;
}

interface ShellCommandResult {
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
  readonly outputExceeded: boolean;
}

/**
 * 운영체제 기본 shell에서 명령 하나를 workspace cwd로 실행한다.
 *
 * 사용자의 요청대로 승인창과 명령 allowlist는 두지 않는다. 그만큼 모델이 실행하는 명령은
 * pi-clone 프로세스와 같은 OS 권한을 가진다. 이 클래스가 제공하는 제한은 실행 시간과 반환
 * 출력 크기뿐이며, container/sandbox나 세밀한 권한 분리는 이후 보안 계층의 책임이다.
 */
export class BashTool implements AgentTool<BashToolArguments> {
  readonly name = "bash";
  readonly description =
    "Run a shell command in the configured workspace and return its exit code and output.";
  readonly inputSchema: JsonObject = {
    type: "object",
    properties: {
      command: { type: "string" },
      timeoutMs: { type: "integer", minimum: 1, maximum: MAX_TIMEOUT_MS },
    },
    required: ["command"],
    additionalProperties: false,
  };

  readonly #workspace: string;

  constructor(workspace: string) {
    this.#workspace = resolve(workspace);
  }

  parse(argumentsValue: unknown): BashToolArguments {
    if (!isBashArguments(argumentsValue)) {
      throw new Error("Expected command and optional timeoutMs between 1 and 120000");
    }
    return "timeoutMs" in argumentsValue
      ? { command: argumentsValue.command, timeoutMs: argumentsValue.timeoutMs }
      : { command: argumentsValue.command };
  }

  async execute(argumentsValue: BashToolArguments): Promise<ToolExecution> {
    const timeoutMs = argumentsValue.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const result = await runShellCommand(argumentsValue.command, this.#workspace, timeoutMs);
    const content = formatCommandResult(result.exitCode, result.stdout, result.stderr);

    if (result.outputExceeded) {
      throw new Error(`Command output exceeded ${MAX_OUTPUT_BYTES} bytes\n${content}`);
    }
    if (result.timedOut) {
      throw new Error(`Command timed out after ${timeoutMs}ms\n${content}`);
    }
    if (result.exitCode !== 0) throw new Error(content);
    return { content };
  }
}

function isBashArguments(value: unknown): value is Required<Pick<BashToolArguments, "command">> &
  Pick<BashToolArguments, "timeoutMs"> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const keys = Object.keys(value);
  if (keys.length < 1 || keys.length > 2 || !keys.includes("command")) return false;
  if (keys.some((key) => key !== "command" && key !== "timeoutMs")) return false;
  const candidate = value as Record<string, unknown>;
  if (typeof candidate.command !== "string" || candidate.command.trim() === "") return false;
  if (!("timeoutMs" in candidate)) return true;
  return (
    typeof candidate.timeoutMs === "number" &&
    Number.isInteger(candidate.timeoutMs) &&
    candidate.timeoutMs >= 1 &&
    candidate.timeoutMs <= MAX_TIMEOUT_MS
  );
}

function runShellCommand(command: string, cwd: string, timeoutMs: number): Promise<ShellCommandResult> {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, {
      cwd,
      shell: true,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let capturedBytes = 0;
    let timedOut = false;
    let outputExceeded = false;
    let settled = false;

    // stdout/stderr의 상대적인 도착 순서는 보존 대상이 아니다. Provider에 돌려줄 때 채널별로
    // 구분하는 대신, 두 채널의 byte 합계는 공유해 한쪽으로 상한을 우회하지 못하게 한다.
    const capture = (destination: Buffer[], chunk: Buffer): void => {
      const remaining = MAX_OUTPUT_BYTES - capturedBytes;
      if (remaining > 0) {
        const retained = chunk.subarray(0, remaining);
        destination.push(retained);
        capturedBytes += retained.byteLength;
      }
      if (chunk.byteLength > remaining && !outputExceeded) {
        outputExceeded = true;
        clearTimeout(timer);
        child.kill();
      }
    };

    child.stdout.on("data", (chunk: Buffer) => capture(stdout, chunk));
    child.stderr.on("data", (chunk: Buffer) => capture(stderr, chunk));
    child.once("error", (error: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      rejectPromise(error);
    });

    // timer는 close 결과를 확정하는 신호만 세운다. kill 뒤에도 남아 있던 pipe data를 close까지
    // 읽어야 제한 내 진단 출력이 ToolResult에 포함되고 Promise가 두 번 끝나지 않는다.
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs);

    child.once("close", (code: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolvePromise({
        exitCode: code,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
        timedOut,
        outputExceeded,
      });
    });
  });
}

function formatCommandResult(exitCode: number | null, stdout: string, stderr: string): string {
  return [
    `Exit code: ${exitCode === null ? "unknown" : String(exitCode)}`,
    "stdout:",
    stdout,
    "stderr:",
    stderr,
  ].join("\n");
}
