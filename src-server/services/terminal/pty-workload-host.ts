/**
 * The supervisor's workload host (protocol 1.3): the process that owns
 * terminal PTYs and their journals so they outlive core server generations.
 * The supervisor starts it from the build root (`station-pty-host.js`) and
 * relays core requests to it; see `@kontourai/station-supervisor/protocol`.
 *
 * Output is journaled here with the core's own journal (same sanitizer,
 * segments and limits), so a core that attaches after a restart reads every
 * record from any sequence and sees what it would have seen in process. On
 * exit the journal is flushed and closed before the exit is reported; the core
 * then reads it from disk.
 */
import { type ChildProcess, spawn, spawnSync } from 'node:child_process';
import type {
  WorkloadErrorCode,
  WorkloadEventMessage,
  WorkloadExit,
  WorkloadInfo,
  WorkloadRequest,
  WorkloadSpawnRequest,
} from '@kontourai/station-supervisor/protocol';
import type { IPtyAdapter, IPtyProcess } from '../../domain/pty-adapter.js';
import { spawnFirstShell } from './shell-host.js';
import { TerminalJournal } from './terminal-journal.js';

/** Exited workloads kept for `list` and `attach`, oldest dropped first. */
const EXITED_KEPT = 64;
/** A terminated workload gets this long after SIGTERM/HUP before SIGKILL. */
const KILL_GRACE_MS = 3_000;
/** Termination fails when a workload has not exited this long after SIGKILL. */
const KILL_DEADLINE_MS = 6_000;
const DEFAULT_OUTPUT_CAP_BYTES = 16 * 1024 * 1024;

export class WorkloadFailure extends Error {
  constructor(
    readonly code: WorkloadErrorCode,
    message: string,
  ) {
    super(message);
  }
}

interface Workload {
  info: WorkloadInfo;
  process: IPtyProcess;
  journal: TerminalJournal;
  exited: Promise<void>;
}

/**
 * A `command` workload: no PTY, stdout and stderr journaled together. On
 * POSIX it leads its own process group so ending it reaches its children.
 */
class CommandProcess implements IPtyProcess {
  constructor(private readonly child: ChildProcess) {
    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
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
    this.child.stdin?.write(data);
  }

  resize(): void {}

  kill(signal?: string): void {
    this.child.kill((signal as NodeJS.Signals | undefined) ?? 'SIGTERM');
  }

  onData(cb: (data: string) => void): () => void {
    this.child.stdout?.on('data', cb);
    this.child.stderr?.on('data', cb);
    return () => {
      this.child.stdout?.off('data', cb);
      this.child.stderr?.off('data', cb);
    };
  }

  onExit(
    cb: (event: { exitCode: number; signal: number | null }) => void,
  ): () => void {
    // `close`, not `exit`: every byte of its output has been read by then.
    const listener = (code: number | null) =>
      cb({ exitCode: code ?? -1, signal: null });
    this.child.once('close', listener);
    return () => this.child.off('close', listener);
  }
}

export interface PtyWorkloadHostOptions {
  pty: IPtyAdapter;
  emit: (event: WorkloadEventMessage) => void;
}

export class PtyWorkloadHost {
  private readonly workloads = new Map<string, Workload>();

  constructor(private readonly options: PtyWorkloadHostOptions) {}

  async handle(request: WorkloadRequest): Promise<unknown> {
    if (request.op === 'list')
      return [...this.workloads.values()].map((w) => ({ ...w.info }));
    if (request.op === 'spawn') return this.spawn(request);
    const workload = this.workloads.get(request.workloadId);
    if (!workload) throw new WorkloadFailure('not-found', 'no such workload');
    if (request.op === 'attach') return { ...workload.info };
    if (request.op === 'terminate') {
      await this.terminate(workload);
      return { ...workload.info };
    }
    // The journal is closed once a workload has exited: read it from disk.
    if (workload.info.state !== 'running')
      throw new WorkloadFailure('not-found', 'the workload has exited');
    switch (request.op) {
      case 'read':
        return workload.journal.read(request.fromSeq, request.maxBytes);
      case 'flush':
        await workload.journal.flush();
        return null;
      case 'write':
        workload.process.write(request.data);
        return null;
      case 'resize':
        workload.process.resize(request.cols, request.rows);
        workload.info.cols = request.cols;
        workload.info.rows = request.rows;
        return null;
      case 'signal':
        try {
          workload.process.kill(request.signal);
        } catch (error) {
          // node-pty refuses signals on Windows.
          throw new WorkloadFailure('bad-request', String(error));
        }
        return null;
    }
    throw new WorkloadFailure('bad-request', 'unknown workload op');
  }

  /** Ends every running workload; for `host.stop` and a lost supervisor. */
  async stopAll(): Promise<void> {
    await Promise.allSettled(
      [...this.workloads.values()].map((workload) => this.terminate(workload)),
    );
  }

