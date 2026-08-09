// Runtime-compiled from this reviewed source; no precompiled helper is shipped.
using System;
using System.ComponentModel;
using System.Globalization;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

public static class PiCloneWindowsJobSupervisor
{
    private const uint CREATE_SUSPENDED = 0x00000004;
    private const uint CREATE_UNICODE_ENVIRONMENT = 0x00000400;
    private const uint EXTENDED_STARTUPINFO_PRESENT = 0x00080000;
    private const uint CREATE_NO_WINDOW = 0x08000000;
    private const uint STARTF_USESTDHANDLES = 0x00000100;
    private const uint HANDLE_FLAG_INHERIT = 0x00000001;
    private const uint JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x00002000;
    private const uint GENERIC_READ = 0x80000000;
    private const uint OPEN_EXISTING = 3;
    private const uint FILE_ATTRIBUTE_NORMAL = 0x00000080;
    private const uint WAIT_OBJECT_0 = 0x00000000;
    private const uint INFINITE = 0xffffffff;
    private const int ERROR_BROKEN_PIPE = 109;
    private const int STD_OUTPUT_HANDLE = -11;
    private const int STD_ERROR_HANDLE = -12;

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
    private struct STARTUPINFOEX
    {
        public STARTUPINFO StartupInfo;
        public IntPtr lpAttributeList;
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

    [StructLayout(LayoutKind.Sequential)]
    private struct JOBOBJECT_BASIC_ACCOUNTING_INFORMATION
    {
        public long TotalUserTime;
        public long TotalKernelTime;
        public long ThisPeriodTotalUserTime;
        public long ThisPeriodTotalKernelTime;
        public uint TotalPageFaultCount;
        public uint TotalProcesses;
        public uint ActiveProcesses;
        public uint TotalTerminatedProcesses;
    }

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern IntPtr CreateJobObject(IntPtr attributes, string name);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool SetInformationJobObject(
        IntPtr job,
        int informationClass,
        IntPtr information,
        uint informationLength);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool QueryInformationJobObject(
        IntPtr job,
        int informationClass,
        out JOBOBJECT_BASIC_ACCOUNTING_INFORMATION information,
        uint informationLength,
        IntPtr returnLength);

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
        ref STARTUPINFOEX startupInfo,
        out PROCESS_INFORMATION processInformation);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool InitializeProcThreadAttributeList(
        IntPtr attributeList,
        int attributeCount,
        int flags,
        ref IntPtr size);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool UpdateProcThreadAttribute(
        IntPtr attributeList,
        uint flags,
        IntPtr attribute,
        IntPtr value,
        IntPtr size,
        IntPtr previousValue,
        IntPtr returnSize);

    [DllImport("kernel32.dll")]
    private static extern void DeleteProcThreadAttributeList(
        IntPtr attributeList);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool AssignProcessToJobObject(
        IntPtr job,
        IntPtr process);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern uint ResumeThread(IntPtr thread);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern uint WaitForSingleObject(
        IntPtr handle,
        uint milliseconds);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool GetExitCodeProcess(
        IntPtr process,
        out uint exitCode);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool TerminateProcess(
        IntPtr process,
        uint exitCode);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool CloseHandle(IntPtr handle);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr GetStdHandle(int standardHandle);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool SetHandleInformation(
        IntPtr handle,
        uint mask,
        uint flags);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool WriteFile(
        IntPtr file,
        byte[] buffer,
        uint bytesToWrite,
        out uint bytesWritten,
        IntPtr overlapped);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool ReadFile(
        IntPtr file,
        byte[] buffer,
        uint bytesToRead,
        out uint bytesRead,
        IntPtr overlapped);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool CreatePipe(
        out IntPtr readPipe,
        out IntPtr writePipe,
        ref SECURITY_ATTRIBUTES pipeAttributes,
        uint size);

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

    private static void RequireHandle(IntPtr handle, string operation)
    {
        if (handle == IntPtr.Zero || handle == new IntPtr(-1))
        {
            ThrowLastError(operation);
        }
    }

    private static bool IsValidHandle(IntPtr handle)
    {
        return handle != IntPtr.Zero && handle != new IntPtr(-1);
    }

    private static IntPtr OpenInheritedNullInput()
    {
        SECURITY_ATTRIBUTES security = new SECURITY_ATTRIBUTES();
        security.nLength = Marshal.SizeOf(security);
        security.bInheritHandle = true;
        IntPtr handle = CreateFile(
            "NUL",
            GENERIC_READ,
            0,
            ref security,
            OPEN_EXISTING,
            FILE_ATTRIBUTE_NORMAL,
            IntPtr.Zero);
        RequireHandle(handle, "CreateFile NUL");
        return handle;
    }

