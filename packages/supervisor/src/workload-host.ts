/**
 * The supervisor's side of workloads (protocol 1.3): it starts the workload
 * host, relays requests to it, keeps a small registry of what it runs, and
 * stops it with the supervisor.
 *
 * The host is a child process started from the build root, because the PTYs
 * it owns need node-pty, a native addon this bundle cannot carry. It outlives
 * every core generation and dies with the supervisor: on Windows a
 * non-detached child is in the supervisor's kill-on-close job; everywhere it
 * ends its workloads and exits when its IPC channel closes.
 */
import { type ChildProcess, fork } from 'node:child_process';
import {
  isWorkloadEventMessage,
  type WorkloadErrorCode,
  type WorkloadEventMessage,
  type WorkloadExit,
  type WorkloadInfo,
  type WorkloadResponseMessage,
  type WorkloadStatus,
} from './protocol.ts';

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown
  ? Omit<T, K>
  : never;
/** A `workload.response` without its envelope. */
export type WorkloadReply = DistributiveOmit<
  WorkloadResponseMessage,
  'id' | 'type'
>;

const OPS = new Set([
  'spawn',
  'write',
  'resize',
  'signal',
  'terminate',
  'list',
  'attach',
  'read',
  'flush',
]);

/** The host must say `host.ready` within this time of starting. */
const HOST_READY_TIMEOUT_MS = 30_000;
/** `host.stop` ends every workload (each escalates within ~6 s); then it is killed. */
const HOST_STOP_TIMEOUT_MS = 15_000;
/** Exited workloads kept in the registry for `status`. */
const EXITED_KEPT = 64;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function failure(code: WorkloadErrorCode, message: string): WorkloadReply {
  return { ok: false, code, message };
}

export interface WorkloadHostOptions {
  /** The host entry, inside the build root; null when this build has none. */
  entry: string | null;
  log: (message: string) => void;
  onEvent: (event: WorkloadEventMessage) => void;
}

export class WorkloadHost {
  private child: ChildProcess | null = null;
  private starting: Promise<ChildProcess> | null = null;
  private nextId = 1;
  private readonly pending = new Map<string, (reply: WorkloadReply) => void>();
  private readonly registry = new Map<string, WorkloadStatus>();
  private stopped = false;
  private readonly options: WorkloadHostOptions;

  constructor(options: WorkloadHostOptions) {
    this.options = options;
  }

  /** Whether workloads can be offered to a generation at all. */
  get available(): boolean {
    return this.options.entry !== null && !this.stopped;
  }

  status(): WorkloadStatus[] {
    return [...this.registry.values()].map((entry) => ({ ...entry }));
  }

  /**
   * Relays one request to the host and calls `reply` with its answer. The
   * answer is passed on in the same turn the host's reply arrives, so a
   * workload event the host sent after it cannot overtake it on the way to
   * the core (Node delivers several IPC messages in one turn).
   */
  request(request: unknown, reply: (reply: WorkloadReply) => void): void {
    if (!isRecord(request) || typeof request.op !== 'string') {
      reply(failure('bad-request', 'a workload request needs an op'));
      return;
    }
    const op = request.op;
    if (!OPS.has(op)) {
      reply(failure('bad-request', `unknown workload op ${op}`));
      return;
    }
    if (!this.available) {
      reply(failure('unavailable', 'this supervisor runs no workload host'));
      return;
    }
    const forward = (child: ChildProcess) => {
      const id = String(this.nextId++);
      this.pending.set(id, (answer) => {
        if (answer.ok) this.remember(op, answer.result);
        reply(answer);
      });
      child.send({ type: 'workload.request', id, request }, (error) => {
        const settle = this.pending.get(id);
        if (error && settle) {
          this.pending.delete(id);
          settle(failure('unavailable', String(error)));
        }
      });
    };
    if (this.child) {
      forward(this.child);
      return;
    }
    // Only a spawn starts the host. With no host, there is nothing to list
    // and no workload to address.
    if (op === 'list') {
      reply({ ok: true, result: [] });
      return;
    }
    if (op !== 'spawn') {
      reply(failure('not-found', 'no such workload'));
      return;
    }
    this.start().then(forward, (error: unknown) =>
      reply(failure('unavailable', String(error))),
    );
  }
  /** Ends every workload and the host. Idempotent. */
  async stop(): Promise<void> {
    this.stopped = true;
    const child = this.child ?? (await this.starting?.catch(() => null));
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    const exited = new Promise<void>((resolve) => child.once('exit', resolve));
    if (child.connected) child.send({ type: 'host.stop' });
    else child.kill('SIGTERM');
    const timer = setTimeout(() => {
      this.options.log('workload host did not stop in time; killing it');
      child.kill('SIGKILL');
    }, HOST_STOP_TIMEOUT_MS);
    await exited;
    clearTimeout(timer);
  }