  private async spawn(request: WorkloadSpawnRequest): Promise<WorkloadInfo> {
    if (this.workloads.has(request.workloadId))
      throw new WorkloadFailure('exists', 'that workload already exists');
    const journal = new TerminalJournal(
      request.journal.directory,
      request.journal.options,
    );
    await journal.load();
    const env = request.env as NodeJS.ProcessEnv;
    const proc =
      request.kind === 'interactive'
        ? await spawnFirstShell(
            this.options.pty,
            request.candidates.map(({ command, args }) => ({
              shell: command,
              args,
            })),
            { cwd: request.cwd, cols: request.cols, rows: request.rows, env },
          )
        : this.spawnCommand(request, env);
    let markExited!: () => void;
    const workload: Workload = {
      info: {
        workloadId: request.workloadId,
        kind: request.kind,
        pid: proc.pid,
        cols: request.cols,
        rows: request.rows,
        lastSeq: journal.lastSeq,
        state: 'running',
      },
      process: proc,
      journal,
      exited: new Promise<void>((resolve) => {
        markExited = resolve;
      }),
    };
    this.workloads.set(request.workloadId, workload);
    this.trim();
    const cap =
      request.kind === 'command'
        ? (request.outputCapBytes ?? DEFAULT_OUTPUT_CAP_BYTES)
        : Number.POSITIVE_INFINITY;
    let received = 0;
    let journalFailed = false;
    let paused = false;
    const unsubscribeData = proc.onData((data) => {
      received += Buffer.byteLength(data);
      if (received > cap) {
        unsubscribeData();
        void this.terminate(workload);
        return;
      }
      const write = journal.append(data);
      if (!paused && journal.backpressured && proc.pause && proc.resume) {
        paused = true;
        proc.pause();
      }
      void write.then(
        () => {
          if (paused && journal.drained) {
            paused = false;
            proc.resume?.();
          }
          workload.info.lastSeq = journal.lastSeq;
          this.options.emit({
            type: 'workload.event',
            workloadId: request.workloadId,
            event: 'output',
            lastSeq: journal.lastSeq,
          });
        },
        () => {
          if (journalFailed) return;
          journalFailed = true;
          unsubscribeData();
          void this.terminate(workload);
        },
      );
    });
    const unsubscribeExit = proc.onExit((event) => {
      unsubscribeExit();
      // Output delivered in the same turn as the exit still reaches the journal.
      setImmediate(() => {
        unsubscribeData();
        void journal
          .flush()
          .catch(() => {
            journalFailed = true;
          })
          .then(() => {
            const exit: WorkloadExit = {
              exitCode: event.exitCode,
              signal: event.signal,
              outputIncomplete: event.outputIncomplete === true,
              journalFailed,
            };
            workload.info.lastSeq = journal.lastSeq;
            workload.info.state = 'exited';
            workload.info.exit = exit;
            this.options.emit({
              type: 'workload.event',
              workloadId: request.workloadId,
              event: 'exit',
              exit,
            });
            markExited();
            this.trim();
          });
      });
    });
    return { ...workload.info };
  }

  private spawnCommand(
    request: WorkloadSpawnRequest,
    env: NodeJS.ProcessEnv,
  ): IPtyProcess {
    const candidate = request.candidates[0];
    if (!candidate)
      throw new WorkloadFailure('bad-request', 'a command needs a candidate');
    const child = spawn(candidate.command, candidate.args, {
      cwd: request.cwd,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      detached: process.platform !== 'win32',
    });
    if (child.pid === undefined) {
      throw new WorkloadFailure(
        'failed',
        `could not start ${candidate.command}`,
      );
    }
    return new CommandProcess(child);
  }

  /**
   * Ends a workload and what it started: on POSIX its process groups (the
   * PTY adapter's census for a shell, the command's own group otherwise),
   * on Windows its process tree with `taskkill /T /F` before the PTY closes,
   * so descendants are found while their parent links still hold. Resolves
   * once it has exited and its journal is closed.
   */
  private async terminate(workload: Workload): Promise<void> {
    if (workload.info.state === 'running') {
      const pid = workload.info.pid;
      if (process.platform === 'win32') {
        spawnSync('taskkill', ['/T', '/F', '/PID', String(pid)], {
          stdio: 'ignore',
          windowsHide: true,
          timeout: KILL_DEADLINE_MS,
        });
        // Closing the PTY of a shell taskkill already ended makes node-pty
        // attach to a console that is gone, so only one still running.
        const ended = await Promise.race([
          workload.exited.then(() => true),
          this.delay(KILL_GRACE_MS).then(() => false),
        ]);
        if (!ended) this.quietly(() => workload.process.kill());
      } else if (workload.process.terminate) {
        await workload.process.terminate().catch(() => {
          this.quietly(() => workload.process.kill('SIGKILL'));
        });
      } else {
        this.signalGroup(workload, 'SIGTERM');
        const escalation = setTimeout(
          () => this.signalGroup(workload, 'SIGKILL'),
          KILL_GRACE_MS,
        );
        await Promise.race([workload.exited, this.delay(KILL_DEADLINE_MS)]);
        clearTimeout(escalation);
      }
    }
    const exited = await Promise.race([
      workload.exited.then(() => true),
      this.delay(KILL_DEADLINE_MS).then(() => false),
    ]);
    if (!exited)
      throw new WorkloadFailure('failed', 'the workload did not exit');
  }

  private signalGroup(workload: Workload, signal: NodeJS.Signals): void {
    if (workload.info.state !== 'running') return;
    try {
      // A command leads its own group; a negative pid signals all of it.
      process.kill(-workload.info.pid, signal);
    } catch {
      this.quietly(() => workload.process.kill(signal));
    }
  }

  private quietly(action: () => void): void {
    try {
      action();
    } catch {
      // Already gone.
    }
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms).unref());
  }

  private trim(): void {
    const exited = [...this.workloads.values()].filter(
      (workload) => workload.info.state === 'exited',
    );
    for (const workload of exited.slice(
      0,
      Math.max(0, exited.length - EXITED_KEPT),
    ))
      this.workloads.delete(workload.info.workloadId);
  }
}
