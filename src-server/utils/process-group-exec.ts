import { spawn } from 'node:child_process';

/** SIGTERM first; SIGKILL the group if anything is still there after this. */
const GROUP_KILL_GRACE_MS = 1000;
const DEFAULT_MAX_BUFFER = 1024 * 1024;

/** A child started in its own process group (POSIX). */
export const OWN_PROCESS_GROUP = process.platform !== 'win32';

/**
 * Signals `child`'s whole process group and everything under it
 * (#2363). Signalling the child alone stops git itself but
 * orphans what git started: a hook's shell and its children, a filter, the
 * processes a tool such as gh runs. (Checked on macOS: `/usr/bin/git`'s
 * xcrun shim EXECs the real git, so the pid is git's; the orphans are
 * further down the chain.) Falls back to the child itself where there are
 * no process groups.
 */
export function killProcessTree(
  child: { pid?: number; kill(signal?: NodeJS.Signals): boolean },
  signal: NodeJS.Signals = 'SIGTERM',
): void {
  if (OWN_PROCESS_GROUP && child.pid !== undefined) {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch {
      // The group is already gone.
    }
  }
  try {
    child.kill(signal);
  } catch {
    // Already exited.
  }
}

/** Group leaders Station started that have not exited yet. */
const liveGroups = new Set<ReturnType<typeof spawn>>();

export function trackGroup<T extends ReturnType<typeof spawn>>(child: T): T {
  if (!OWN_PROCESS_GROUP || child.pid === undefined) return child;
  liveGroups.add(child);
  child.once('exit', () => liveGroups.delete(child));
  child.once('error', () => liveGroups.delete(child));
  return child;
}

/**
 * SIGTERMs every process group Station started that is still running (git,
 * gh, glab, and whatever they started), for server shutdown. They are
 * detached into their own groups, so they would otherwise outlive Station.
 * Returns how many groups were signalled.
 */
export function stopLiveProcessGroups(): number {
  let signalled = 0;
  for (const child of liveGroups) {
    killProcessTree(child, 'SIGTERM');
    signalled += 1;
  }
  liveGroups.clear();
  return signalled;
}

/** SIGTERM the group, then SIGKILL it if the leader has not closed. */
function stopProcessTree(child: ReturnType<typeof spawn>): void {
  killProcessTree(child, 'SIGTERM');
  const escalate = setTimeout(() => {
    killProcessTree(child, 'SIGKILL');
  }, GROUP_KILL_GRACE_MS);
  escalate.unref();
  child.once('close', () => {
    // Anything the leader left behind in the group still goes.
    killProcessTree(child, 'SIGKILL');
    clearTimeout(escalate);
  });
}

interface GroupRunOptions {
  /** Retire same-group descendants when the command leader exits. */
  retireDescendantsOnExit?: boolean;
  cwd?: string | URL;
  env: NodeJS.ProcessEnv;
  timeout?: number;
  maxBuffer?: number;
  /** Written to the child's stdin, which is then closed. Without it the
   * child's stdin is the null device. */
  input?: Buffer | string;
  /** Aborting stops the process group, as the deadline does. */
  signal?: AbortSignal;
}

type GroupRunError = Error & {
  code?: number | string | null;
  killed?: boolean;
  signal?: NodeJS.Signals | null;
  stdout?: string;
  stderr?: string;
  cmd?: string;
};

/**
 * `execFile`'s promise contract (resolves `{ stdout, stderr }` as strings;
 * rejects with `code`, `killed`, `signal`, `stdout`, `stderr`), but the
 * child runs in its own process group and a deadline or an overflowing
 * output kills the GROUP. See `killProcessTree`.
 */
export function runInProcessGroup(
  file: string,
  args: readonly string[],
  options: GroupRunOptions,
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    if (options.signal?.aborted) {
      const error: GroupRunError = new Error(
        `Command aborted before it started: ${[file, ...args].join(' ')}`,
      );
      error.killed = true;
      error.signal = 'SIGTERM';
      error.cmd = [file, ...args].join(' ');
      reject(error);
      return;
    }
    const child = trackGroup(
      spawn(file, [...args], {
        cwd: options.cwd,
        env: options.env,
        detached: OWN_PROCESS_GROUP,
        stdio: [
          options.input === undefined ? 'ignore' : 'pipe',
          'pipe',
          'pipe',
        ],
        windowsHide: true,
      }),
    );
    if (options.input !== undefined && child.stdin) {
      // A child that exits without reading all of it closes the pipe; the
      // exit status, not the write, is the command's outcome.
      child.stdin.on('error', () => undefined);
      child.stdin.end(options.input);
    }
    const maxBuffer = options.maxBuffer ?? DEFAULT_MAX_BUFFER;
    // Collected as bytes, so `maxBuffer` bounds bytes (as execFile's does).
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let killed = false;
    let overflow = false;
    let settled = false;
    let exited: { code: number | null; signal: NodeJS.Signals | null } | null =
      null;
    const stop = () => {
      if (killed || exited) return;
      killed = true;
      stopProcessTree(child);
    };
    const timer =
      options.timeout && options.timeout > 0
        ? setTimeout(stop, options.timeout)
        : undefined;
    const signal = options.signal;
    if (signal?.aborted) stop();
    else signal?.addEventListener('abort', stop, { once: true });
    const unlisten = () => signal?.removeEventListener('abort', stop);
    child.stdout?.on('data', (chunk: Buffer) => {
      if (stdoutBytes < maxBuffer)
        stdout.push(chunk.subarray(0, maxBuffer - stdoutBytes));
      stdoutBytes += chunk.length;
      if (stdoutBytes > maxBuffer) {
        overflow = true;
        stop();
      }
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      if (stderrBytes < maxBuffer)
        stderr.push(chunk.subarray(0, maxBuffer - stderrBytes));
      stderrBytes += chunk.length;
      if (stderrBytes > maxBuffer) {
        overflow = true;
        stop();
      }
    });
    child.on('error', (error) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      unlisten();
      reject(error);
    });
    // The LEADER's exit is the command's outcome. A process it started that
    // left the group (setsid), or one it backgrounded (a post-commit hook's
    // job), can hold our pipes open long after, so 'close' may be late or
    // never come: once the leader has exited, the deadline no longer
    // applies, and after a short grace the pipes are closed from our side.
    child.on('exit', (code, signal) => {
      exited = { code, signal };
      if (options.retireDescendantsOnExit) stopProcessTree(child);
      if (timer) clearTimeout(timer);
      setTimeout(() => {
        child.stdout?.destroy();
        child.stderr?.destroy();
      }, GROUP_KILL_GRACE_MS * 2).unref();
    });
    child.on('close', (closeCode, closeSignal) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      unlisten();
      const code = exited ? exited.code : closeCode;
      const signal = exited ? exited.signal : closeSignal;
      const out = Buffer.concat(stdout).toString('utf8');
      const err = Buffer.concat(stderr).toString('utf8');
      if (code === 0 && !killed) {
        resolve({ stdout: out, stderr: err });
        return;
      }
      const error: GroupRunError = new Error(
        overflow
          ? `${file} output exceeded maxBuffer`
          : `Command failed: ${[file, ...args].join(' ')}\n${err}`,
      );
      error.code = overflow ? 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' : code;
      error.killed = killed;
      error.signal = killed ? (signal ?? 'SIGTERM') : signal;
      error.stdout = out;
      error.stderr = err;
      error.cmd = [file, ...args].join(' ');
      reject(error);
    });
  });
}
