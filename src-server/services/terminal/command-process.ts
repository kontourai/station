/**
 * A `command` terminal session's process (#3994): no PTY, stdout and stderr
 * delivered together, up to an output cap. Both shell hosts use it: the
 * in-process host for a core without a supervisor, and the supervisor's
 * workload host, so the cap, signal reporting and group termination are the
 * same wherever the command runs.
 */
import {
  type ChildProcess,
  spawn as nodeSpawn,
  type SpawnOptions,
  spawnSync,
} from 'node:child_process';
import { constants } from 'node:os';
import type { IPtyProcess } from '../../domain/pty-adapter.js';
import {
  killWindowsProcesses,
  listWindowsProcesses,
  type WindowsProcessKiller,
  type WindowsProcessLister,
} from '../infra/process-utils.js';
import {
  attributeWindowsProcesses,
  type OwnedWindowsProcess,
  windowsNowUs,
} from './windows-owned-processes.js';

export const DEFAULT_COMMAND_OUTPUT_CAP_BYTES = 16 * 1024 * 1024;
/** A terminated command gets this long after SIGTERM before SIGKILL. */
const KILL_GRACE_MS = 3_000;
/**
 * Termination fails when the command, or a process it started, has not
 * exited this long after it began.
 */
const KILL_DEADLINE_MS = 6_000;
/**
 * Windows reads the process table through PowerShell, which can take
 * seconds to start on a loaded host; each round of termination reads it.
 */
const WINDOWS_KILL_DEADLINE_MS = 60_000;
/**
 * While terminating, how often the command's process group is checked
 * after its leader exited. A group id is reserved only while the group has
 * a member; once it is seen empty it is never signaled again, so its number
 * cannot be reused under a later signal.
 */
const GROUP_WATCH_MS = 20;
/**
 * After the command exits, how long its pipes may stay open before its exit
 * is reported anyway. A background child that inherited them (`server &`)
 * would otherwise hold the exit back for as long as it lives.
 */
const PIPE_DRAIN_MS = 1_000;

/** A command that could not start; `code` is the spawn errno (`ENOENT`, `EACCES`). */
export class CommandSpawnError extends Error {
  constructor(
    message: string,
    readonly code: string | undefined,
  ) {
    super(message);
  }
}

/** A signal's number, for the exit event; null for an unknown name. */
function signalNumber(name: string | null | undefined): number | null {
  if (!name) return null;
  return (constants.signals as Record<string, number>)[name] ?? null;
}

/** A signal's name from its number, for a protocol that reports names (ACP). */
export function signalName(number: number | null | undefined): string | null {
  if (number === null || number === undefined) return null;
  for (const [name, value] of Object.entries(constants.signals))
    if (value === number) return name;
  return null;
}

type CommandExit = Parameters<Parameters<IPtyProcess['onExit']>[0]>[0];

/** How a command's descendants are found and ended on Windows (test seam). */
interface WindowsCommandCensus {
  list: WindowsProcessLister;
  kill: WindowsProcessKiller;
}

class CommandProcess implements IPtyProcess {
  private delivered = 0;
  private capped = false;
  private exit: CommandExit | null = null;
  private readonly dataListeners = new Set<(data: string) => void>();
  private readonly exitListeners = new Set<(event: CommandExit) => void>();
  private readonly closed: Promise<void>;
  /** Node reaped the leader: its pid no longer reserves the group id. */
  private leaderExited = false;
  /** The group was seen empty after the leader exited; never signal it again. */
  private groupGone = false;
  /** Checks the group while terminating, so emptiness is seen promptly. */
  private groupWatch: ReturnType<typeof setInterval> | undefined;
  private terminating: Promise<void> | undefined;

  constructor(
    private readonly child: ChildProcess,
    private readonly outputCapBytes: number,
    private readonly census: WindowsCommandCensus = {
      list: listWindowsProcesses,
      kill: killWindowsProcesses,
    },
  ) {
    child.once('exit', () => {
      this.leaderExited = true;
    });
    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    const deliver = (data: string) => this.deliver(data);
    child.stdout?.on('data', deliver);
    child.stderr?.on('data', deliver);
    // A write to a command that has stopped reading its input is lost, as
    // input to a PTY that just exited is.
    child.stdin?.on('error', () => {});
    let reported!: () => void;
    this.closed = new Promise((done) => {
      reported = done;
    });
    const report = (code: number | null, signal: NodeJS.Signals | null) => {
      if (this.exit) return;
      child.stdout?.off('data', deliver);
      child.stderr?.off('data', deliver);
      this.exit = {
        exitCode: code ?? -1,
        signal: signalNumber(signal),
        ...(this.capped && { outputCapped: true }),
      };
      reported();
      for (const listener of [...this.exitListeners]) listener(this.exit);
    };
    // `close` follows the last byte of output; `exit` bounds how long a
    // background child holding the pipes can delay it.
    child.once('close', report);
    child.once('exit', (code, signal) => {
      setTimeout(() => {
        child.stdout?.destroy();
        child.stderr?.destroy();
        report(code, signal);
      }, PIPE_DRAIN_MS).unref();
    });
  }

