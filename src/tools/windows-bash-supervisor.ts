import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

interface SupervisorTerminal {
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
}

interface PausedPipe {
  readonly server: Server;
  readonly connection: Promise<Socket>;
  socket?: Socket;
}

export interface WindowsBashSupervisor {
  readonly child: ChildProcess;
  readonly output: Promise<{
    readonly stdout: Socket;
    readonly stderr: Socket;
  }>;
  readonly rootExit: Promise<number>;
  readonly close: Promise<SupervisorTerminal>;
  dispose(detach: boolean): Promise<void>;
}

const POWERSHELL_SUPERVISOR = `
$ErrorActionPreference = 'Stop'
try {
  Add-Type -Path $env:PI_CLONE_SUPERVISOR_SOURCE
  $command = [IO.File]::ReadAllText($env:PI_CLONE_BASH_COMMAND_PATH)
  $code = [PiCloneWindowsJobSupervisor]::Run(
    $env:PI_CLONE_BASH_SHELL,
    $command,
    $env:PI_CLONE_BASH_CWD,
    $env:PI_CLONE_BASH_ENVIRONMENT,
    $env:PI_CLONE_BASH_STATUS,
    $env:PI_CLONE_BASH_STDOUT_PIPE,
    $env:PI_CLONE_BASH_STDERR_PIPE)
  exit $code
} catch {
  [IO.File]::WriteAllText($env:PI_CLONE_BASH_ERROR, $_.Exception.ToString())
  exit 1
}
`;

