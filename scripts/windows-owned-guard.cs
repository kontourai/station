using System;
using System.Globalization;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

class StationWindowsOwnedGuard {
  const uint CREATE_SUSPENDED = 0x00000004;
  const uint SYNCHRONIZE = 0x00100000;
  const uint PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;
  const uint INFINITE = 0xffffffff;
  const uint WAIT_TIMEOUT = 0x00000102;
  const uint WAIT_OBJECT_0 = 0;
  const int STARTF_USESTDHANDLES = 0x00000100;
  const uint EXTENDED_STARTUPINFO_PRESENT = 0x00080000;
  static readonly IntPtr PROC_THREAD_ATTRIBUTE_HANDLE_LIST = (IntPtr)0x00020002;
  const uint HANDLE_FLAG_INHERIT = 1;
  const uint GENERIC_READ = 0x80000000;
  const uint OPEN_EXISTING = 3;
  const uint JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x00002000;
  const int JobObjectExtendedLimitInformation = 9;
  const int CONTROL_DEADLINE_MS = 5000;
  const long TICKS_PER_MICROSECOND = 10;
  const int CONTROL_PENDING = 0;
  const int CONTROL_RESUME = 1;
  const int CONTROL_ABORT = 2;
  const int CONTROL_INVALID = -1;

  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] struct STARTUPINFO { public int cb; public string lpReserved; public string lpDesktop; public string lpTitle; public int dwX; public int dwY; public int dwXSize; public int dwYSize; public int dwXCountChars; public int dwYCountChars; public int dwFillAttribute; public int dwFlags; public short wShowWindow; public short cbReserved2; public IntPtr lpReserved2; public IntPtr hStdInput; public IntPtr hStdOutput; public IntPtr hStdError; }
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] struct STARTUPINFOEX { public STARTUPINFO StartupInfo; public IntPtr lpAttributeList; }
  [StructLayout(LayoutKind.Sequential)] struct SECURITY_ATTRIBUTES { public int nLength; public IntPtr lpSecurityDescriptor; public bool bInheritHandle; }
  [StructLayout(LayoutKind.Sequential)] struct PROCESS_INFORMATION { public IntPtr hProcess; public IntPtr hThread; public int dwProcessId; public int dwThreadId; }
  [StructLayout(LayoutKind.Sequential)] struct FILETIME { public uint dwLowDateTime; public uint dwHighDateTime; }
  [StructLayout(LayoutKind.Sequential)] struct JOBOBJECT_BASIC_LIMIT_INFORMATION { public long PerProcessUserTimeLimit; public long PerJobUserTimeLimit; public uint LimitFlags; public UIntPtr MinimumWorkingSetSize; public UIntPtr MaximumWorkingSetSize; public uint ActiveProcessLimit; public IntPtr Affinity; public uint PriorityClass; public uint SchedulingClass; }
  [StructLayout(LayoutKind.Sequential)] struct IO_COUNTERS { public ulong ReadOperationCount; public ulong WriteOperationCount; public ulong OtherOperationCount; public ulong ReadTransferCount; public ulong WriteTransferCount; public ulong OtherTransferCount; }
  [StructLayout(LayoutKind.Sequential)] struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION { public JOBOBJECT_BASIC_LIMIT_INFORMATION BasicLimitInformation; public IO_COUNTERS IoInfo; public UIntPtr ProcessMemoryLimit; public UIntPtr JobMemoryLimit; public UIntPtr PeakProcessMemoryUsed; public UIntPtr PeakJobMemoryUsed; }
  [DllImport("kernel32.dll", SetLastError=true, CharSet=CharSet.Unicode)] static extern bool CreateProcess(string app, string cmd, IntPtr pa, IntPtr ta, bool inherit, uint flags, IntPtr environment, string cwd, ref STARTUPINFOEX startup, out PROCESS_INFORMATION info);
  [DllImport("kernel32.dll", SetLastError=true)] static extern IntPtr CreateJobObject(IntPtr attributes, string name);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool SetInformationJobObject(IntPtr job, int infoClass, IntPtr info, uint length);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
  [DllImport("kernel32.dll", SetLastError=true)] static extern uint ResumeThread(IntPtr thread);
  [DllImport("kernel32.dll", SetLastError=true)] static extern IntPtr OpenProcess(uint access, bool inherit, int pid);
  [DllImport("kernel32.dll", SetLastError=true)] static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetProcessTimes(IntPtr process, out FILETIME creation, out FILETIME exit, out FILETIME kernel, out FILETIME user);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetExitCodeProcess(IntPtr process, out uint code);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool SetHandleInformation(IntPtr handle, uint mask, uint flags);
  [DllImport("kernel32.dll", SetLastError=true, CharSet=CharSet.Unicode)] static extern IntPtr CreateFile(string name, uint access, uint share, ref SECURITY_ATTRIBUTES attributes, uint disposition, uint flags, IntPtr template);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool InitializeProcThreadAttributeList(IntPtr list, int count, int flags, ref IntPtr size);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool UpdateProcThreadAttribute(IntPtr list, uint flags, IntPtr attribute, IntPtr value, IntPtr size, IntPtr previous, IntPtr returned);
  [DllImport("kernel32.dll")] static extern void DeleteProcThreadAttributeList(IntPtr list);
  [DllImport("msvcrt.dll")] static extern IntPtr _get_osfhandle(int fd);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool TerminateProcess(IntPtr process, uint code);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool CloseHandle(IntPtr handle);

  static string Quote(string text) {
    var quoted = new StringBuilder(); quoted.Append('"'); int backslashes = 0;
    foreach (char character in text) {
      if (character == '\\') { backslashes++; continue; }
      if (character == '"') { quoted.Append('\\', backslashes * 2 + 1); quoted.Append('"'); }
      else { quoted.Append('\\', backslashes); quoted.Append(character); }
      backslashes = 0;
    }
    quoted.Append('\\', backslashes * 2); quoted.Append('"'); return quoted.ToString();
  }
  // FILETIME uses 100ns ticks while CIM exposes microseconds. Truncate only
  // the final tick digit, then emit the canonical round-trip UTC ISO format.
  static string CreationIsoAtMicrosecondPrecision(IntPtr process) {
    FILETIME creation, exit, kernel, user;
    if (!GetProcessTimes(process, out creation, out exit, out kernel, out user)) return null;
    long fileTime = ((long)creation.dwHighDateTime << 32) | creation.dwLowDateTime;
    long ticks = DateTime.FromFileTimeUtc(fileTime).Ticks;
    DateTime normalized = new DateTime((ticks / TICKS_PER_MICROSECOND) * TICKS_PER_MICROSECOND, DateTimeKind.Utc);
    return normalized.ToString("o", CultureInfo.InvariantCulture);
  }
  static void Send(TextWriter writer, string record) { writer.WriteLine(record); writer.Flush(); }
  static int Fail(string stage) { try { Console.Error.WriteLine("station-owned-guard: " + stage); Console.Error.Flush(); } catch {} return 125; }
  static int FailWin32(string stage) { return Fail(stage + " win32=" + Marshal.GetLastWin32Error().ToString(CultureInfo.InvariantCulture)); }
  static void KillAndReap(IntPtr process) { if (process != IntPtr.Zero) { TerminateProcess(process, 125); WaitForSingleObject(process, INFINITE); } }
  static void KillAndReapOnce(IntPtr process, ref bool reaped) { if (reaped) return; reaped = true; KillAndReap(process); }
  // Every blocking control read stays off Main. State distinguishes pending,
  // expected RESUME, ABORT, and EOF/malformed/fault without async read APIs.
  sealed class OneLineControlMonitor {
    int state = CONTROL_PENDING;
    public void Start(TextReader reader) {
      var worker = new Thread(() => {
        try {
          string line = reader.ReadLine();
          int next = line == "RESUME" ? CONTROL_RESUME : line == "ABORT" ? CONTROL_ABORT : CONTROL_INVALID;
          Interlocked.Exchange(ref state, next);
        } catch { Interlocked.Exchange(ref state, CONTROL_INVALID); }
      });
      worker.IsBackground = true;
      worker.Start();
    }
    public int State { get { return Volatile.Read(ref state); } }
  }
  // Native follow-up proof: with control stdin open and no RESUME, this bounds
  // failure to CONTROL_DEADLINE_MS, reaps the suspended child, and exits.
  static bool WaitForResumeBounded(OneLineControlMonitor monitor, IntPtr parent) {
    var deadline = DateTime.UtcNow.AddMilliseconds(CONTROL_DEADLINE_MS);
    while (monitor.State == CONTROL_PENDING) {
      uint parentWait = WaitForSingleObject(parent, 50);
      int state = monitor.State;
      if (parentWait != WAIT_TIMEOUT) return false;
      // A RESUME published while the exact parent wait was pending wins over
      // the deadline check. Parent death always remains fail-closed above.
      if (state != CONTROL_PENDING) return state == CONTROL_RESUME;
      if (DateTime.UtcNow >= deadline) return false;
    }
    return monitor.State == CONTROL_RESUME;
  }

  static int Main(string[] args) {
    if (args.Length < 3) return 125;
    int parentPid; if (!Int32.TryParse(args[0], out parentPid)) return 125;
    IntPtr parent = OpenProcess(SYNCHRONIZE | PROCESS_QUERY_LIMITED_INFORMATION, false, parentPid);
    if (parent == IntPtr.Zero) return FailWin32("parent-open");
    if (CreationIsoAtMicrosecondPrecision(parent) != args[1]) { CloseHandle(parent); return Fail("parent-identity"); }
    IntPtr job = IntPtr.Zero; PROCESS_INFORMATION child = new PROCESS_INFORMATION(); bool bound = false, resumed = false, childReaped = false;
    try {
      TextReader reader = Console.In;
      TextWriter writer = Console.Out;
      // Console streams are process-owned: do not dispose them. The child can
      // complete while control stdin stays open; normal COMPLETE exits promptly
      // without waiting for the monitor's blocking ReadLine.
          job = CreateJobObject(IntPtr.Zero, null); if (job == IntPtr.Zero) return FailWin32("job-create");
          int bytes = Marshal.SizeOf(typeof(JOBOBJECT_EXTENDED_LIMIT_INFORMATION)); IntPtr limits = Marshal.AllocHGlobal(bytes);
          try { var value = new JOBOBJECT_EXTENDED_LIMIT_INFORMATION(); value.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE; Marshal.StructureToPtr(value, limits, false); if (!SetInformationJobObject(job, JobObjectExtendedLimitInformation, limits, (uint)bytes)) return FailWin32("job-config"); }
          finally { Marshal.FreeHGlobal(limits); }
          IntPtr rawOut = _get_osfhandle(3), rawErr = _get_osfhandle(4); if (rawOut == (IntPtr)(-1) || rawErr == (IntPtr)(-1)) return Fail("raw-fd");
          if (!SetHandleInformation(rawOut, HANDLE_FLAG_INHERIT, HANDLE_FLAG_INHERIT) || !SetHandleInformation(rawErr, HANDLE_FLAG_INHERIT, HANDLE_FLAG_INHERIT)) return FailWin32("raw-handle-inherit");
          var attributes = new SECURITY_ATTRIBUTES(); attributes.nLength = Marshal.SizeOf(typeof(SECURITY_ATTRIBUTES)); attributes.bInheritHandle = true;
          IntPtr nul = CreateFile("NUL", GENERIC_READ, 0, ref attributes, OPEN_EXISTING, 0, IntPtr.Zero); if (nul == (IntPtr)(-1)) return FailWin32("nul-open");
          IntPtr listSize = IntPtr.Zero; InitializeProcThreadAttributeList(IntPtr.Zero, 1, 0, ref listSize); IntPtr list = Marshal.AllocHGlobal(listSize);
          IntPtr handles = IntPtr.Zero;
          try {
            if (!InitializeProcThreadAttributeList(list, 1, 0, ref listSize)) return FailWin32("attribute-list-init");
            handles = Marshal.AllocHGlobal(IntPtr.Size * 3); Marshal.WriteIntPtr(handles, 0, nul); Marshal.WriteIntPtr(handles, IntPtr.Size, rawOut); Marshal.WriteIntPtr(handles, IntPtr.Size * 2, rawErr);
            if (!UpdateProcThreadAttribute(list, 0, PROC_THREAD_ATTRIBUTE_HANDLE_LIST, handles, (IntPtr)(IntPtr.Size * 3), IntPtr.Zero, IntPtr.Zero)) return FailWin32("attribute-list-update");
            var command = new StringBuilder(Quote(args[2])); for (int i = 3; i < args.Length; i++) command.Append(' ').Append(Quote(args[i]));
            var startup = new STARTUPINFOEX(); startup.StartupInfo.cb = Marshal.SizeOf(typeof(STARTUPINFOEX)); startup.StartupInfo.dwFlags = STARTF_USESTDHANDLES; startup.StartupInfo.hStdInput = nul; startup.StartupInfo.hStdOutput = rawOut; startup.StartupInfo.hStdError = rawErr; startup.lpAttributeList = list;
            // The whitelist excludes control stdin/stdout, parent, Job, and all process/thread handles.
            if (!CreateProcess(null, command.ToString(), IntPtr.Zero, IntPtr.Zero, true, CREATE_SUSPENDED | EXTENDED_STARTUPINFO_PRESENT, IntPtr.Zero, Environment.CurrentDirectory, ref startup, out child)) return FailWin32("create-process");
          } finally { if (handles != IntPtr.Zero) Marshal.FreeHGlobal(handles); DeleteProcThreadAttributeList(list); Marshal.FreeHGlobal(list); CloseHandle(nul); }
          if (!AssignProcessToJobObject(job, child.hProcess)) return FailWin32("assign-job");
          string childCreation = CreationIsoAtMicrosecondPrecision(child.hProcess); if (String.IsNullOrEmpty(childCreation)) return FailWin32("child-identity");
          Send(writer, "BOUND " + child.dwProcessId + " " + childCreation);
          bound = true;
          var resumeMonitor = new OneLineControlMonitor();
          try { resumeMonitor.Start(reader); }
          catch { KillAndReapOnce(child.hProcess, ref childReaped); return 125; }
          if (!WaitForResumeBounded(resumeMonitor, parent)) return 125;
          if (ResumeThread(child.hThread) == 0xffffffff) return 125;
          resumed = true;
          var abortMonitor = new OneLineControlMonitor();
          try { abortMonitor.Start(reader); }
          catch { KillAndReapOnce(child.hProcess, ref childReaped); return 125; }
          while (true) {
            if (abortMonitor.State != CONTROL_PENDING) { KillAndReapOnce(child.hProcess, ref childReaped); return 125; }
            uint childWait = WaitForSingleObject(child.hProcess, 50);
            if (childWait == WAIT_TIMEOUT) { if (WaitForSingleObject(parent, 0) != WAIT_TIMEOUT) { KillAndReapOnce(child.hProcess, ref childReaped); return 126; } continue; }
            if (abortMonitor.State != CONTROL_PENDING) { KillAndReapOnce(child.hProcess, ref childReaped); return 125; }
            if (childWait != WAIT_OBJECT_0 || WaitForSingleObject(parent, 0) != WAIT_TIMEOUT) { KillAndReapOnce(child.hProcess, ref childReaped); return 126; }
            uint exitCode; if (!GetExitCodeProcess(child.hProcess, out exitCode)) return 125;
            Send(writer, "COMPLETE " + exitCode.ToString(CultureInfo.InvariantCulture));
            // COMPLETE carries the target result; a successful guard protocol
            // exits zero so the launcher can distinguish it from guard failure.
            return 0;
          }
    } catch { if (!bound) Fail("pre-bind-exception"); KillAndReapOnce(child.hProcess, ref childReaped); return 125; }
    finally {
      if (!resumed) KillAndReapOnce(child.hProcess, ref childReaped);
      if (child.hThread != IntPtr.Zero) CloseHandle(child.hThread);
      if (child.hProcess != IntPtr.Zero) CloseHandle(child.hProcess);
      if (job != IntPtr.Zero) CloseHandle(job);
      CloseHandle(parent);
    }
  }
}
