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
  type CommandChild,
  GuardSpawnError,
  resolveWindowsCommandGuard,
  spawnGuardedCommand,
} from './windows-command-guard.js';
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
  /** When Node saw the leader exit, in the Windows process table's clock. */
  private leaderExitedUs: bigint | undefined;
  /** The group was seen empty after the leader exited; never signal it again. */
  private groupGone = false;
  /** Checks the group while terminating, so emptiness is seen promptly. */
  private groupWatch: ReturnType<typeof setInterval> | undefined;
  private terminating: Promise<void> | undefined;
  private paused = false;
  private outputIncomplete = false;
  private pending: string[] = [];

  constructor(
    private readonly child: CommandChild,
    private readonly outputCapBytes: number,
    /** No later than the leader's creation, in the process table's clock. */
    private readonly spawnedUs: bigint,
    private readonly census: WindowsCommandCensus = {
      list: listWindowsProcesses,
      kill: killWindowsProcesses,
    },
  ) {
    child.once('exit', () => {
      this.leaderExited = true;
      this.leaderExitedUs = windowsNowUs();
      if (this.paused) this.outputIncomplete = true;
    });
    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    const deliver = (data: string) => this.deliver(data);
    child.stdout?.on('data', deliver);
    child.stderr?.on('data', deliver);
    for (const output of [child.stdout, child.stderr])
      output?.on('error', () => {
        this.outputIncomplete = true;
        if (child.completeOutput) void this.terminate().catch(() => undefined);
      });
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
        ...((this.outputIncomplete ||
          this.paused ||
          this.pending.length > 0) && {
          outputIncomplete: true,
        }),
      };
      this.pending = [];
      reported();
      for (const listener of [...this.exitListeners]) listener(this.exit);
    };
    // `close` follows the last byte of output; `exit` bounds how long a
    // background child holding the pipes can delay it.
    const fenceOutput = () => {
      for (const output of [child.stdout, child.stderr]) {
        output?.pause();
        output?.off('data', deliver);
        // Fence delivery first, then charge every chunk already accepted by
        // Node before closing the pipes. Background children need not send EOF.
        let buffered: string | null;
        while (output && (buffered = output.read()) !== null)
          this.deliver(buffered);
        output?.destroy();
      }
    };
    let drain: ReturnType<typeof setTimeout> | undefined;
    child.once('close', (code, signal) => {
      clearTimeout(drain);
      if (child.completeOutput) fenceOutput();
      if (child.completeOutput && signal && !this.terminating)
        this.outputIncomplete = true;
      report(code, signal);
    });
    child.once('exit', (code, signal) => {
      if (this.exit) return;
      drain = setTimeout(() => {
        if (child.completeOutput) {
          fenceOutput();
          if (this.pending.length) this.outputIncomplete = true;
          if (this.capped || this.terminating || this.outputIncomplete) {
            // Do not await terminate here: it waits for the final close report.
            void this.terminate().catch(() => undefined);
          } else {
            void child.completeOutput().catch(() => {
              this.outputIncomplete = true;
            });
          }
        } else {
          child.stdout?.destroy();
          child.stderr?.destroy();
          report(code, signal);
        }
      }, PIPE_DRAIN_MS).unref();
    });
  }

  get pid(): number {
    return this.child.pid ?? -1;
  }

  pause(): void {
    this.paused = true;
    if (this.child.completeOutput) return;
    this.child.stdout?.pause();
    this.child.stderr?.pause();
  }

  resume(): void {
    this.paused = false;
    this.flushPending();
    if (this.child.completeOutput) return;
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
   * SIGTERM then SIGKILL. Windows: its whole Job when it runs in one (the
   * guard confirms the Job is empty); otherwise every process proven to
   * descend from it, forcibly, until a process table shows none left.
   * Rejects when that cannot be established before the deadline.
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
    // A command in a Job (#4624): ending the Job ends every process the
    // command started, including one whose parent already exited, and the
    // guard confirms none is left.
    if (this.child.endJob) {
      if (!(await this.within(this.child.endJob(), WINDOWS_KILL_DEADLINE_MS)))
        throw new Error('The command or a process it started did not exit');
      if (
        !(await this.within(
          this.closed,
          Math.max(0, deadline - Date.now()) || 1,
        ))
      )
        throw new Error('The command did not exit');
      return;
    }
    // The command ends now, never after a process-table read: that read
    // goes through PowerShell, and a cold one can take tens of seconds.
    // Node holds the leader's process handle until it reports the exit, so
    // until then its pid names no other process and ending it is safe.
    if (!this.leaderExited) this.signalLeader('SIGKILL');
    // The leader held its pid from its spawn until it was ended (or until
    // Node saw it exit), so a process naming that pid as its parent and
    // created in between is its child, whether the leader still appears in
    // a later table or not.
    const owned = new Map<number, OwnedWindowsProcess>([
      [
        this.pid,
        {
          pid: this.pid,
          createdUs: this.spawnedUs,
          lastSeenUs: this.leaderExitedUs ?? windowsNowUs(),
        },
      ],
    ]);
    for (;;) {
      const started = windowsNowUs();
      const table = await this.census.list();
      if (!table)
        throw new Error(
          'The command ended, but the processes it started could not be listed to end them',
        );
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
      !(await this.within(this.closed, Math.max(0, deadline - Date.now()) || 1))
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
    this.flushPending();
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
    if (this.child.completeOutput) {
      // Cap accounting keeps flowing while the journal applies backpressure.
      // These ordered strings are charged to the same finite cap, not a second
      // unbounded pipe buffer; they are never forwarded while delivery is paused.
      this.pending.push(data);
      this.flushPending();
    } else for (const listener of [...this.dataListeners]) listener(data);
  }

  private flushPending(): void {
    while (!this.paused && this.dataListeners.size && this.pending.length) {
      const data = this.pending.shift()!;
      for (const listener of [...this.dataListeners]) listener(data);
    }
  }

  private signalGroup(signal: NodeJS.Signals): void {
    const pid = this.child.pid;
    if (pid === undefined) return;
    if (process.platform === 'win32') {
      if (!this.leaderExited) this.signalLeader(signal);
      return;
    }
    // The command leads its own group; a negative pid reaches all of it. A
    // check immediately before the signal keeps it to a group still ours.
    if (!this.groupAlive()) return;
    try {
      process.kill(-pid, signal);
    } catch (error) {
      const missing = (error as NodeJS.ErrnoException).code === 'ESRCH';
      if (this.leaderExited) this.groupGone ||= missing;
      else if (!missing) this.signalLeader(signal);
    }
  }

  /** The leader alone, while Node still holds its handle. */
  private signalLeader(signal: NodeJS.Signals): void {
    try {
      this.child.kill(signal);
    } catch {
      // Already gone.
    }
  }
}

