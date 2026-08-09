import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, readdir, readFile, rename, rm } from "node:fs/promises";
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
const compilerWorkspacePrefix = "pi-clone-bash-compiler-";

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

function localApplicationDataPath(): string {
  const path = process.env["LOCALAPPDATA"];

  if (path === undefined || path.length === 0) {
    throw new Error("LOCALAPPDATA is required for the Windows compiler test.");
  }

  return path;
}

async function compilerWorkspacePaths(): Promise<string[]> {
  const root = localApplicationDataPath();
  const entries = await readdir(root, { withFileTypes: true });
  return entries
    .filter(
      (entry) =>
        entry.isDirectory() && entry.name.startsWith(compilerWorkspacePrefix),
    )
    .map((entry) => join(root, entry.name))
    .sort();
}

async function waitForCompilerWorkspace(
  existing: readonly string[],
): Promise<string> {
  const baseline = new Set(existing);
  const deadline = performance.now() + 2_000;

  while (performance.now() < deadline) {
    const added = (await compilerWorkspacePaths()).filter(
      (path) => !baseline.has(path),
    );

    if (added.length === 1) {
      return added[0]!;
    }

    await new Promise((resolve) => setTimeout(resolve, 25));
  }

  throw new Error("Timed out waiting for the private compiler workspace.");
}

async function inspectCompilerWorkspaceAcl(path: string): Promise<{
  readonly protected: boolean;
  readonly owner: string;
  readonly current: string;
  readonly system: string;
  readonly allowed: readonly string[];
}> {
  const systemRoot = process.env["SystemRoot"] ?? "C:\\Windows";
  const powershell = join(
    systemRoot,
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe",
  );
  const script = String.raw`
$path = [Text.Encoding]::UTF8.GetString(
  [Convert]::FromBase64String($env:PI_CLONE_COMPILER_PATH))
$sections = [Security.AccessControl.AccessControlSections]::Owner -bor
  [Security.AccessControl.AccessControlSections]::Access
$acl = [IO.Directory]::GetAccessControl($path, $sections)
$current = [Security.Principal.WindowsIdentity]::GetCurrent().User
$system = [Security.Principal.SecurityIdentifier]::new(
  [Security.Principal.WellKnownSidType]::LocalSystemSid, $null)
$allowed = @($acl.GetAccessRules(
  $true,
  $true,
  [Security.Principal.SecurityIdentifier]) |
  Where-Object {
    $_.AccessControlType -eq
      [Security.AccessControl.AccessControlType]::Allow
  } |
  ForEach-Object { $_.IdentityReference.Value } |
  Sort-Object -Unique)
[Console]::Out.Write((ConvertTo-Json -Compress ([pscustomobject]@{
  protected = $acl.AreAccessRulesProtected
  owner = $acl.GetOwner(
    [Security.Principal.SecurityIdentifier]).Value
  current = $current.Value
  system = $system.Value
  allowed = $allowed
})))
`;

  return await new Promise((resolveAcl, reject) => {
    execFile(
      powershell,
      [
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-Command",
        script,
      ],
      {
        encoding: "utf8",
        env: {
          SystemRoot: systemRoot,
          PI_CLONE_COMPILER_PATH: Buffer.from(path, "utf8").toString("base64"),
        },
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        if (error !== null) {
          reject(new Error(`Compiler ACL inspection failed: ${stderr}`, {
            cause: error,
          }));
          return;
        }

        resolveAcl(JSON.parse(stdout) as {
          readonly protected: boolean;
          readonly owner: string;
          readonly current: string;
          readonly system: string;
          readonly allowed: readonly string[];
        });
      },
    );
  });
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
    test("uses a protected ephemeral compiler workspace without persisting secrets", async () => {
      const rootDir = await mkdtemp(join(tmpdir(), "bash-supervisor-security-"));
      cleanup.push(rootDir);
      const compilerWorkspacesBefore = await compilerWorkspacePaths();
      const environmentName = `PI_CLONE_SECURITY_${randomUUID().replaceAll("-", "")}`;
      process.env[environmentName] = `security-canary-environment-${randomUUID()}`;
      let supervisor: WindowsBashSupervisor | undefined;

      try {
        supervisor = await spawnWindowsBashSupervisor({
          shellPath: join(
            process.env["ProgramFiles"] ?? "C:\\Program Files",
            "Git",
            "bin",
            "bash.exe",
          ),
          command: `printf security-canary-command-${randomUUID()}`,
          cwd: rootDir,
          scratchRootDir: rootDir,
          startupDelayMs: 3_000,
        });
        const compilerWorkspace = await waitForCompilerWorkspace(
          compilerWorkspacesBefore,
        );
        const renameTarget = `${compilerWorkspace}-rename-attempt`;
        cleanup.push(renameTarget);
        const acl = await inspectCompilerWorkspaceAcl(compilerWorkspace);

        expect(acl.protected).toBe(true);
        expect(acl.owner).toBe(acl.current);
        expect(new Set(acl.allowed)).toEqual(
          new Set([acl.current, acl.system]),
        );
        await expect(
          rename(compilerWorkspace, renameTarget),
        ).rejects.toMatchObject({
          code: expect.stringMatching(/^(?:EBUSY|EPERM)$/u),
        });

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

      expect(await compilerWorkspacePaths()).toEqual(
        compilerWorkspacesBefore,
      );
    }, 15_000);

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
    }, 15_000);
  },
);
