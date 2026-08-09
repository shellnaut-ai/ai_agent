import { spawn, type ChildProcess } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { join } from "node:path";
import { Transform, type Readable, type Writable } from "node:stream";

import {
  WINDOWS_BASH_SUPERVISOR_REVIEWED_ASSEMBLY_BASE64,
  WINDOWS_BASH_SUPERVISOR_REVIEWED_ASSEMBLY_SHA256,
} from "./windows-bash-supervisor-reviewed-assembly.js";

interface SupervisorTerminal {
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
}

export interface WindowsBashSupervisor {
  readonly child: ChildProcess;
  readonly output: Promise<{
    readonly stdout: Readable;
    readonly stderr: Readable;
  }>;
  readonly rootExit: Promise<number>;
  readonly close: Promise<SupervisorTerminal>;
  dispose(detach: boolean): Promise<void>;
}

export interface SpawnWindowsBashSupervisorOptions {
  readonly shellPath: string;
  readonly command: string;
  readonly cwd: string;
  /** Test-only compatibility option. No scratch directory is created. */
  readonly scratchRootDir?: string;
  readonly startupDelayMs?: number;
}

export const WINDOWS_BASH_SUPERVISOR_SECURITY = Object.freeze({
  configurationTransport: "inherited-anonymous-stdin",
  outputTransport: "inherited-anonymous-pipes",
  pathBasedConfiguration: false,
  namedPipeEndpoints: false,
  childHandleAllowlist: true,
  authenticatedControlFrames: true,
} as const);

const POWERSHELL_SUPERVISOR = `
$ErrorActionPreference = 'Stop'

function Read-RequiredLine([string]$field) {
  $line = [Console]::In.ReadLine()
  if ($null -eq $line) {
    throw "Missing supervisor field."
  }
  return $line
}

function Decode-Utf8([string]$value) {
  return [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($value))
}

function Resolve-ShellPath(
  [string]$shellPath,
  [string]$workingDirectory,
  [string]$searchPath,
  [string]$pathExtensions
) {
  $extension = [IO.Path]::GetExtension($shellPath)
  if (![string]::IsNullOrEmpty($extension)) {
    $names = @($shellPath)
  } else {
    $executableExtensions = @($pathExtensions.Split(';') |
      ForEach-Object { $_.Trim().ToLowerInvariant() } |
      Where-Object { $_ -eq '.exe' -or $_ -eq '.com' })
    if ($executableExtensions.Count -eq 0) {
      $executableExtensions = @('.exe', '.com')
    }
    $names = @($executableExtensions |
      ForEach-Object { [string]::Concat($shellPath, $_) })
  }

  $containsDirectory =
    [IO.Path]::IsPathRooted($shellPath) -or
    $shellPath.Contains('\\') -or
    $shellPath.Contains('/')
  if ($containsDirectory) {
    foreach ($name in $names) {
      $candidate = if ([IO.Path]::IsPathRooted($name)) {
        [IO.Path]::GetFullPath($name)
      } else {
        [IO.Path]::GetFullPath(
          [IO.Path]::Combine($workingDirectory, $name))
      }
      if ([IO.File]::Exists($candidate)) {
        return $candidate
      }
    }
    throw 'Windows Bash executable was not found.'
  }

  $directories = @()
  if ($shellPath -eq 'bash') {
    $programFiles = [Environment]::GetFolderPath(
      [Environment+SpecialFolder]::ProgramFiles)
    $localApplicationData = [Environment]::GetFolderPath(
      [Environment+SpecialFolder]::LocalApplicationData)
    if (![string]::IsNullOrWhiteSpace($programFiles)) {
      $directories += [IO.Path]::Combine($programFiles, 'Git', 'bin')
      $directories += [IO.Path]::Combine(
        $programFiles,
        'Git',
        'usr',
        'bin')
    }
    if (![string]::IsNullOrWhiteSpace($localApplicationData)) {
      $directories += [IO.Path]::Combine(
        $localApplicationData,
        'Programs',
        'Git',
        'bin')
    }
  }
  $directories += @($searchPath.Split(';') |
    ForEach-Object { $_.Trim().Trim('"') } |
    Where-Object { $_.Length -gt 0 })

  foreach ($directory in @($directories | Select-Object -Unique)) {
    foreach ($name in $names) {
      try {
        $searchDirectory = if ([IO.Path]::IsPathRooted($directory)) {
          $directory
        } else {
          [IO.Path]::Combine($workingDirectory, $directory)
        }
        $candidate = [IO.Path]::GetFullPath(
          [IO.Path]::Combine($searchDirectory, $name))
      } catch {
        continue
      }
      if ([IO.File]::Exists($candidate)) {
        return $candidate
      }
    }
  }

  throw 'Windows Bash executable was not found on PATH.'
}

try {
  $assemblyBase64 = Read-RequiredLine 'assembly'
  $shellPath = Decode-Utf8 (Read-RequiredLine 'shell')
  $searchPath = Decode-Utf8 (Read-RequiredLine 'searchPath')
  $pathExtensions = Decode-Utf8 (Read-RequiredLine 'pathExtensions')
  $command = Decode-Utf8 (Read-RequiredLine 'command')
  $workingDirectory = Decode-Utf8 (Read-RequiredLine 'cwd')
  $environmentBase64 = Read-RequiredLine 'environment'
  $startupDelay = [int](Read-RequiredLine 'startupDelay')
  $controlCapability = Read-RequiredLine 'controlCapability'

  $assemblyBytes = [Convert]::FromBase64String($assemblyBase64)
  $hash = [Security.Cryptography.SHA256]::Create()
  try {
    $actualHash = [BitConverter]::ToString(
      $hash.ComputeHash($assemblyBytes)).Replace('-', '').ToLowerInvariant()
  } finally {
    $hash.Dispose()
  }
  if ($actualHash -ne '${WINDOWS_BASH_SUPERVISOR_REVIEWED_ASSEMBLY_SHA256}') {
    throw 'Supervisor assembly integrity check failed.'
  }

  $assembly = [Reflection.Assembly]::Load($assemblyBytes)
  [Array]::Clear($assemblyBytes, 0, $assemblyBytes.Length)

  if ($startupDelay -gt 0) {
    Start-Sleep -Milliseconds $startupDelay
  }

  $shellPath = Resolve-ShellPath $shellPath $workingDirectory $searchPath $pathExtensions

  $supervisorType = $assembly.GetType(
    'PiCloneWindowsJobSupervisor',
    $true)
  $runMethod = $supervisorType.GetMethod('Run')
  $code = $runMethod.Invoke(
    $null,
    @(
      $shellPath,
      $command,
      $workingDirectory,
      $environmentBase64,
      $controlCapability))
  exit $code
} catch {
  [Console]::Error.WriteLine('Windows Bash supervisor setup failed safely.')
  exit 1
}
`;

