/**
 * #2452: replays a REAL `muse serve` capture (Muse Code 1.3.0-R3401.1, the
 * `fixtures/muse-serve-1.3.0-*.jsonl` files, Muse Code 1.4.18, the
 * `fixtures/muse-serve-1.4.18-*.jsonl` files, and Muse Code 1.4.20, the
 * `fixtures/muse-serve-1.4.20-*.jsonl` files; all scrubbed: synthetic ids,
 * `/workspace/probe` paths, zeroed build and work hashes, and the host's own
 * reminder-agent items and session name left out) against the actual
 * `MuseAdapter`, with the host process replaced by a stream double.
 *
 * The capture is the probe's own stdio transcript: every frame the host wrote
 * (`s2c`) and every frame the probe driver sent (`c2s`). The replay writes the
 * host's frames in order, and at each request the PROBE sent that the adapter
 * also sends (`DRIVEN_METHODS`), it waits for the adapter to send the same
 * method, then answers with the captured reply under the adapter's own id.
 * Requests only the probe sent (its own diagnostics, and the
 * `session/setApprovalMode` the adapter replaces by passing the mode on
 * `session/start`) are skipped with their replies, as are the probe's own
 * replies to the host's server requests: the adapter writes its own.
 *
 * One transform, and only one: the three probes that selected the approval
 * mode AFTER `session/start` recorded that start's reply as `allowAll`. The
 * adapter selects the mode on `session/start` itself — which the fourth
 * capture (`approval-unanswered-workflow-cancel`) proves the host applies
 * (`source: startup`) — so the replayed start reply reports the mode the
 * adapter actually requested.
 */
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { PassThrough } from 'node:stream';
import type { MuseServeProcessLike } from '../adapters/muse-serve-rpc.js';

const MUSE_SERVE_CAPTURE_VERSIONS = {
  'workflow-child-approve': '1.3.0',
  'workflow-child-deny': '1.3.0',
  'workflow-child-stop': '1.3.0',
  'approval-unanswered-workflow-cancel': '1.3.0',
  // A steer joining a running turn and changing its final answer.
  steer: '1.4.18',
  // A `request_user_input` question: request + requested, answer, settled.
  'user-input': '1.4.18',
  // A one-child workflow (its `subagent` item carries the child's result)
  // and a `subagent/sendMessage` the child delivered into its reply.
  'workflow-child-steer': '1.4.18',
  // Two background shell tasks: one that finished on its own, one stopped
  // with `task/stop`; `task/list` lists each while it runs; then an idle
  // `session/compact` refused `compaction_unavailable`.
  'background-task-stop': '1.4.18',
  // A second `muse serve` process re-attaching the first one's idle session
  // with `session/resume`, then `session/resume` of an unknown id refused
  // `sessionNotFound`; `goal/resume` waking a goal turn; `session/fork`;
  // `goal/clear` (`goalChanged` null) and `goal/clear`/`goal/pause` refused
  // `missing_goal`.
  'resume-goal-fork': '1.4.18',
  // One turn, then `goal/set` on the idle session (a goal turn starts at
  // once) and `goal/pause` (`goalChanged` paused, before the ack).
  'goal-set-pause': '1.4.18',
  // One turn on a priced provider: `session/tokenUsage` carries
  // `cumulative.cost {usd, partial: false}` and `session/contextUsage` its
  // window, used tokens and pressure.
  'cost-context': '1.4.20',
} as const;

export type MuseServeCaptureName = keyof typeof MUSE_SERVE_CAPTURE_VERSIONS;

export interface MuseServeCaptureFrame {
  t: number;
  dir: string;
  msg: Record<string, unknown>;
}

export function loadMuseServeCapture(
  name: MuseServeCaptureName,
): MuseServeCaptureFrame[] {
  return readFileSync(
    new URL(
      `./fixtures/muse-serve-${MUSE_SERVE_CAPTURE_VERSIONS[name]}-${name}.jsonl`,
      import.meta.url,
    ),
    'utf8',
  )
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as MuseServeCaptureFrame);
}

/** Requests the adapter itself sends; every other probe request is skipped. */
const DRIVEN_METHODS = new Set([
  'initialize',
  'session/start',
  'turn/start',
  'turn/interrupt',
  'approval/decide',
  'subagent/stop',
  'turn/steer',
  'userInput/answer',
  'userInput/cancel',
  'subagent/sendMessage',
  'task/stop',
  'session/compact',
  'session/resume',
  'goal/pause',
  'goal/clear',
]);

export interface SentFrame {
  id?: number | string;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: unknown;
}

