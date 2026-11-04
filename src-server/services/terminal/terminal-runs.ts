/**
 * Commands an agent asked to run in a terminal (#3994, `terminal_run`). Each
 * request is its own approval: a person approves or declines that one
 * command in that one directory, and nothing carries over to the next
 * request (owner decision: "Ask each time", no remembered approval). An
 * approved request runs once, as a `command` terminal session in the
 * agent's thread binding.
 *
 * Requests live in memory: a Station restart forgets the unanswered ones,
 * and the agent reads them as gone.
 */
import { randomUUID } from 'node:crypto';

export type TerminalRunState =
  | 'needs_approval'
  | 'declined'
  | 'expired'
  | 'starting'
  | 'running'
  | 'exited'
  | 'failed';

/** States a request can still leave. */
const OPEN_STATES: ReadonlySet<TerminalRunState> = new Set([
  'needs_approval',
  'starting',
  'running',
]);

export interface TerminalRun {
  id: string;
  conversationId: string;
  sessionId: string;
  projectId: string;
  projectSlug: string;
  /** Exactly what runs, as the person was shown it. */
  command: string;
  /** The absolute directory it runs in, as the person was shown it. */
  cwd: string;
  /** The relative directory the agent asked for, if any. */
  subdirectory?: string;
  state: TerminalRunState;
  createdAt: number;
  /** An unanswered request expires at this time. */
  expiresAt: number;
  decidedAt?: number;
  /** When an approved run exited or failed. */
  endedAt?: number;
  terminalId?: string;
  exitCode?: number | null;
  signal?: number | null;
  /** Why an approved run could not start. */
  failure?: string;
}

const TERMINAL_RUN_APPROVAL_TTL_MS = 10 * 60_000;
export const TERMINAL_RUN_MAX_PENDING_PER_CONVERSATION = 3;
export const TERMINAL_RUN_MAX_COMMAND_CHARS = 8192;
/** A run that ended is still shown to the person this long, with its exit. */
const TERMINAL_RUN_RECENT_MS = 60_000;
/** Settled requests kept per conversation, so an agent can still read one. */
const MAX_RECORDS_PER_CONVERSATION = 20;
const MAX_RECORDS = 512;

export class TerminalRunRequests {
  private readonly runs = new Map<string, TerminalRun>();
  private readonly waiters = new Map<string, Set<() => void>>();

  constructor(private readonly now: () => number = Date.now) {}

  request(input: {
    conversationId: string;
    sessionId: string;
    projectId: string;
    projectSlug: string;
    command: string;
    cwd: string;
    subdirectory?: string;
  }):
    | { outcome: 'requested'; run: TerminalRun }
    | { outcome: 'limit-reached' } {
    const pending = this.forConversation(input.conversationId).filter(
      (run) => run.state === 'needs_approval',
    );
    if (pending.length >= TERMINAL_RUN_MAX_PENDING_PER_CONVERSATION)
      return { outcome: 'limit-reached' };
    const at = this.now();
    const run: TerminalRun = {
      id: randomUUID(),
      ...input,
      state: 'needs_approval',
      createdAt: at,
      expiresAt: at + TERMINAL_RUN_APPROVAL_TTL_MS,
    };
    this.runs.set(run.id, run);
    this.prune(input.conversationId);
    return { outcome: 'requested', run: { ...run } };
  }

  get(id: string): TerminalRun | undefined {
    const run = this.runs.get(id);
    if (!run) return undefined;
    this.expire(run);
    return { ...run };
  }

  /** The conversation's retained requests, oldest first. */
  forConversation(conversationId: string): TerminalRun[] {
    return [...this.runs.values()]
      .filter((run) => run.conversationId === conversationId)
      .map((run) => {
        this.expire(run);
        return { ...run };
      })
      .sort((a, b) => a.createdAt - b.createdAt);
  }