    private static void CreateChildOutputPipe(
        out IntPtr readPipe,
        out IntPtr writePipe)
    {
        SECURITY_ATTRIBUTES security = new SECURITY_ATTRIBUTES();
        security.nLength = Marshal.SizeOf(security);
        security.bInheritHandle = true;

        if (!CreatePipe(out readPipe, out writePipe, ref security, 0))
        {
            ThrowLastError("CreatePipe");
        }

        if (!SetHandleInformation(readPipe, HANDLE_FLAG_INHERIT, 0))
        {
            CloseHandle(readPipe);
            CloseHandle(writePipe);
            readPipe = IntPtr.Zero;
            writePipe = IntPtr.Zero;
            ThrowLastError("SetHandleInformation pipe read");
        }
    }

    private static string QuoteArgument(string value)
    {
        if (value.Length > 0 && value.IndexOfAny(
            new[] { ' ', '\t', '\n', '\v', '"' }) < 0)
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
        RequireHandle(job, "CreateJobObject");

        JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits =
            new JOBOBJECT_EXTENDED_LIMIT_INFORMATION();
        limits.BasicLimitInformation.LimitFlags =
            JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
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
        catch
        {
            CloseHandle(job);
            throw;
        }
        finally
        {
            Marshal.FreeHGlobal(buffer);
        }
        return job;
    }

    private static void WaitForJobEmpty(IntPtr job)
    {
        int size = Marshal.SizeOf(
            typeof(JOBOBJECT_BASIC_ACCOUNTING_INFORMATION));

        while (true)
        {
            JOBOBJECT_BASIC_ACCOUNTING_INFORMATION information;
            if (!QueryInformationJobObject(
                job,
                1,
                out information,
                (uint)size,
                IntPtr.Zero))
            {
                ThrowLastError("QueryInformationJobObject");
            }
            if (information.ActiveProcesses == 0)
            {
                return;
            }
            Thread.Sleep(25);
        }
    }

    private static byte[] DecodeEnvironment(string base64Environment)
    {
        byte[] bytes = Convert.FromBase64String(base64Environment);
        if (
            bytes.Length < 4 ||
            bytes.Length % 2 != 0 ||
            bytes[bytes.Length - 1] != 0 ||
            bytes[bytes.Length - 2] != 0 ||
            bytes[bytes.Length - 3] != 0 ||
            bytes[bytes.Length - 4] != 0)
        {
            Array.Clear(bytes, 0, bytes.Length);
            throw new ArgumentException("Invalid environment block.");
        }
        return bytes;
    }

    private static void ValidateCapability(string capability)
    {
        if (capability == null || capability.Length != 64)
        {
            throw new ArgumentException("Invalid control capability.");
        }
        foreach (char character in capability)
        {
            bool isHex =
                (character >= '0' && character <= '9') ||
                (character >= 'a' && character <= 'f');
            if (!isHex)
            {
                throw new ArgumentException("Invalid control capability.");
            }
        }
    }

    private static void WriteAll(
        IntPtr destination,
        byte[] bytes,
        int count,
        string operation)
    {
        int offset = 0;

        while (offset < count)
        {
            byte[] pending;

            if (offset == 0 && count == bytes.Length)
            {
                pending = bytes;
            }
            else
            {
                pending = new byte[count - offset];
                Buffer.BlockCopy(bytes, offset, pending, 0, pending.Length);
            }

            uint written;
            if (!WriteFile(
                destination,
                pending,
                (uint)pending.Length,
                out written,
                IntPtr.Zero) || written == 0)
            {
                if (!Object.ReferenceEquals(pending, bytes))
                {
                    Array.Clear(pending, 0, pending.Length);
                }
                ThrowLastError(operation);
            }

            offset += (int)written;

            if (!Object.ReferenceEquals(pending, bytes))
            {
                Array.Clear(pending, 0, pending.Length);
            }
        }
    }

    private static void PublishControl(
        IntPtr controlHandle,
        string capability,
        string payload)
    {
        ValidateCapability(capability);

        byte[] frame = Encoding.ASCII.GetBytes(
            "\u001ePI_CLONE_CONTROL_V1:" +
            capability +
            ":" +
            payload +
            "\u001f");
        try
        {
            WriteAll(
                controlHandle,
                frame,
                frame.Length,
                "WriteFile control frame");
        }
        finally
        {
            Array.Clear(frame, 0, frame.Length);
        }
    }