/** The host process double: stdin is recorded, stdout is written by the replay. */
export class FakeMuseServeHost
  extends EventEmitter
  implements MuseServeProcessLike
{
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly pid: number;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  readonly sent: SentFrame[] = [];
  stdinEnded = false;
  private readonly waiters = new Set<() => void>();
  readonly stdin = {
    write: (chunk: string): boolean => {
      for (const line of chunk.split('\n')) {
        if (!line.trim()) continue;
        this.sent.push(JSON.parse(line) as SentFrame);
      }
      for (const waiter of [...this.waiters]) waiter();
      return true;
    },
    end: (): void => {
      this.stdinEnded = true;
      // A real host exits on EOF.
      setImmediate(() => this.exit(0));
    },
  };

  constructor(
    readonly args: string[] = [],
    pid = 5151,
  ) {
    super();
    this.pid = pid;
    this.stdout.setEncoding('utf8');
    this.stderr.setEncoding('utf8');
  }

  kill(): boolean {
    this.exit(null);
    return true;
  }

  exit(code: number | null): void {
    if (this.exitCode !== null || this.signalCode !== null) return;
    this.exitCode = code ?? 0;
    this.emit('exit', code);
  }

  writeFrame(frame: Record<string, unknown>): void {
    this.stdout.write(`${JSON.stringify(frame)}\n`);
  }

  /** Resolves with the next unconsumed request of `method` the adapter sent. */
  async nextRequest(
    method: string,
    consumed: Set<SentFrame>,
    timeoutMs = 3_000,
  ): Promise<SentFrame> {
    const find = () =>
      this.sent.find(
        (frame) =>
          frame.method === method &&
          frame.id !== undefined &&
          !consumed.has(frame),
      );
    const found = find();
    if (found) return found;
    return new Promise<SentFrame>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiters.delete(check);
        reject(
          new Error(
            `The adapter never sent ${method} (sent: ${this.sent
              .map((frame) => frame.method ?? `reply#${String(frame.id)}`)
              .join(', ')})`,
          ),
        );
      }, timeoutMs);
      const check = () => {
        const frame = find();
        if (!frame) return;
        clearTimeout(timer);
        this.waiters.delete(check);
        resolve(frame);
      };
      this.waiters.add(check);
    });
  }
}

export interface ReplayOptions {
  /**
   * Called when the replay reaches a driven request, BEFORE it waits for the
   * adapter to send it — the point where a user (or Station) would act.
   * `occurrence` counts that method's driven requests from 0. Not awaited:
   * the action usually needs the replay to keep answering.
   */
  onDrivenRequest?: (
    method: string,
    occurrence: number,
    captured: Record<string, unknown>,
  ) => Promise<unknown> | undefined;
  /** Stop before this capture index (exclusive). */
  stopAt?: number;
  /** Driven methods this replay skips, as if only the probe had sent them. */
  notDriven?: ReadonlySet<string>;
}

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

/**
 * Plays `frames` into `host`. Resolves with every driven request the adapter
 * sent, in capture order, so a test can assert what it asked the host.
 */
export async function replayMuseServeCapture(
  host: FakeMuseServeHost,
  frames: MuseServeCaptureFrame[],
  options: ReplayOptions = {},
): Promise<SentFrame[]> {
  const idMap = new Map<unknown, unknown>();
  const skipped = new Set<unknown>();
  const consumed = new Set<SentFrame>();
  const occurrences = new Map<string, number>();
  const driven: SentFrame[] = [];
  const pendingActions: Promise<unknown>[] = [];
  const end = options.stopAt ?? frames.length;
  for (let index = 0; index < end; index += 1) {
    const { dir, msg } = frames[index];
    const method = typeof msg.method === 'string' ? msg.method : undefined;
    if (dir === 'c2s') {
      if (!method || msg.id === undefined) continue;
      if (!DRIVEN_METHODS.has(method) || options.notDriven?.has(method)) {
        skipped.add(msg.id);
        continue;
      }
      const occurrence = occurrences.get(method) ?? 0;
      occurrences.set(method, occurrence + 1);
      const action = options.onDrivenRequest?.(
        method,
        occurrence,
        (msg.params ?? {}) as Record<string, unknown>,
      );
      if (action) pendingActions.push(Promise.resolve(action).catch(() => {}));
      const sent = await host.nextRequest(method, consumed);
      consumed.add(sent);
      driven.push(sent);
      idMap.set(msg.id, sent.id);
      continue;
    }
    if (dir !== 's2c') continue;
    if (!method && msg.id !== undefined) {
      if (skipped.has(msg.id) || !idMap.has(msg.id)) continue;
      const reply: Record<string, unknown> = { ...msg, id: idMap.get(msg.id) };
      const request = driven.find((frame) => frame.id === reply.id);
      if (
        request?.method === 'session/start' &&
        typeof request.params?.approvalMode === 'string' &&
        reply.result &&
        typeof reply.result === 'object'
      ) {
        const result = reply.result as Record<string, unknown>;
        const session = result.session as Record<string, unknown>;
        reply.result = {
          ...result,
          session: {
            ...session,
            approvalMode: {
              ...(session.approvalMode as Record<string, unknown>),
              mode: request.params.approvalMode,
              source: 'startup',
            },
          },
        };
      }
      host.writeFrame(reply);
      await tick();
      continue;
    }
    host.writeFrame(msg);
    await tick();
  }
  await Promise.all(pendingActions);
  return driven;
}
