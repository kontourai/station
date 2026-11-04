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
import { spawnSync } from 'node:child_process';
import type {
  WorkloadErrorCode,
  WorkloadEventMessage,
  WorkloadExit,
  WorkloadInfo,
  WorkloadRequest,
  WorkloadSpawnRequest,
} from '@kontourai/station-supervisor/protocol';
import type { IPtyAdapter, IPtyProcess } from '../../domain/pty-adapter.js';
import { CommandSpawnError, spawnCommandProcess } from './command-process.js';
import { spawnFirstShell } from './shell-host.js';
import { TerminalJournal } from './terminal-journal.js';

/** Exited workloads kept for `list` and `attach`, oldest dropped first. */
const EXITED_KEPT = 64;
/** A terminated workload gets this long after SIGTERM/HUP before SIGKILL. */
const KILL_GRACE_MS = 3_000;
/** Termination fails when a workload has not exited this long after SIGKILL. */
const KILL_DEADLINE_MS = 6_000;

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
    // An exited workload's id may run again: a restarted session keeps its
    // id and continues its journal in a new segment.
    if (this.workloads.get(request.workloadId)?.info.state === 'running')
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
        : await this.spawnCommand(request, env);
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
    this.workloads.delete(request.workloadId);
    this.workloads.set(request.workloadId, workload);
    this.trim();
    // A command's output cap is enforced by its process (command-process.ts).
    let journalFailed = false;
    let paused = false;
    const unsubscribeData = proc.onData((data) => {
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
              ...(event.outputCapped && { outputCapped: true }),
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

  private async spawnCommand(
    request: WorkloadSpawnRequest,
    env: NodeJS.ProcessEnv,
  ): Promise<IPtyProcess> {
    const candidate = request.candidates[0];
    if (!candidate)
      throw new WorkloadFailure('bad-request', 'a command needs a candidate');
    try {
      return await spawnCommandProcess({
        command: candidate.command,
        args: candidate.args,
        cwd: request.cwd,
        env,
        outputCapBytes: request.outputCapBytes,
      });
    } catch (error) {
      // The message keeps the errno (`spawn x ENOENT`) for the core to report.
      throw new WorkloadFailure(
        'failed',
        error instanceof CommandSpawnError
          ? error.message
          : `could not start ${candidate.command}`,
      );
    }
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
