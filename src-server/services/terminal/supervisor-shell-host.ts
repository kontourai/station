/**
 * Terminals as supervisor workloads (protocol 1.3): the shell and its journal
 * live in the supervisor's workload host, so they survive a core restart or
 * handoff. The core keeps policy, authorization and binding; this host only
 * spawns, relays and reads. `InProcessShellHost` is the fallback when the
 * supervisor does not grant `workloads`.
 */
import type {
  WorkloadEventMessage,
  WorkloadInfo,
  WorkloadReadResult,
  WorkloadRequest,
} from '@kontourai/station-supervisor/protocol';
import type { IPtyAdapter, IPtyProcess } from '../../domain/pty-adapter.js';
import { createLogger } from '../../utils/logger.js';
import {
  type HostedShellProcess,
  InProcessShellHost,
  type ShellHost,
  type ShellJournalSpec,
  shellCandidates,
  terminalShellEnvironment,
} from './shell-host.js';
import { TerminalJournal } from './terminal-journal.js';

const logger = createLogger({ name: 'supervisor-shell-host' });

/** The core's end of the workload protocol; `SupervisorLink` provides it. */
export interface WorkloadChannel {
  /** Rejects with an Error whose `code` is the workload error code. */
  requestWorkload(request: WorkloadRequest): Promise<unknown>;
  onWorkloadEvent(listener: (event: WorkloadEventMessage) => void): () => void;
}

function notFound(error: unknown): boolean {
  return (
    error instanceof Error &&
    'code' in error &&
    (error as { code?: unknown }).code === 'not-found'
  );
}

/**
 * The journal of a workload: read from the host while it runs. Once it has
 * exited the host has flushed and closed it, so it is read from disk.
 */
class HostedJournal {
  readonly backpressured = false;
  readonly drained = true;
  private local: Promise<TerminalJournal> | null = null;

  constructor(
    private readonly channel: WorkloadChannel,
    private readonly workloadId: string,
    private readonly spec: ShellJournalSpec,
  ) {}

  async read(
    fromSeq = 0,
    maxReadBytes = Number.MAX_SAFE_INTEGER,
  ): Promise<WorkloadReadResult> {
    if (!this.local) {
      try {
        return (await this.channel.requestWorkload({
          op: 'read',
          workloadId: this.workloadId,
          fromSeq,
          maxBytes: maxReadBytes,
        })) as WorkloadReadResult;
      } catch (error) {
        if (!notFound(error)) throw error;
      }
    }
    return (await this.fromDisk()).read(fromSeq, maxReadBytes);
  }

  async flush(): Promise<void> {
    if (this.local) return;
    try {
      await this.channel.requestWorkload({
        op: 'flush',
        workloadId: this.workloadId,
      });
    } catch (error) {
      if (!notFound(error)) throw error;
    }
  }

  /** Retention only discards an ended session's journal, which is on disk. */
  async discard(): Promise<void> {
    await (await this.fromDisk()).discard();
  }

  seal(): void {}

  append(): Promise<void> {
    return Promise.reject(
      new Error('A workload journal is written by its workload host'),
    );
  }

  private fromDisk(): Promise<TerminalJournal> {
    this.local ??= (async () => {
      const journal = new TerminalJournal(
        this.spec.directory,
        this.spec.options,
      );
      await journal.load();
      return journal;
    })();
    return this.local;
  }
}

class WorkloadProcess implements HostedShellProcess {
  readonly journal: HostedJournal;
  private readonly outputListeners = new Set<() => void>();
  private readonly exitListeners = new Set<
    Parameters<IPtyProcess['onExit']>[0]
  >();
  private readonly unsubscribe: () => void;
  /** Its exit, once reported: an `onExit` listener added later still hears it. */
  private exit: Parameters<Parameters<IPtyProcess['onExit']>[0]>[0] | null =
    null;

  constructor(
    private readonly channel: WorkloadChannel,
    private readonly info: WorkloadInfo,
    spec: ShellJournalSpec,
  ) {
    this.journal = new HostedJournal(channel, info.workloadId, spec);
    this.unsubscribe = channel.onWorkloadEvent((event) => {
      if (event.workloadId !== info.workloadId) return;
      if (event.event === 'output') {
        for (const listener of [...this.outputListeners]) listener();
        return;
      }
      this.unsubscribe();
      const exit = {
        exitCode: event.exit.exitCode,
        signal: event.exit.signal,
        outputIncomplete:
          event.exit.outputIncomplete || event.exit.journalFailed,
      };
      this.exit = exit;
      for (const listener of [...this.exitListeners]) listener(exit);
    });
  }