  /**
   * The conversation's requests a person can still act on or watch, and the
   * approved runs that ended within `TERMINAL_RUN_RECENT_MS`.
   */
  visibleForConversation(conversationId: string): TerminalRun[] {
    const since = this.now() - TERMINAL_RUN_RECENT_MS;
    return this.forConversation(conversationId).filter(
      (run) =>
        OPEN_STATES.has(run.state) ||
        (run.endedAt !== undefined && run.endedAt >= since),
    );
  }

  /**
   * A person's approval claims the request (`needs_approval` -> `starting`)
   * exactly once; a second Approve, a Decline after it, or an expired request
   * finds nothing to claim.
   */
  claim(id: string): TerminalRun | undefined {
    const run = this.runs.get(id);
    if (!run) return undefined;
    this.expire(run);
    if (run.state !== 'needs_approval') return undefined;
    this.transition(run, { state: 'starting', decidedAt: this.now() });
    return { ...run };
  }

  decline(id: string): boolean {
    const run = this.runs.get(id);
    if (!run) return false;
    this.expire(run);
    if (run.state !== 'needs_approval') return false;
    this.transition(run, { state: 'declined', decidedAt: this.now() });
    return true;
  }

  started(
    id: string,
    terminalId: string,
    exited: Promise<{ exitCode: number | null; signal: number | null }>,
  ): void {
    const run = this.runs.get(id);
    if (run?.state !== 'starting') return;
    this.transition(run, { state: 'running', terminalId });
    void exited.then(
      (exit) =>
        this.transition(run, {
          state: 'exited',
          exitCode: exit.exitCode,
          signal: exit.signal,
          endedAt: this.now(),
        }),
      (error: unknown) =>
        this.transition(run, {
          state: 'failed',
          failure: error instanceof Error ? error.message : String(error),
          endedAt: this.now(),
        }),
    );
  }

  failed(id: string, failure: string): void {
    const run = this.runs.get(id);
    if (run?.state === 'starting')
      this.transition(run, { state: 'failed', failure, endedAt: this.now() });
  }

  /**
   * Resolves once the request changes state, `timeoutMs` passes or it
   * expires, whichever is first.
   */
  waitForChange(id: string, timeoutMs: number): Promise<void> {
    const run = this.runs.get(id);
    if (!run || !OPEN_STATES.has(run.state)) return Promise.resolve();
    const limit =
      run.state === 'needs_approval'
        ? Math.min(timeoutMs, Math.max(0, run.expiresAt - this.now()))
        : timeoutMs;
    return new Promise((done) => {
      const listeners = this.waiters.get(id) ?? new Set();
      this.waiters.set(id, listeners);
      const finish = () => {
        clearTimeout(timer);
        listeners.delete(finish);
        if (listeners.size === 0) this.waiters.delete(id);
        done();
      };
      const timer = setTimeout(finish, limit);
      timer.unref?.();
      listeners.add(finish);
    });
  }

  private expire(run: TerminalRun): void {
    if (run.state === 'needs_approval' && this.now() >= run.expiresAt)
      this.transition(run, { state: 'expired' });
  }

  private transition(run: TerminalRun, patch: Partial<TerminalRun>): void {
    Object.assign(run, patch);
    for (const listener of [...(this.waiters.get(run.id) ?? [])]) listener();
  }

  /** Forgets the oldest settled requests past the per-conversation and total bounds. */
  private prune(conversationId: string): void {
    const settled = (runs: Iterable<TerminalRun>) =>
      [...runs]
        .filter((run) => !OPEN_STATES.has(run.state))
        .sort((a, b) => a.createdAt - b.createdAt);
    const own = [...this.runs.values()].filter(
      (run) => run.conversationId === conversationId,
    );
    for (const run of settled(own).slice(
      0,
      Math.max(0, own.length - MAX_RECORDS_PER_CONVERSATION),
    ))
      this.runs.delete(run.id);
    for (const run of settled(this.runs.values()).slice(
      0,
      Math.max(0, this.runs.size - MAX_RECORDS),
    ))
      this.runs.delete(run.id);
  }
}