/** cmd.exe on Windows, which takes its command line as written. */
function isWindowsCommandProcessor(
  command: string,
  platform: NodeJS.Platform = process.platform,
): boolean {
  return platform === 'win32' && /(^|[\\/])cmd(\.exe)?$/i.test(command);
}

/**
 * Starts a command and resolves once it has started, or rejects with a
 * `CommandSpawnError` (a missing or unrunnable executable) without leaving an
 * unhandled `error` event behind. On Windows the command runs in a Job
 * through the Station Job guard when one is available
 * (`windows-command-guard.ts`), so Stop reaches every process it started.
 */
export async function spawnCommandProcess(
  input: {
    command: string;
    args: readonly string[];
    cwd: string;
    env: NodeJS.ProcessEnv;
    outputCapBytes?: number;
    /** Test seam: the Windows process table and per-pid kill. */
    windowsCensus?: WindowsCommandCensus;
    /**
     * Test seam: the Windows Job guard to start the command through; null
     * starts it directly. Absent: the one this process resolves.
     */
    windowsGuard?: string | null;
  },
  spawn: (
    command: string,
    args: readonly string[],
    options: SpawnOptions,
  ) => ChildProcess = (command, args, options) =>
    nodeSpawn(command, [...args], options),
): Promise<CommandProcess> {
  const guard =
    process.platform !== 'win32'
      ? null
      : input.windowsGuard === undefined
        ? await resolveWindowsCommandGuard()
        : input.windowsGuard;
  const outputCapBytes =
    input.outputCapBytes ?? DEFAULT_COMMAND_OUTPUT_CAP_BYTES;
  if (guard) {
    // Before the spawn: no later than the process's creation time.
    const spawnedUs = windowsNowUs();
    try {
      const child = await spawnGuardedCommand(
        guard,
        {
          command: input.command,
          args: input.args,
          cwd: input.cwd,
          env: input.env,
          verbatim: isWindowsCommandProcessor(input.command),
        },
        spawn,
      );
      return new CommandProcess(
        child,
        outputCapBytes,
        spawnedUs,
        input.windowsCensus,
      );
    } catch (error) {
      if (error instanceof GuardSpawnError)
        throw new CommandSpawnError(error.message, error.code);
      throw error;
    }
  }
  return new Promise((resolve, reject) => {
    let child: ChildProcess;
    // Before the spawn: no later than the process's creation time.
    const spawnedUs = windowsNowUs();
    try {
      child = spawn(input.command, input.args, {
        cwd: input.cwd,
        env: input.env,
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
        detached: process.platform !== 'win32',
        // cmd.exe parses its own line, and Node's quoting for other programs
        // turns a command's quotes into \" there; the launch quotes for cmd.
        windowsVerbatimArguments: isWindowsCommandProcessor(input.command),
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
          outputCapBytes,
          spawnedUs,
          input.windowsCensus,
        ),
      ),
    );
  });
}