function powershellPath(): string {
  return join(
    process.env["SystemRoot"] ?? "C:\\Windows",
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe",
  );
}

function createPowerShellEnvironment(): NodeJS.ProcessEnv {
  const systemRoot = process.env["SystemRoot"] ?? "C:\\Windows";

  return {
    ComSpec: join(systemRoot, "System32", "cmd.exe"),
    SystemRoot: systemRoot,
    WINDIR: systemRoot,
  };
}

function createWindowsEnvironmentBlock(environment: NodeJS.ProcessEnv): Buffer {
  const entries = Object.entries(environment)
    .filter(
      (entry): entry is [string, string] =>
        entry[1] !== undefined && !entry[0].includes("="),
    )
    .sort(([left], [right]) => {
      const normalizedLeft = left.toUpperCase();
      const normalizedRight = right.toUpperCase();
      return normalizedLeft < normalizedRight
        ? -1
        : normalizedLeft > normalizedRight
          ? 1
          : 0;
    })
    .map(([name, value]) => `${name}=${value}`);

  return Buffer.from(`${entries.join("\0")}\0\0`, "utf16le");
}

function encodeUtf8Line(value: string): string {
  return Buffer.from(value, "utf8").toString("base64");
}

function reviewedAssemblyBase64(): string {
  const bytes = Buffer.from(
    WINDOWS_BASH_SUPERVISOR_REVIEWED_ASSEMBLY_BASE64,
    "base64",
  );
  const digest = createHash("sha256").update(bytes).digest("hex");

  if (digest !== WINDOWS_BASH_SUPERVISOR_REVIEWED_ASSEMBLY_SHA256) {
    throw new Error("Windows Bash supervisor assembly integrity check failed.");
  }

  return WINDOWS_BASH_SUPERVISOR_REVIEWED_ASSEMBLY_BASE64;
}

function createConfigurationPayload(
  options: SpawnWindowsBashSupervisorOptions,
  controlCapability: string,
): string {
  if (
    options.shellPath.includes("\0") ||
    options.command.includes("\0") ||
    options.cwd.includes("\0")
  ) {
    throw new Error("Windows Bash supervisor input must not contain NUL.");
  }

  const startupDelayMs = options.startupDelayMs ?? 0;

  if (!Number.isInteger(startupDelayMs) || startupDelayMs < 0) {
    throw new Error(
      "Windows Bash supervisor startupDelayMs must be a non-negative integer.",
    );
  }

  return [
    reviewedAssemblyBase64(),
    encodeUtf8Line(options.shellPath),
    encodeUtf8Line(process.env["PATH"] ?? ""),
    encodeUtf8Line(process.env["PATHEXT"] ?? ".COM;.EXE"),
    encodeUtf8Line(options.command),
    encodeUtf8Line(options.cwd),
    createWindowsEnvironmentBlock(process.env).toString("base64"),
    String(startupDelayMs),
    controlCapability,
    "",
  ].join("\n");
}