  private start(): Promise<ChildProcess> {
    this.starting ??= new Promise<ChildProcess>((resolve, reject) => {
      const entry = this.options.entry as string;
      const child = fork(entry, [], {
        // The host's environment is the supervisor's; every workload gets
        // the environment its request names.
        execArgv: [],
        stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
        serialization: 'json',
        windowsHide: true,
      });
      this.options.log(
        `workload host started (pid ${child.pid ?? 'unknown'}) entry=${entry}`,
      );
      const timer = setTimeout(() => {
        reject(new Error('the workload host did not become ready'));
        child.kill('SIGKILL');
      }, HOST_READY_TIMEOUT_MS);
      child.on('message', (message: unknown) => {
        if (!isRecord(message)) return;
        if (message.type === 'host.ready') {
          clearTimeout(timer);
          this.child = child;
          resolve(child);
          return;
        }
        this.onHostMessage(message);
      });
      child.on('error', (error) =>
        this.options.log(`workload host process error: ${String(error)}`),
      );
      child.once('exit', (code, signal) => {
        clearTimeout(timer);
        reject(new Error(`the workload host exited (${code ?? signal})`));
        this.onHostExit(child, code, signal);
      });
    });
    return this.starting;
  }

  private onHostMessage(message: Record<string, unknown>): void {
    if (
      message.type === 'workload.response' &&
      typeof message.id === 'string'
    ) {
      const settle = this.pending.get(message.id);
      if (!settle) return;
      this.pending.delete(message.id);
      const { id: _id, type: _type, ...reply } = message;
      settle(reply as WorkloadReply);
      return;
    }
    if (isWorkloadEventMessage(message)) {
      if (message.event === 'exit') this.markExited(message.workloadId);
      this.options.onEvent(message);
    }
  }

  private onHostExit(
    child: ChildProcess,
    code: number | null,
    signal: string | null,
  ): void {
    if (this.child !== null && this.child !== child) return;
    this.child = null;
    this.starting = null;
    if (!this.stopped) {
      this.options.log(
        `workload host exited unexpectedly (code=${code} signal=${signal}); its workloads ended with it`,
      );
    }
    for (const settle of this.pending.values()) {
      settle(failure('unavailable', 'the workload host exited'));
    }
    this.pending.clear();
    // Its PTYs and pipes closed with it, so every workload it ran has ended.
    const exit: WorkloadExit = {
      exitCode: -1,
      signal: null,
      outputIncomplete: true,
      journalFailed: false,
    };
    for (const entry of this.registry.values()) {
      if (entry.state !== 'running') continue;
      this.markExited(entry.workloadId);
      this.options.onEvent({
        type: 'workload.event',
        workloadId: entry.workloadId,
        event: 'exit',
        exit,
      });
    }
  }

  private remember(op: string, result: unknown): void {
    const infos =
      op === 'list' && Array.isArray(result)
        ? result
        : (op === 'spawn' || op === 'attach') && isRecord(result)
          ? [result]
          : [];
    for (const info of infos as WorkloadInfo[]) {
      if (!isRecord(info) || typeof info.workloadId !== 'string') continue;
      this.registry.set(info.workloadId, {
        workloadId: info.workloadId,
        kind: info.kind,
        pid: info.pid,
        state: info.state,
      });
    }
    this.trim();
  }

  private markExited(workloadId: string): void {
    const entry = this.registry.get(workloadId);
    if (entry) entry.state = 'exited';
    this.trim();
  }

  private trim(): void {
    const exited = [...this.registry.values()].filter(
      (entry) => entry.state === 'exited',
    );
    for (const entry of exited.slice(
      0,
      Math.max(0, exited.length - EXITED_KEPT),
    ))
      this.registry.delete(entry.workloadId);
  }
}