    private sealed class RelayState
    {
        private readonly IntPtr source;
        private readonly IntPtr destination;

        public Exception Error;

        public RelayState(IntPtr source, IntPtr destination)
        {
            this.source = source;
            this.destination = destination;
        }

        public void Run()
        {
            byte[] buffer = new byte[8192];

            try
            {
                while (true)
                {
                    uint bytesRead;
                    bool succeeded = ReadFile(
                        source,
                        buffer,
                        (uint)buffer.Length,
                        out bytesRead,
                        IntPtr.Zero);

                    if (!succeeded)
                    {
                        int error = Marshal.GetLastWin32Error();
                        if (error == ERROR_BROKEN_PIPE)
                        {
                            break;
                        }
                        throw new Win32Exception(error, "ReadFile child output");
                    }

                    if (bytesRead == 0)
                    {
                        break;
                    }

                    WriteAll(
                        destination,
                        buffer,
                        (int)bytesRead,
                        "WriteFile relayed output");
                }
            }
            catch (Exception error)
            {
                Error = error;
            }
            finally
            {
                Array.Clear(buffer, 0, buffer.Length);
            }
        }
    }

    private static IntPtr CreateHandleList(
        IntPtr standardInput,
        IntPtr standardOutput,
        IntPtr standardError,
        out IntPtr handleArray)
    {
        IntPtr attributeSize = IntPtr.Zero;
        InitializeProcThreadAttributeList(
            IntPtr.Zero,
            1,
            0,
            ref attributeSize);
        IntPtr attributeList = Marshal.AllocHGlobal(attributeSize);
        handleArray = IntPtr.Zero;

        try
        {
            if (!InitializeProcThreadAttributeList(
                attributeList,
                1,
                0,
                ref attributeSize))
            {
                ThrowLastError("InitializeProcThreadAttributeList");
            }

            handleArray = Marshal.AllocHGlobal(IntPtr.Size * 3);
            Marshal.WriteIntPtr(handleArray, 0, standardInput);
            Marshal.WriteIntPtr(handleArray, IntPtr.Size, standardOutput);
            Marshal.WriteIntPtr(handleArray, IntPtr.Size * 2, standardError);

            if (!UpdateProcThreadAttribute(
                attributeList,
                0,
                new IntPtr(0x00020002),
                handleArray,
                new IntPtr(IntPtr.Size * 3),
                IntPtr.Zero,
                IntPtr.Zero))
            {
                ThrowLastError("UpdateProcThreadAttribute");
            }

            return attributeList;
        }
        catch
        {
            if (handleArray != IntPtr.Zero)
            {
                Marshal.FreeHGlobal(handleArray);
                handleArray = IntPtr.Zero;
            }
            DeleteProcThreadAttributeList(attributeList);
            Marshal.FreeHGlobal(attributeList);
            throw;
        }
    }