  get pid(): number {
    return this.info.pid;
  }

  write(data: string): void {
    this.send({ op: 'write', workloadId: this.info.workloadId, data });
  }

  resize(cols: number, rows: number): void {
    this.send({ op: 'resize', workloadId: this.info.workloadId, cols, rows });
  }

  kill(signal?: string): void {
    this.send({
      op: 'signal',
      workloadId: this.info.workloadId,
      signal: (signal ?? 'SIGHUP') as 'SIGHUP',
    });
  }

  /** Ends the shell and everything it started; the host escalates. */
  async terminate(): Promise<void> {
    try {
      await this.channel.requestWorkload({
        op: 'terminate',
        workloadId: this.info.workloadId,
      });
    } catch (error) {
      if (!notFound(error)) throw error;
    }
  }

  /** Output is read from `journal`; this reports none. */
  onData(): () => void {
    return () => {};
  }

  onOutput(listener: () => void): () => void {
    this.outputListeners.add(listener);
    return () => this.outputListeners.delete(listener);
  }

  onExit(listener: Parameters<IPtyProcess['onExit']>[0]): () => void {
    const exit = this.exit;
    if (exit) {
      queueMicrotask(() => listener(exit));
      return () => {};
    }
    this.exitListeners.add(listener);
    return () => this.exitListeners.delete(listener);
  }

  detach(): void {
    this.unsubscribe();
    this.outputListeners.clear();
    this.exitListeners.clear();
  }

  private send(request: WorkloadRequest): void {
    // Input order is the channel's order; a refusal is logged, as a write to
    // a local PTY that has just exited is lost.
    this.channel.requestWorkload(request).catch((error: unknown) =>
      logger.warn('Terminal workload request failed', {
        op: request.op,
        error,
      }),
    );
  }
}

export class SupervisorShellHost implements ShellHost {
  constructor(
    private readonly channel: WorkloadChannel,
    private readonly configuredShell?: () =>
      | string
      | undefined
      | Promise<string | undefined>,
  ) {}

  async spawn(input: Parameters<ShellHost['spawn']>[0]): Promise<IPtyProcess> {
    // A named launch (an agent CLI, an engine sign-in) runs as the workload
    // itself, never replaced by a fallback shell.
    const candidates = await shellCandidates(
      input.launch,
      this.configuredShell,
    );
    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(
      terminalShellEnvironment(input.launch?.env),
    ))
      if (value !== undefined) env[key] = value;
    const info = (await this.channel.requestWorkload({
      op: 'spawn',
      workloadId: input.terminalId,
      kind: 'interactive',
      candidates: candidates.map((candidate) => ({
        command: candidate.shell,
        args: candidate.args ?? [],
      })),
      cwd: input.cwd,
      env,
      cols: input.cols,
      rows: input.rows,
      journal: input.journal,
    })) as WorkloadInfo;
    return new WorkloadProcess(this.channel, info, input.journal);
  }

  async attach(
    terminalId: string,
    journal: ShellJournalSpec,
  ): Promise<HostedShellProcess | null> {
    let info: WorkloadInfo;
    try {
      info = (await this.channel.requestWorkload({
        op: 'attach',
        workloadId: terminalId,
      })) as WorkloadInfo;
    } catch (error) {
      if (notFound(error)) return null;
      throw error;
    }
    // The host marks a workload exited and sends its exit event in one step,
    // and the channel keeps order, so a workload reported running here
    // reports its exit after this reply, to the listener subscribed below.
    if (info.state !== 'running') return null;
    return new WorkloadProcess(this.channel, info, journal);
  }
}

/**
 * The shell host for this core: supervisor workloads when the supervisor
 * granted them, so shells survive a core restart; otherwise node-pty in
 * this process.
 */
export function createTerminalShellHost(
  channel: WorkloadChannel | null,
  pty: IPtyAdapter,
  configuredShell?: () => string | undefined | Promise<string | undefined>,
): ShellHost {
  return channel
    ? new SupervisorShellHost(channel, configuredShell)
    : new InProcessShellHost(pty, configuredShell);
}
