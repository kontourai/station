import { execFile, execSync } from 'node:child_process';

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

function detectUnixSubprocesses(pid: number): Promise<boolean> {
  return new Promise((resolve, reject) => {
    execFile(
      'pgrep',
      ['-P', String(pid)],
      { timeout: 2000, windowsHide: true },
      (error) => {
        if (error?.code === 1 && !error.killed) resolve(false);
        else if (error) reject(error);
        else resolve(true);
      },
    );
  });
}

export async function pollTerminalSubprocessActivity({
  sessionId,
  entry,
  emit,
  debug = console.debug,
}: PollTerminalSubprocessActivityInput): Promise<void> {
  if (entry.status !== 'running' || entry.pid == null) return;
  const pid = entry.pid;

  try {
    const hasChildProcess =
      process.platform === 'win32'
        ? detectWindowsSubprocesses(entry.pid)
        : await detectUnixSubprocesses(pid);

    if (entry.status !== 'running' || entry.pid !== pid) return;

    if (entry.hasRunningSubprocess !== hasChildProcess) {
      entry.hasRunningSubprocess = hasChildProcess;
      emit({
        type: 'activity',
        sessionId,
        hasRunningSubprocess: hasChildProcess,
      });
    }
  } catch (error) {
    if (entry.status !== 'running' || entry.pid !== pid) return;
    if (
      error &&
      typeof error === 'object' &&
      'killed' in error &&
      error.killed
    ) {
      debug('Terminal subprocess probe timed out:', sessionId, error);
      return;
    }
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