const SUPERVISOR_SOURCE = String.raw`
using System;
using System.ComponentModel;
using System.Globalization;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;

public static class PiCloneWindowsJobSupervisor
{
    private const uint CREATE_SUSPENDED = 0x00000004;
    private const uint CREATE_UNICODE_ENVIRONMENT = 0x00000400;
    private const uint CREATE_NO_WINDOW = 0x08000000;
    private const uint STARTF_USESTDHANDLES = 0x00000100;
    private const uint JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x00002000;
    private const uint GENERIC_READ = 0x80000000;
    private const uint GENERIC_WRITE = 0x40000000;
    private const uint OPEN_EXISTING = 3;
    private const uint FILE_ATTRIBUTE_NORMAL = 0x00000080;
    private const uint INFINITE = 0xffffffff;

    [StructLayout(LayoutKind.Sequential)]
    private struct SECURITY_ATTRIBUTES
    {
        public int nLength;
        public IntPtr lpSecurityDescriptor;
        [MarshalAs(UnmanagedType.Bool)]
        public bool bInheritHandle;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct STARTUPINFO
    {
        public uint cb;
        public IntPtr lpReserved;
        public IntPtr lpDesktop;
        public IntPtr lpTitle;
        public uint dwX;
        public uint dwY;
        public uint dwXSize;
        public uint dwYSize;
        public uint dwXCountChars;
        public uint dwYCountChars;
        public uint dwFillAttribute;
        public uint dwFlags;
        public ushort wShowWindow;
        public ushort cbReserved2;
        public IntPtr lpReserved2;
        public IntPtr hStdInput;
        public IntPtr hStdOutput;
        public IntPtr hStdError;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct PROCESS_INFORMATION
    {
        public IntPtr hProcess;
        public IntPtr hThread;
        public uint dwProcessId;
        public uint dwThreadId;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct JOBOBJECT_BASIC_LIMIT_INFORMATION
    {
        public long PerProcessUserTimeLimit;
        public long PerJobUserTimeLimit;
        public uint LimitFlags;
        public UIntPtr MinimumWorkingSetSize;
        public UIntPtr MaximumWorkingSetSize;
        public uint ActiveProcessLimit;
        public UIntPtr Affinity;
        public uint PriorityClass;
        public uint SchedulingClass;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct IO_COUNTERS
    {
        public ulong ReadOperationCount;
        public ulong WriteOperationCount;
        public ulong OtherOperationCount;
        public ulong ReadTransferCount;
        public ulong WriteTransferCount;
        public ulong OtherTransferCount;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION
    {
        public JOBOBJECT_BASIC_LIMIT_INFORMATION BasicLimitInformation;
        public IO_COUNTERS IoInfo;
        public UIntPtr ProcessMemoryLimit;
        public UIntPtr JobMemoryLimit;
        public UIntPtr PeakProcessMemoryUsed;
        public UIntPtr PeakJobMemoryUsed;
    }

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern IntPtr CreateJobObject(IntPtr attributes, string name);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool SetInformationJobObject(
        IntPtr job,
        int informationClass,
        IntPtr information,
        uint informationLength);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool CreateProcess(
        string applicationName,
        StringBuilder commandLine,
        IntPtr processAttributes,
        IntPtr threadAttributes,
        bool inheritHandles,
        uint creationFlags,
        IntPtr environment,
        string currentDirectory,
        ref STARTUPINFO startupInfo,
        out PROCESS_INFORMATION processInformation);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern uint ResumeThread(IntPtr thread);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool GetExitCodeProcess(IntPtr process, out uint exitCode);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool TerminateProcess(IntPtr process, uint exitCode);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool CloseHandle(IntPtr handle);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern IntPtr CreateFile(
        string fileName,
        uint desiredAccess,
        uint shareMode,
        ref SECURITY_ATTRIBUTES securityAttributes,
        uint creationDisposition,
        uint flagsAndAttributes,
        IntPtr templateFile);

    private static void ThrowLastError(string operation)
    {
        throw new Win32Exception(Marshal.GetLastWin32Error(), operation);
    }

    private static IntPtr OpenInheritedHandle(string path, uint access)
    {
        SECURITY_ATTRIBUTES security = new SECURITY_ATTRIBUTES();
        security.nLength = Marshal.SizeOf(security);
        security.bInheritHandle = true;
        IntPtr handle = CreateFile(
            path,
            access,
            0,
            ref security,
            OPEN_EXISTING,
            FILE_ATTRIBUTE_NORMAL,
            IntPtr.Zero);
        if (handle == new IntPtr(-1))
        {
            ThrowLastError("CreateFile " + path);
        }
        return handle;
    }

    private static string QuoteArgument(string value)
    {
        if (value.Length > 0 && value.IndexOfAny(new[] { ' ', '\t', '\n', '\v', '"' }) < 0)
        {
            return value;
        }

        StringBuilder result = new StringBuilder();
        result.Append('"');
        int backslashes = 0;
        foreach (char character in value)
        {
            if (character == '\\')
            {
                backslashes += 1;
            }
            else if (character == '"')
            {
                result.Append('\\', backslashes * 2 + 1);
                result.Append('"');
                backslashes = 0;
            }
            else
            {
                result.Append('\\', backslashes);
                result.Append(character);
                backslashes = 0;
            }
        }
        result.Append('\\', backslashes * 2);
        result.Append('"');
        return result.ToString();
    }

    private static IntPtr CreateKillOnCloseJob()
    {
        IntPtr job = CreateJobObject(IntPtr.Zero, null);
        if (job == IntPtr.Zero)
        {
            ThrowLastError("CreateJobObject");
        }

        JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits = new JOBOBJECT_EXTENDED_LIMIT_INFORMATION();
        limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        int size = Marshal.SizeOf(limits);
        IntPtr buffer = Marshal.AllocHGlobal(size);
        try
        {
            Marshal.StructureToPtr(limits, buffer, false);
            if (!SetInformationJobObject(job, 9, buffer, (uint)size))
            {
                ThrowLastError("SetInformationJobObject");
            }
        }
        finally
        {
            Marshal.FreeHGlobal(buffer);
        }
        return job;
    }

    public static int Run(
        string shellPath,
        string command,
        string workingDirectory,
        string environmentPath,
        string statusPath,
        string stdoutPipe,
        string stderrPipe)
    {
        IntPtr job = IntPtr.Zero;
        IntPtr process = IntPtr.Zero;
        IntPtr thread = IntPtr.Zero;
        IntPtr childInput = IntPtr.Zero;
        IntPtr childOutput = IntPtr.Zero;
        IntPtr childError = IntPtr.Zero;
        IntPtr environment = IntPtr.Zero;
        try
        {
            job = CreateKillOnCloseJob();
            childInput = OpenInheritedHandle("NUL", GENERIC_READ);
            childOutput = OpenInheritedHandle(stdoutPipe, GENERIC_WRITE);
            childError = OpenInheritedHandle(stderrPipe, GENERIC_WRITE);

            STARTUPINFO startup = new STARTUPINFO();
            startup.cb = (uint)Marshal.SizeOf(startup);
            startup.dwFlags = STARTF_USESTDHANDLES;
            startup.hStdInput = childInput;
            startup.hStdOutput = childOutput;
            startup.hStdError = childError;
            PROCESS_INFORMATION created;
            StringBuilder commandLine = new StringBuilder(
                QuoteArgument(shellPath) + " -lc " + QuoteArgument(command));
            byte[] environmentBytes = File.ReadAllBytes(environmentPath);
            environment = Marshal.AllocHGlobal(environmentBytes.Length);
            Marshal.Copy(environmentBytes, 0, environment, environmentBytes.Length);

            if (!CreateProcess(
                shellPath,
                commandLine,
                IntPtr.Zero,
                IntPtr.Zero,
                true,
                CREATE_SUSPENDED | CREATE_NO_WINDOW | CREATE_UNICODE_ENVIRONMENT,
                environment,
                workingDirectory,
                ref startup,
                out created))
            {
                ThrowLastError("CreateProcess");
            }
            process = created.hProcess;
            thread = created.hThread;

            if (!AssignProcessToJobObject(job, process))
            {
                TerminateProcess(process, 1);
                ThrowLastError("AssignProcessToJobObject");
            }
            if (ResumeThread(thread) == 0xffffffff)
            {
                TerminateProcess(process, 1);
                ThrowLastError("ResumeThread");
            }

            CloseHandle(thread);
            thread = IntPtr.Zero;
            CloseHandle(childInput);
            childInput = IntPtr.Zero;
            CloseHandle(childOutput);
            childOutput = IntPtr.Zero;
            CloseHandle(childError);
            childError = IntPtr.Zero;

            WaitForSingleObject(process, INFINITE);
            uint exitCode;
            if (!GetExitCodeProcess(process, out exitCode))
            {
                ThrowLastError("GetExitCodeProcess");
            }
            File.WriteAllText(statusPath, exitCode.ToString(CultureInfo.InvariantCulture));
            WaitForSingleObject(job, INFINITE);
            return unchecked((int)exitCode);
        }
        finally
        {
            if (thread != IntPtr.Zero) CloseHandle(thread);
            if (process != IntPtr.Zero) CloseHandle(process);
            if (childInput != IntPtr.Zero) CloseHandle(childInput);
            if (childOutput != IntPtr.Zero) CloseHandle(childOutput);
            if (childError != IntPtr.Zero) CloseHandle(childError);
            if (environment != IntPtr.Zero) Marshal.FreeHGlobal(environment);
            if (job != IntPtr.Zero) CloseHandle(job);
        }
    }
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

async function createPausedPipe(name: string): Promise<PausedPipe> {
  let resolveConnection: (socket: Socket) => void = () => undefined;
  let rejectConnection: (error: Error) => void = () => undefined;
  const connection = new Promise<Socket>((resolve, reject) => {
    resolveConnection = resolve;
    rejectConnection = reject;
  });
  const pipe: PausedPipe = {
    server: createServer({ pauseOnConnect: true }),
    connection,
  };

  pipe.server.once("connection", (socket) => {
    pipe.socket = socket;
    pipe.server.close();
    resolveConnection(socket);
  });
  pipe.server.once("error", rejectConnection);

  await new Promise<void>((resolve, reject) => {
    pipe.server.listen(name, resolve);
    pipe.server.once("error", reject);
  });

  return pipe;
}

async function closePipe(pipe: PausedPipe): Promise<void> {
  pipe.socket?.destroy();

  if (!pipe.server.listening) {
    return;
  }

  await new Promise<void>((resolve) => pipe.server.close(() => resolve()));
}

async function readSupervisorError(path: string): Promise<string> {
  try {
    return (await readFile(path, "utf8")).trim();
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return "Windows Bash supervisor exited before opening output pipes.";
    }

    throw error;
  }
}

function waitForRootExit(
  statusPath: string,
  errorPath: string,
  close: Promise<SupervisorTerminal>,
): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const finish = (action: () => void): void => {
      if (settled) {
        return;
      }

      settled = true;
      if (timer !== undefined) {
        clearTimeout(timer);
      }
      action();
    };

    const poll = async (): Promise<void> => {
      if (settled) {
        return;
      }

      try {
        const raw = await readFile(statusPath, "utf8");
        const exitCode = Number.parseInt(raw.trim(), 10);

        if (!Number.isInteger(exitCode)) {
          finish(() =>
            reject(new Error(`Invalid Windows Bash exit status: ${raw}`)),
          );
          return;
        }

        finish(() => resolve(exitCode));
      } catch (error: unknown) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
          finish(() => reject(error));
          return;
        }

        if (!settled) {
          timer = setTimeout(() => void poll(), 25);
          timer.unref();
        }
      }
    };

    close.then(
      async () => {
        if (settled) {
          return;
        }

        try {
          const raw = await readFile(statusPath, "utf8");
          const exitCode = Number.parseInt(raw.trim(), 10);
          if (Number.isInteger(exitCode)) {
            finish(() => resolve(exitCode));
            return;
          }
        } catch (error: unknown) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
            finish(() => reject(error));
            return;
          }
        }

        const message = await readSupervisorError(errorPath);
        finish(() => reject(new Error(message)));
      },
      (error: unknown) => finish(() => reject(error)),
    );

    void poll();
  });
}

export async function spawnWindowsBashSupervisor(options: {
  readonly shellPath: string;
  readonly command: string;
  readonly cwd: string;
}): Promise<WindowsBashSupervisor> {
  const id = randomUUID();
  const supervisorDir = await mkdtemp(
    join(tmpdir(), "pi-clone-bash-supervisor-"),
  );
  const sourcePath = join(supervisorDir, "supervisor.cs");
  const commandPath = join(supervisorDir, "command.txt");
  const environmentPath = join(supervisorDir, "environment.bin");
  const statusPath = join(supervisorDir, "exit-code.txt");
  const errorPath = join(supervisorDir, "error.txt");
  const stdoutName = `\\\\.\\pipe\\pi-clone-bash-${id}-stdout`;
  const stderrName = `\\\\.\\pipe\\pi-clone-bash-${id}-stderr`;
  let stdoutPipe: PausedPipe | undefined;
  let stderrPipe: PausedPipe | undefined;

  try {
    await Promise.all([
      writeFile(sourcePath, SUPERVISOR_SOURCE, "utf8"),
      writeFile(commandPath, options.command, "utf8"),
      writeFile(
        environmentPath,
        createWindowsEnvironmentBlock(process.env),
      ),
    ]);
    stdoutPipe = await createPausedPipe(stdoutName);
    stderrPipe = await createPausedPipe(stderrName);

    const child = spawn(
      powershellPath(),
      [
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-Command",
        POWERSHELL_SUPERVISOR,
      ],
      {
        cwd: process.env["SystemRoot"] ?? "C:\\Windows",
        env: {
          ...process.env,
          PI_CLONE_BASH_COMMAND_PATH: commandPath,
          PI_CLONE_BASH_CWD: options.cwd,
          PI_CLONE_BASH_ENVIRONMENT: environmentPath,
          PI_CLONE_BASH_ERROR: errorPath,
          PI_CLONE_BASH_SHELL: options.shellPath,
          PI_CLONE_BASH_STATUS: statusPath,
          PI_CLONE_BASH_STDERR_PIPE: stderrName,
          PI_CLONE_BASH_STDOUT_PIPE: stdoutName,
          PI_CLONE_SUPERVISOR_SOURCE: sourcePath,
        },
        stdio: "ignore",
        windowsHide: true,
      },
    );

    const close = new Promise<SupervisorTerminal>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (exitCode, signal) =>
        resolve({ exitCode, signal }),
      );
    });
    const stdoutConnection = stdoutPipe.connection;
    const stderrConnection = stderrPipe.connection;
    const output = Promise.race([
      Promise.all([stdoutConnection, stderrConnection]).then(
        ([stdout, stderr]) => ({ stdout, stderr }),
      ),
      close.then(async () => {
        throw new Error(await readSupervisorError(errorPath));
      }),
    ]);
    const rootExit = waitForRootExit(statusPath, errorPath, close);

    return {
      child,
      output,
      rootExit,
      close,
      async dispose(detach: boolean): Promise<void> {
        await Promise.all([
          closePipe(stdoutPipe!),
          closePipe(stderrPipe!),
        ]);
        if (detach) {
          child.unref();
        }
        await rm(supervisorDir, { recursive: true, force: true });
      },
    };
  } catch (error: unknown) {
    await Promise.all([
      stdoutPipe === undefined ? Promise.resolve() : closePipe(stdoutPipe),
      stderrPipe === undefined ? Promise.resolve() : closePipe(stderrPipe),
    ]);
    await rm(supervisorDir, { recursive: true, force: true });
    throw error;
  }
}
