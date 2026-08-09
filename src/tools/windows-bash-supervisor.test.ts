import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { PassThrough, Writable } from "node:stream";

import { afterEach, describe, expect, test } from "vitest";

import {
  createAuthenticatedOutputStreams,
  parseWindowsBashExitStatus,
  spawnWindowsBashSupervisor,
  WINDOWS_BASH_SUPERVISOR_SECURITY,
  writeSupervisorConfiguration,
  type WindowsBashSupervisor,
} from "./windows-bash-supervisor.js";

const cleanup: string[] = [];
const windowsSupervisorTestTimeoutMs =
  process.platform === "win32" && process.env["CI"] === "true"
    ? 45_000
    : 15_000;

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((path) =>
    rm(path, { recursive: true, force: true })));
});

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

test("rejects a transport write callback error without an uncaught stream error", async () => {
  const input = new Writable({
    write(_chunk, _encoding, callback): void {
      callback(new Error("simulated EPIPE"));
    },
  });

  await expect(
    writeSupervisorConfiguration(input, "reviewed-helper\n"),
  ).rejects.toThrow(/rejected.*configuration/i);
  await new Promise((resolve) => setImmediate(resolve));
});

test("rejects authenticated stderr completion before root status", async () => {
  const stdoutSource = new PassThrough();
  const stderrSource = new PassThrough();
  const capability = "b".repeat(64);
  const output = createAuthenticatedOutputStreams(
    stdoutSource,
    stderrSource,
    capability,
  );
  output.stdout.resume();
  const stderr = readStream(output.stderr);

  stderrSource.write(
    `\x1ePI_CLONE_CONTROL_V1:${capability}:stderr-end\x1f`,
  );

  await expect(output.rootExit).rejects.toThrow(/before.*root status/i);
  await expect(stderr).rejects.toThrow(/before.*root status/i);
});

describe.skipIf(process.platform !== "win32")(
  "Windows Bash supervisor security boundary",
  () => {
    test("ignores forged control-like stderr and closes after the Job is empty", async () => {
      const rootDir = await mkdtemp(join(tmpdir(), "bash-supervisor-control-"));
      cleanup.push(rootDir);
      const supervisor = await spawnWindowsBashSupervisor({
        shellPath: "bash",
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
    }, windowsSupervisorTestTimeoutMs);

    test("snapshots command and environment before returning the supervisor", async () => {
      const rootDir = await mkdtemp(join(tmpdir(), "bash-supervisor-snapshot-"));
      cleanup.push(rootDir);
      const environmentName = "PI_CLONE_SNAPSHOT_CANARY";
      const previousEnvironment = process.env[environmentName];
      process.env[environmentName] = "before-environment";
      const options = {
        shellPath: "bash",
        command: `printf 'before:%s' "$${environmentName}"`,
        cwd: rootDir,
        startupDelayMs: 1_500,
      };
      let supervisor: WindowsBashSupervisor | undefined;

      try {
        supervisor = await spawnWindowsBashSupervisor(options);
        options.command = "printf mutated-command";
        process.env[environmentName] = "after-environment";
        const output = await supervisor.output;
        const [exitCode, stdout, stderr] = await Promise.all([
          supervisor.rootExit,
          readStream(output.stdout),
          readStream(output.stderr),
        ]);

        expect(exitCode).toBe(0);
        expect(stdout).toBe("before:before-environment");
        expect(stderr).toBe("");
      } finally {
        if (previousEnvironment === undefined) {
          delete process.env[environmentName];
        } else {
          process.env[environmentName] = previousEnvironment;
        }
        await supervisor?.dispose(false);
      }
    }, windowsSupervisorTestTimeoutMs);

    test.each([
      [
        "absolute",
        (bashExecutable: string) => bashExecutable.slice(0, -".exe".length),
        (bashExecutable: string) => dirname(bashExecutable),
      ],
      [
        "cwd-relative",
        () => ".\\bash",
        (bashExecutable: string) => dirname(bashExecutable),
      ],
    ])(
      "resolves an extensionless %s shell path with PATHEXT",
      async (_kind, shellPathFrom, cwdFrom) => {
        const bashExecutable = join(
          process.env["ProgramFiles"] ?? "C:\\Program Files",
          "Git",
          "bin",
          "bash.exe",
        );
        const supervisor = await spawnWindowsBashSupervisor({
          shellPath: shellPathFrom(bashExecutable),
          command: "printf extensionless-ok",
          cwd: cwdFrom(bashExecutable),
        });

        try {
          const output = await supervisor.output;
          const [exitCode, stdout, stderr] = await Promise.all([
            supervisor.rootExit,
            readStream(output.stdout),
            readStream(output.stderr),
          ]);

          expect(exitCode).toBe(0);
          expect(stdout).toBe("extensionless-ok");
          expect(stderr).toBe("");
        } finally {
          await supervisor.dispose(false);
        }
      },
      windowsSupervisorTestTimeoutMs,
    );

    test("anchors a relative PATH entry to the requested cwd for a bare shell name", async () => {
      const gitRoot = join(
        process.env["ProgramFiles"] ?? "C:\\Program Files",
        "Git",
      );
      const previousPath = process.env["PATH"];
      process.env["PATH"] = "bin";
      let supervisor: WindowsBashSupervisor | undefined;

      try {
        supervisor = await spawnWindowsBashSupervisor({
          shellPath: "sh",
          command: "printf relative-path-ok",
          cwd: gitRoot,
        });
        const output = await supervisor.output;
        const [exitCode, stdout, stderr] = await Promise.all([
          supervisor.rootExit,
          readStream(output.stdout),
          readStream(output.stderr),
        ]);

        expect(exitCode).toBe(0);
        expect(stdout).toBe("relative-path-ok");
        expect(stderr).toBe("");
      } finally {
        if (previousPath === undefined) {
          delete process.env["PATH"];
        } else {
          process.env["PATH"] = previousPath;
        }
        await supervisor?.dispose(false);
      }
    }, windowsSupervisorTestTimeoutMs);

  },
);