  get pid(): number {
    return this.child.pid ?? -1;
  }

  pause(): void {
    this.child.stdout?.pause();
    this.child.stderr?.pause();
  }

  resume(): void {
    this.child.stdout?.resume();
    this.child.stderr?.resume();
  }

  write(data: string): void {
    if (this.child.stdin?.writable) this.child.stdin.write(data);
  }

  resize(): void {}

  kill(signal?: string): void {
    this.signalGroup((signal as NodeJS.Signals | undefined) ?? 'SIGTERM');
  }

  /**
   * Ends the command and what it started, and resolves only once none of it
   * remains: the leader exiting is not enough, since a process it started
   * can ignore SIGTERM or outlive its parent. POSIX: its process group,
   * SIGTERM then SIGKILL. Windows: every process proven to descend from it,
   * forcibly, until a process table shows none left. Rejects when that
   * cannot be established before the deadline.
   */
  terminate(): Promise<void> {
    if (this.exit && !this.terminating) return Promise.resolve();
    this.terminating ??= (
      process.platform === 'win32'
        ? this.terminateWindows()
        : this.terminateGroup()
    ).finally(() => this.stopGroupWatch());
    return this.terminating;
  }

  private async terminateGroup(): Promise<void> {
    this.startGroupWatch();
    this.signalGroup('SIGTERM');
    const escalation = setTimeout(
      () => this.signalGroup('SIGKILL'),
      KILL_GRACE_MS,
    );
    try {
      const ended = await this.within(
        Promise.all([this.closed, this.groupEmpty()]),
        KILL_DEADLINE_MS,
      );
      if (!ended)
        throw new Error('The command or a process it started did not exit');
    } finally {
      clearTimeout(escalation);
    }
  }

  private async terminateWindows(): Promise<void> {
    const deadline = Date.now() + WINDOWS_KILL_DEADLINE_MS;
    const owned = new Map<number, OwnedWindowsProcess>();
    let seeded = false;
    for (;;) {
      const started = windowsNowUs();
      const table = await this.census.list();
      if (!table) {
        // Without a process table no descendant can be proven; end the
        // leader's current tree the old way and say custody is unknown.
        if (!this.leaderExited)
          spawnSync('taskkill', ['/T', '/F', '/PID', String(this.pid)], {
            stdio: 'ignore',
            windowsHide: true,
            timeout: KILL_DEADLINE_MS,
          });
        throw new Error(
          "The command's processes could not be listed to end them",
        );
      }
      if (!seeded) {
        seeded = true;
        // Node holds the leader's process handle until it reports the
        // exit, so while it has not, its pid cannot name another process.
        const leader = table.find((entry) => entry.pid === this.pid);
        if (leader && !this.leaderExited)
          owned.set(leader.pid, {
            pid: leader.pid,
            createdUs: leader.createdUs,
            lastSeenUs: started,
          });
      }
      const alive = attributeWindowsProcesses(owned, table, started);
      if (!alive.length) break;
      if (Date.now() >= deadline)
        throw new Error('The command or a process it started did not exit');
      // Each by pid, never `/T`: a stale parent pid is not ownership.
      await this.census
        .kill(alive.map((entry) => entry.pid))
        .catch(() => undefined);
    }
    if (
      !(await this.within(
        this.closed,
        Math.max(0, deadline - Date.now()) || 1,
      ))
    )
      throw new Error('The command did not exit');
  }