export function parseWindowsBashExitStatus(raw: string): number {
  if (!/^\d+$/u.test(raw)) {
    throw new Error(`Invalid Windows Bash exit status: ${raw}`);
  }

  const exitCode = Number(raw);
  if (
    !Number.isSafeInteger(exitCode) ||
    exitCode < 0 ||
    exitCode > 0xffff_ffff
  ) {
    throw new Error(`Invalid Windows Bash exit status: ${raw}`);
  }

  return exitCode;
}

function observePromise<T>(promise: Promise<T>): Promise<T> {
  void promise.catch(() => undefined);
  return promise;
}

function sendConfiguration(
  child: ChildProcess,
  payload: string,
): Promise<void> {
  const input = child.stdin;

  if (input === null) {
    return Promise.reject(
      new Error("Windows Bash supervisor stdin is unavailable."),
    );
  }

  return writeSupervisorConfiguration(input, payload);
}

/** Internal transport seam used to prove callback-error handling. */
export function writeSupervisorConfiguration(
  input: Writable,
  payload: string,
): Promise<void> {
  return observePromise(new Promise<void>((resolve, reject) => {

    let settled = false;
    const finish = (
      error: Error | null | undefined,
      removeErrorListener: boolean,
    ): void => {
      if (settled) {
        return;
      }
      settled = true;
      if (removeErrorListener) {
        input.off("error", onError);
      }
      if (error === null || error === undefined) {
        resolve();
      } else {
        reject(new Error(
          "Windows Bash supervisor rejected its configuration.",
          { cause: error },
        ));
      }
    };
    const onError = (error: Error): void => finish(error, false);
    input.once("error", onError);
    input.end(payload, "utf8", (error?: Error | null) => {
      finish(error, error === null || error === undefined);
    });
  }));
}

function normalizeWindowsExitCode(exitCode: number): number {
  return exitCode < 0 ? exitCode >>> 0 : exitCode;
}

interface AuthenticatedOutputStreams {
  readonly stdout: Readable;
  readonly stderr: Readable;
  readonly rootExit: Promise<number>;
}

