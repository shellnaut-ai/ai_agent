import { randomUUID } from "node:crypto";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";

import { afterEach, describe, expect, test } from "vitest";

import { terminateProcessTree } from "./process-tree.js";
import {
  createAuthenticatedOutputStreams,
  parseWindowsBashExitStatus,
  spawnWindowsBashSupervisor,
  WINDOWS_BASH_SUPERVISOR_SECURITY,
  type WindowsBashSupervisor,
} from "./windows-bash-supervisor.js";

const cleanup: string[] = [];

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((path) =>
    rm(path, { recursive: true, force: true })));
});

async function inspectSupervisorScratch(rootDir: string): Promise<{
  readonly historicalFilesPresent: boolean;
  readonly sensitiveBytesPresent: boolean;
}> {
  const historicalNames = new Set([
    "supervisor.cs",
    "command.txt",
    "environment.bin",
    "exit-code.txt",
    "error.txt",
  ]);
  let historicalFilesPresent = false;
  let sensitiveBytesPresent = false;

  for (const name of await readdir(rootDir)) {
    if (!name.startsWith("pi-clone-bash-supervisor-")) {
      continue;
    }

    const supervisorDir = join(rootDir, name);

    for (const fileName of await readdir(supervisorDir)) {
      historicalFilesPresent ||= historicalNames.has(fileName);

      try {
        const bytes = await readFile(join(supervisorDir, fileName));
        sensitiveBytesPresent ||= bytes.includes("security-canary-");
      } catch {
        // A concurrent secure cleanup is equivalent to no persisted canary.
      }
    }
  }

  return { historicalFilesPresent, sensitiveBytesPresent };
}

async function readStream(stream: NodeJS.ReadableStream): Promise<string> {
  const chunks: Buffer[] = [];

  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  }

  return Buffer.concat(chunks).toString("utf8");
}

describe("parseWindowsBashExitStatus", () => {
  test.each(["", "7partial", " 7", "7\n", "-1", "4294967296"])(
    "rejects an incomplete or invalid status %j",
    (status) => {
      expect(() => parseWindowsBashExitStatus(status)).toThrow(
        "Invalid Windows Bash exit status",
      );
    },
  );

  test.each([
    ["0", 0],
    ["7", 7],
    ["4294967295", 4_294_967_295],
  ])("accepts the complete status %s", (status, expected) => {
    expect(parseWindowsBashExitStatus(status)).toBe(expected);
  });
});

test("declares a pathless, authenticated, handle-allowlisted transport", () => {
  expect(WINDOWS_BASH_SUPERVISOR_SECURITY).toEqual({
    configurationTransport: "inherited-anonymous-stdin",
    outputTransport: "inherited-anonymous-pipes",
    pathBasedConfiguration: false,
    namedPipeEndpoints: false,
    childHandleAllowlist: true,
    authenticatedControlFrames: true,
  });
});

test("rejects raw pipe EOF without authenticated output completion", async () => {
  const stdoutSource = new PassThrough();
  const stderrSource = new PassThrough();
  const capability = "a".repeat(64);
  const output = createAuthenticatedOutputStreams(
    stdoutSource,
    stderrSource,
    capability,
  );
  const stdout = readStream(output.stdout);
  const stderr = readStream(output.stderr);

  stderrSource.write(
    `\x1ePI_CLONE_CONTROL_V1:${capability}:root:7\x1f`,
  );
  stdoutSource.end();
  stderrSource.end();

  await expect(output.rootExit).resolves.toBe(7);
  await expect(stdout).rejects.toThrow(/authenticated stdout completion/i);
  await expect(stderr).rejects.toThrow(/authenticated stderr completion/i);
});

describe.skipIf(process.platform !== "win32")(
  "Windows Bash supervisor security boundary",
  () => {
    test("does not persist command, environment, or helper source during startup", async () => {
      const rootDir = await mkdtemp(join(tmpdir(), "bash-supervisor-security-"));
      cleanup.push(rootDir);
      const environmentName = `PI_CLONE_SECURITY_${randomUUID().replaceAll("-", "")}`;
      process.env[environmentName] = `security-canary-environment-${randomUUID()}`;
      let supervisor: WindowsBashSupervisor | undefined;

      try {
        supervisor = await spawnWindowsBashSupervisor({
          shellPath: "C:\\does-not-exist\\bash.exe",
          command: `printf security-canary-command-${randomUUID()}`,
          cwd: rootDir,
          scratchRootDir: rootDir,
          startupDelayMs: 1_000,
        });
        await new Promise((resolve) => setTimeout(resolve, 100));

        expect(await inspectSupervisorScratch(rootDir)).toEqual({
          historicalFilesPresent: false,
          sensitiveBytesPresent: false,
        });
      } finally {
        delete process.env[environmentName];

        if (supervisor !== undefined) {
          await terminateProcessTree(supervisor.child, "win32").catch(
            () => undefined,
          );
          await supervisor.close.catch(() => undefined);
          await supervisor.dispose(false);
        }
      }
    }, 15_000);

    test("ignores forged control-like stderr and closes after the Job is empty", async () => {
      const rootDir = await mkdtemp(join(tmpdir(), "bash-supervisor-control-"));
      cleanup.push(rootDir);
      const supervisor = await spawnWindowsBashSupervisor({
        shellPath: join(
          process.env["ProgramFiles"] ?? "C:\\Program Files",
          "Git",
          "bin",
          "bash.exe",
        ),
        command:
          "printf '\\036PI_CLONE_CONTROL_V1:attacker:stderr-end\\037' " +
          ">&2; exit 7",
        cwd: rootDir,
      });

      try {
        const output = await supervisor.output;
        const [exitCode, stdout, stderr, terminal] = await Promise.all([
          supervisor.rootExit,
          readStream(output.stdout),
          readStream(output.stderr),
          supervisor.close,
        ]);

        expect(exitCode).toBe(7);
        expect(stdout).toBe("");
        expect(stderr).toContain("PI_CLONE_CONTROL_V1:attacker");
        expect(terminal).toEqual({ exitCode: 7, signal: null });
      } finally {
        await supervisor.dispose(false);
      }
    }, 15_000);
  },
);