    public static int Run(
        string shellPath,
        string command,
        string workingDirectory,
        string base64Environment,
        string controlCapability)
    {
        IntPtr job = IntPtr.Zero;
        IntPtr process = IntPtr.Zero;
        IntPtr thread = IntPtr.Zero;
        IntPtr childInput = IntPtr.Zero;
        IntPtr environment = IntPtr.Zero;
        IntPtr attributeList = IntPtr.Zero;
        IntPtr handleArray = IntPtr.Zero;
        byte[] environmentBytes = null;
        IntPtr childOutput = IntPtr.Zero;
        IntPtr childError = IntPtr.Zero;
        IntPtr childOutputRead = IntPtr.Zero;
        IntPtr childErrorRead = IntPtr.Zero;
        IntPtr parentOutput = IntPtr.Zero;
        IntPtr parentError = IntPtr.Zero;
        Thread stdoutRelayThread = null;
        Thread stderrRelayThread = null;

        try
        {
            job = CreateKillOnCloseJob();
            childInput = OpenInheritedNullInput();
            CreateChildOutputPipe(out childOutputRead, out childOutput);
            CreateChildOutputPipe(out childErrorRead, out childError);
            parentOutput = GetStdHandle(STD_OUTPUT_HANDLE);
            parentError = GetStdHandle(STD_ERROR_HANDLE);
            RequireHandle(parentOutput, "GetStdHandle stdout");
            RequireHandle(parentError, "GetStdHandle stderr");

            attributeList = CreateHandleList(
                childInput,
                childOutput,
                childError,
                out handleArray);

            STARTUPINFOEX startup = new STARTUPINFOEX();
            startup.StartupInfo.cb = (uint)Marshal.SizeOf(startup);
            startup.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
            startup.StartupInfo.hStdInput = childInput;
            startup.StartupInfo.hStdOutput = childOutput;
            startup.StartupInfo.hStdError = childError;
            startup.lpAttributeList = attributeList;

            PROCESS_INFORMATION created;
            StringBuilder commandLine = new StringBuilder(
                QuoteArgument(shellPath) + " -lc " + QuoteArgument(command));
            environmentBytes = DecodeEnvironment(base64Environment);
            environment = Marshal.AllocHGlobal(environmentBytes.Length);
            Marshal.Copy(
                environmentBytes,
                0,
                environment,
                environmentBytes.Length);

            if (!CreateProcess(
                shellPath,
                commandLine,
                IntPtr.Zero,
                IntPtr.Zero,
                true,
                CREATE_SUSPENDED |
                    CREATE_NO_WINDOW |
                    CREATE_UNICODE_ENVIRONMENT |
                    EXTENDED_STARTUPINFO_PRESENT,
                environment,
                workingDirectory,
                ref startup,
                out created))
            {
                ThrowLastError("CreateProcess");
            }
            process = created.hProcess;
            thread = created.hThread;
            CloseHandle(childOutput);
            childOutput = IntPtr.Zero;
            CloseHandle(childError);
            childError = IntPtr.Zero;

            RelayState stdoutRelay = new RelayState(
                childOutputRead,
                parentOutput);
            RelayState stderrRelay = new RelayState(
                childErrorRead,
                parentError);
            stdoutRelayThread = new Thread(stdoutRelay.Run);
            stderrRelayThread = new Thread(stderrRelay.Run);
            stdoutRelayThread.IsBackground = true;
            stderrRelayThread.IsBackground = true;
            stdoutRelayThread.Start();
            stderrRelayThread.Start();

            if (!AssignProcessToJobObject(job, process))
            {
                int assignmentError = Marshal.GetLastWin32Error();
                if (!TerminateProcess(process, 1))
                {
                    ThrowLastError(
                        "TerminateProcess after AssignProcessToJobObject failure");
                }
                if (WaitForSingleObject(process, INFINITE) != WAIT_OBJECT_0)
                {
                    ThrowLastError(
                        "WaitForSingleObject after AssignProcessToJobObject failure");
                }
                throw new Win32Exception(
                    assignmentError,
                    "AssignProcessToJobObject");
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

            WaitForSingleObject(process, INFINITE);
            uint exitCode;
            if (!GetExitCodeProcess(process, out exitCode))
            {
                ThrowLastError("GetExitCodeProcess");
            }
            PublishControl(
                parentError,
                controlCapability,
                "root:" + exitCode.ToString(CultureInfo.InvariantCulture));
            stdoutRelayThread.Join();
            stderrRelayThread.Join();
            if (stdoutRelay.Error != null)
            {
                throw stdoutRelay.Error;
            }
            if (stderrRelay.Error != null)
            {
                throw stderrRelay.Error;
            }
            PublishControl(parentOutput, controlCapability, "stdout-end");
            PublishControl(parentError, controlCapability, "stderr-end");
            WaitForJobEmpty(job);
            return unchecked((int)exitCode);
        }
        finally
        {
            if (thread != IntPtr.Zero) CloseHandle(thread);
            if (process != IntPtr.Zero) CloseHandle(process);
            if (childInput != IntPtr.Zero) CloseHandle(childInput);
            if (childOutput != IntPtr.Zero) CloseHandle(childOutput);
            if (childError != IntPtr.Zero) CloseHandle(childError);
            if (childOutputRead != IntPtr.Zero) CloseHandle(childOutputRead);
            if (childErrorRead != IntPtr.Zero) CloseHandle(childErrorRead);
            if (environment != IntPtr.Zero && environmentBytes != null)
            {
                for (int index = 0; index < environmentBytes.Length; index++)
                {
                    Marshal.WriteByte(environment, index, 0);
                }
                Marshal.FreeHGlobal(environment);
            }
            if (environmentBytes != null)
            {
                Array.Clear(environmentBytes, 0, environmentBytes.Length);
            }
            if (handleArray != IntPtr.Zero) Marshal.FreeHGlobal(handleArray);
            if (attributeList != IntPtr.Zero)
            {
                DeleteProcThreadAttributeList(attributeList);
                Marshal.FreeHGlobal(attributeList);
            }
            if (job != IntPtr.Zero) CloseHandle(job);
        }
    }
}