export function createAuthenticatedOutputStreams(
  stdoutSource: Readable,
  stderrSource: Readable,
  capability: string,
): AuthenticatedOutputStreams {
  const prefix = Buffer.from(
    `\x1ePI_CLONE_CONTROL_V1:${capability}:`,
    "ascii",
  );
  const terminator = 0x1f;
  const maxPayloadBytes = 32;
  let rootExitSeen = false;
  let resolveRootExit: (exitCode: number) => void = () => undefined;
  let rejectRootExit: (error: Error) => void = () => undefined;
  const rootExit = observePromise(new Promise<number>((resolve, reject) => {
    resolveRootExit = resolve;
    rejectRootExit = reject;
  }));

  const createStream = (
    source: Readable,
    channel: "stdout" | "stderr",
  ): Readable => {
    let pending = Buffer.alloc(0);
    const expectedEndPayload = `${channel}-end`;
    let endFrameSeen = false;
    const stream = new Transform({
      transform(chunk: Buffer | string, _encoding, callback): void {
        const bytes = Buffer.isBuffer(chunk)
          ? chunk
          : Buffer.from(chunk);
        pending = Buffer.concat([pending, bytes]);

        while (pending.length > 0) {
          const markerOffset = pending.indexOf(prefix);

          if (markerOffset < 0) {
            const emitLength = Math.max(
              0,
              pending.length - prefix.length + 1,
            );

            if (emitLength > 0) {
              this.push(pending.subarray(0, emitLength));
              pending = pending.subarray(emitLength);
            }
            break;
          }

          if (markerOffset > 0) {
            this.push(pending.subarray(0, markerOffset));
            pending = pending.subarray(markerOffset);
          }

          const terminatorOffset = pending.indexOf(
            terminator,
            prefix.length,
          );

          if (terminatorOffset < 0) {
            if (pending.length > prefix.length + maxPayloadBytes) {
              this.push(pending.subarray(0, 1));
              pending = pending.subarray(1);
              continue;
            }
            break;
          }

          const payload = pending
            .subarray(prefix.length, terminatorOffset)
            .toString("ascii");
          pending = pending.subarray(terminatorOffset + 1);

          if (payload === expectedEndPayload) {
            if (pending.length > 0) {
              callback(new Error(
                "Windows Bash supervisor sent data after output completion.",
              ));
              return;
            }

            if (channel === "stderr" && !rootExitSeen) {
              const error = new Error(
                "Windows Bash supervisor ended stderr before an authenticated root status.",
              );
              rejectRootExit(error);
              callback(error);
              return;
            }

            endFrameSeen = true;
            callback();
            this.push(null);
            source.unpipe(this);
            source.destroy();
            return;
          }

          if (channel === "stderr" && payload.startsWith("root:")) {
            const rawExitCode = payload.slice("root:".length);

            if (!/^\d{1,10}$/u.test(rawExitCode)) {
              callback(new Error(
                "Windows Bash supervisor sent an invalid root status.",
              ));
              return;
            }

            const exitCode = Number(rawExitCode);

            if (
              rootExitSeen ||
              !Number.isSafeInteger(exitCode) ||
              exitCode > 0xffff_ffff
            ) {
              callback(new Error(
                "Windows Bash supervisor sent an invalid root status.",
              ));
              return;
            }

            rootExitSeen = true;
            resolveRootExit(exitCode);
            continue;
          }

          callback(new Error(
            "Windows Bash supervisor sent an invalid control frame.",
          ));
          return;
        }

        callback();
      },
      flush(callback): void {
        if (pending.length > 0) {
          this.push(pending);
          pending = Buffer.alloc(0);
        }

        if (!endFrameSeen) {
          if (channel === "stderr" && !rootExitSeen) {
            rejectRootExit(new Error(
              "Windows Bash supervisor exited before an authenticated root status.",
            ));
          }

          callback(new Error(
            `Windows Bash supervisor exited before authenticated ${channel} completion.`,
          ));
          return;
        }

        if (channel === "stderr" && !rootExitSeen) {
          rejectRootExit(new Error(
            "Windows Bash supervisor exited before an authenticated root status.",
          ));
        }

        callback();
      },
    });
    source.once("error", () => {
      if (channel === "stderr") {
        rejectRootExit(new Error("Windows Bash supervisor output failed."));
      }
      stream.destroy(new Error("Windows Bash supervisor output failed."));
    });
    stream.once("error", () => {
      if (channel === "stderr" && !rootExitSeen) {
        rejectRootExit(new Error("Windows Bash supervisor output failed."));
      }
    });
    source.pipe(stream);

    return stream;
  };

  return {
    stdout: createStream(stdoutSource, "stdout"),
    stderr: createStream(stderrSource, "stderr"),
    rootExit,
  };
}

export async function spawnWindowsBashSupervisor(
  options: SpawnWindowsBashSupervisorOptions,
): Promise<WindowsBashSupervisor> {
  const controlCapability = randomBytes(32).toString("hex");
  const payload = createConfigurationPayload(options, controlCapability);
  const child = spawn(
    powershellPath(),
    [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-Command",
      POWERSHELL_SUPERVISOR,
    ],
    {
      cwd: process.env["SystemRoot"] ?? "C:\\Windows",
      env: createPowerShellEnvironment(),
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    },
  );
  const configurationSent = sendConfiguration(child, payload);
  const close = observePromise(
    new Promise<SupervisorTerminal>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (exitCode, signal) =>
        resolve({ exitCode, signal }));
    }),
  );
  const rawStdout = child.stdout;
  const rawStderr = child.stderr;

  if (rawStdout === null || rawStderr === null) {
    child.kill();
    throw new Error("Windows Bash supervisor output pipes are unavailable.");
  }

  const control = createAuthenticatedOutputStreams(
    rawStdout,
    rawStderr,
    controlCapability,
  );
  const output = observePromise(Promise.resolve({
    stdout: control.stdout,
    stderr: control.stderr,
  }));
  const rootExit = observePromise(
    Promise.all([configurationSent, control.rootExit]).then(
      ([, exitCode]) => normalizeWindowsExitCode(exitCode),
    ),
  );

  return {
    child,
    output,
    rootExit,
    close,
    async dispose(detach: boolean): Promise<void> {
      child.stdin?.destroy();
      let timeout: NodeJS.Timeout | undefined;
      try {
        await Promise.race([
          close,
          new Promise<never>((_resolve, reject) => {
            timeout = setTimeout(() => reject(new Error(
              "Windows Bash supervisor did not close after termination.",
            )), 2_000);
            timeout.unref();
          }),
        ]);
      } finally {
        if (timeout !== undefined) {
          clearTimeout(timeout);
        }
      }
      if (detach) {
        child.unref();
      }
    },
  };
}

export const windowsBashSupervisorRuntime: {
  spawn: typeof spawnWindowsBashSupervisor;
} = {
  spawn: spawnWindowsBashSupervisor,
};