  /** True when `promise` settles before `ms`. */
  private async within(promise: Promise<unknown>, ms: number) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        promise.then(() => true),
        new Promise<boolean>((done) => {
          timer = setTimeout(() => done(false), ms);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  private groupEmpty(): Promise<void> {
    return new Promise((done) => {
      const check = () => {
        if (this.leaderExited && !this.groupAlive()) done();
        else setTimeout(check, GROUP_WATCH_MS).unref();
      };
      check();
    });
  }

  private startGroupWatch(): void {
    if (this.groupWatch) return;
    this.groupWatch = setInterval(() => {
      if (this.leaderExited) this.groupAlive();
    }, GROUP_WATCH_MS);
    this.groupWatch.unref();
  }

  private stopGroupWatch(): void {
    clearInterval(this.groupWatch);
    this.groupWatch = undefined;
  }

  /**
   * Whether the command's process group may still have members. Before Node
   * reports the leader's exit, the leader (or its zombie) reserves the id.
   * After it, the id is reserved by the remaining members; it is checked
   * only while the watch runs, and latched as gone the first time it is
   * seen empty.
   */
  private groupAlive(): boolean {
    if (this.groupGone || this.child.pid === undefined) return false;
    if (!this.leaderExited) return true;
    if (!this.groupWatch) return false;
    try {
      process.kill(-this.child.pid, 0);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EPERM') return true;
      this.groupGone = true;
      return false;
    }
  }

  onData(cb: (data: string) => void): () => void {
    this.dataListeners.add(cb);
    return () => this.dataListeners.delete(cb);
  }

  onExit(cb: (event: CommandExit) => void): () => void {
    const exit = this.exit;
    if (exit) {
      queueMicrotask(() => cb(exit));
      return () => {};
    }
    this.exitListeners.add(cb);
    return () => this.exitListeners.delete(cb);
  }

  /**
   * Output past the cap is not delivered, and the command is ended: the
   * chunk that crosses it is dropped whole, so no more than the cap is ever
   * journaled. The exit then reports `outputCapped`.
   */
  private deliver(data: string): void {
    if (this.capped) return;
    this.delivered += Buffer.byteLength(data);
    if (this.delivered > this.outputCapBytes) {
      this.capped = true;
      void this.terminate().catch(() => this.signalGroup('SIGKILL'));
      return;
    }
    for (const listener of [...this.dataListeners]) listener(data);
  }

  private signalGroup(signal: NodeJS.Signals): void {
    if (this.child.pid === undefined) return;
    if (process.platform === 'win32') {
      if (this.exit || this.leaderExited) return;
      try {
        this.child.kill(signal);
      } catch {
        // Already gone.
      }
      return;
    }
    // The command leads its own group; a negative pid reaches all of it. A
    // check immediately before the signal keeps it to a group still ours.
    if (!this.groupAlive()) return;
    try {
      process.kill(-this.child.pid, signal);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ESRCH') {
        if (this.leaderExited) this.groupGone = true;
        return;
      }
      if (this.leaderExited) return;
      try {
        this.child.kill(signal);
      } catch {
        // Already gone.
      }
    }
  }
}

/**
 * Starts a command and resolves once it has started, or rejects with a
 * `CommandSpawnError` (a missing or unrunnable executable) without leaving an
 * unhandled `error` event behind.
 */
export function spawnCommandProcess(
  input: {
    command: string;
    args: readonly string[];
    cwd: string;
    env: NodeJS.ProcessEnv;
    outputCapBytes?: number;
    /** Test seam: the Windows process table and per-pid kill. */
    windowsCensus?: WindowsCommandCensus;
  },
  spawn: (
    command: string,
    args: readonly string[],
    options: SpawnOptions,
  ) => ChildProcess = (command, args, options) =>
    nodeSpawn(command, [...args], options),
): Promise<CommandProcess> {
  return new Promise((resolve, reject) => {
    let child: ChildProcess;
    try {
      child = spawn(input.command, input.args, {
        cwd: input.cwd,
        env: input.env,
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
        detached: process.platform !== 'win32',
      });
    } catch (error) {
      reject(
        new CommandSpawnError(
          `spawn failed: ${(error as Error).message}`,
          (error as NodeJS.ErrnoException).code,
        ),
      );
      return;
    }
    // Later errors (a failed kill or write) are not a spawn failure.
    child.on('error', () => {});
    child.once('error', (error: NodeJS.ErrnoException) =>
      reject(
        new CommandSpawnError(`spawn failed: ${error.message}`, error.code),
      ),
    );
    child.once('spawn', () =>
      resolve(
        new CommandProcess(
          child,
          input.outputCapBytes ?? DEFAULT_COMMAND_OUTPUT_CAP_BYTES,
          input.windowsCensus,
        ),
      ),
    );
  });
}
