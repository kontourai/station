import { execSync } from 'node:child_process';

interface TerminalSubprocessEntry {
  pid: number | null;
  hasRunningSubprocess: boolean;
  status: string;
}

interface PollTerminalSubprocessActivityInput {
  sessionId: string;
  entry: TerminalSubprocessEntry;
  emit: (event: {
    type: 'activity';
    sessionId: string;
    hasRunningSubprocess: boolean;
  }) => void;
  debug?: (...args: unknown[]) => void;
}

function detectWindowsSubprocesses(pid: number): boolean {
  const psResult = execSync(
    `powershell -NoProfile -Command "Get-Process -Id ${pid} -ErrorAction SilentlyContinue"`,
    { stdio: 'pipe', windowsHide: true },
  );
  return psResult.toString().trim().length > 0;
}

function detectUnixSubprocesses(pid: number): boolean {
  execSync(`pgrep -P ${pid}`, { stdio: 'ignore', windowsHide: true });
  return true;
}

export function pollTerminalSubprocessActivity({
  sessionId,
  entry,
  emit,
  debug = console.debug,
}: PollTerminalSubprocessActivityInput): void {
  if (entry.status !== 'running' || entry.pid == null) return;

  try {
    const hasChildProcess =
      process.platform === 'win32'
        ? detectWindowsSubprocesses(entry.pid)
        : detectUnixSubprocesses(entry.pid);

    if (!entry.hasRunningSubprocess && hasChildProcess) {
      entry.hasRunningSubprocess = true;
      emit({
        type: 'activity',
        sessionId,
        hasRunningSubprocess: true,
      });
    }
  } catch (error) {
    debug(
      'Failed to poll subprocesses for terminal session:',
      sessionId,
      error,
    );
    if (entry.hasRunningSubprocess) {
      entry.hasRunningSubprocess = false;
      emit({
        type: 'activity',
        sessionId,
        hasRunningSubprocess: false,
      });
    }
  }
}
