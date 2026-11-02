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

export const DEFAULT_COMMAND_OUTPUT_CAP_BYTES = 16 * 1024 * 1024;
/** A terminated command gets this long after SIGTERM before SIGKILL. */
const KILL_GRACE_MS = 3_000;
/** Termination fails when the command has not exited this long after it began. */
const KILL_DEADLINE_MS = 6_000;
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
export function signalNumber(name: string | null | undefined): number | null {
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

export class CommandProcess implements IPtyProcess {
  private delivered = 0;
  private capped = false;
  private exit: CommandExit | null = null;
  private readonly dataListeners = new Set<(data: string) => void>();
  private readonly exitListeners = new Set<(event: CommandExit) => void>();
  private readonly closed: Promise<void>;

  constructor(
    private readonly child: ChildProcess,
    private readonly outputCapBytes: number,
  ) {
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
   * Ends the command and what it started: its process group on POSIX
   * (SIGTERM, then SIGKILL), its tree with `taskkill /T /F` on Windows.
   * Resolves once its exit is reported.
   */
  async terminate(): Promise<void> {
    if (this.exit) return;
    if (process.platform === 'win32')
      spawnSync('taskkill', ['/T', '/F', '/PID', String(this.pid)], {
        stdio: 'ignore',
        windowsHide: true,
        timeout: KILL_DEADLINE_MS,
      });
    else this.signalGroup('SIGTERM');
    const escalation = setTimeout(
      () => this.signalGroup('SIGKILL'),
      KILL_GRACE_MS,
    );
    let deadline: ReturnType<typeof setTimeout> | undefined;
    try {
      const ended = await Promise.race([
        this.closed.then(() => true),
        new Promise<boolean>((done) => {
          deadline = setTimeout(() => done(false), KILL_DEADLINE_MS);
        }),
      ]);
      if (!ended) throw new Error('The command did not exit');
    } finally {
      clearTimeout(escalation);
      clearTimeout(deadline);
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
    if (this.exit || this.child.pid === undefined) return;
    try {
      // The command leads its own group on POSIX; a negative pid reaches it all.
      if (process.platform === 'win32') throw new Error('no process groups');
      process.kill(-this.child.pid, signal);
    } catch {
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
        ),
      ),
    );
  });
}
