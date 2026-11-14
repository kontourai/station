/**
 * Polls each active remote task on its connection's cadence and stops once
 * the task is quiescent (finished, idle, or waiting for the person). The
 * work keeps running on the vendor's machines whatever Station does; the
 * tracker only catches Station up.
 *
 * - Cadence: `nextRemoteTaskPollDelay`. Success polls after the interval; a
 *   failure doubles the delay up to the connection's `maxBackoffMs`; a rate
 *   limit waits at least as long as the vendor asked.
 * - Preview and policy: each poll goes through the service's gate. A poll
 *   refused because the preview or the policy is off sends nothing and is
 *   retried after the backoff ceiling, so turning the preview back on
 *   resumes tracking without a restart. A refusal that only a person can fix
 *   (no acknowledgement, no credential, a connection that is gone) stops
 *   tracking the task until the next explicit sync.
 * - Restart: {@link RemoteTaskTracker.resume} re-schedules every stored task
 *   still marked active; each sync continues from the stored vendor cursor.
 */
import {
  nextRemoteTaskPollDelay,
  REMOTE_TASK_POLLING_DEFAULT,
} from '@kontourai/station-contracts/remote-task-engine';
import type { Logger } from '../../utils/logger.js';
import { RemoteTaskError } from './remote-task-error.js';
import type { RemoteTaskEngineService } from './service.js';

export interface RemoteTaskTrackerOptions {
  readonly service: Pick<
    RemoteTaskEngineService,
    'syncTask' | 'activeTasks' | 'pollingFor'
  >;
  readonly logger: Logger;
  readonly setTimer?: (run: () => void, ms: number) => unknown;
  readonly clearTimer?: (handle: unknown) => void;
}

/** Refusals that resolve on their own (the gate or the vendor); retried. */
const TRANSIENT = new Set([
  'feature_preview_disabled',
  'remote-task-policy-refused',
  'remote-task-rate-limited',
  'remote-task-vendor-unavailable',
]);

interface Tracked {
  handle: unknown;
  delayMs: number;
}

function key(connectionId: string, taskId: string): string {
  return `${connectionId}\u0000${taskId}`;
}

export class RemoteTaskTracker {
  readonly #options: RemoteTaskTrackerOptions;
  readonly #tracked = new Map<string, Tracked>();
  readonly #setTimer: (run: () => void, ms: number) => unknown;
  readonly #clearTimer: (handle: unknown) => void;
  #stopped = false;

  constructor(options: RemoteTaskTrackerOptions) {
    this.#options = options;
    this.#setTimer =
      options.setTimer ??
      ((run, ms) => {
        const timer = setTimeout(run, ms);
        timer.unref?.();
        return timer;
      });
    this.#clearTimer =
      options.clearTimer ??
      ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
  }

  /** Re-schedule every stored task still active (after a restart). */
  resume(): void {
    for (const { connectionId, taskId } of this.#options.service.activeTasks())
      this.track(connectionId, taskId, 0);
  }

  /** Poll `taskId` after `delayMs` (default: now), replacing any pending poll. */
  track(connectionId: string, taskId: string, delayMs = 0): void {
    if (this.#stopped) return;
    const id = key(connectionId, taskId);
    const existing = this.#tracked.get(id);
    if (existing) this.#clearTimer(existing.handle);
    const entry: Tracked = { handle: undefined, delayMs };
    entry.handle = this.#setTimer(
      () => void this.#poll(connectionId, taskId, entry),
      delayMs,
    );
    this.#tracked.set(id, entry);
  }

  isTracking(connectionId: string, taskId: string): boolean {
    return this.#tracked.has(key(connectionId, taskId));
  }

  /** Stops every pending poll. Tasks keep running at the vendor. */
  stop(): void {
    this.#stopped = true;
    for (const entry of this.#tracked.values()) this.#clearTimer(entry.handle);
    this.#tracked.clear();
  }

  async #poll(connectionId: string, taskId: string, entry: Tracked) {
    const id = key(connectionId, taskId);
    if (this.#tracked.get(id) !== entry || this.#stopped) return;
    const polling =
      this.#options.service.pollingFor(connectionId) ??
      REMOTE_TASK_POLLING_DEFAULT;
    let next: number | undefined;
    try {
      const result = await this.#options.service.syncTask(connectionId, taskId);
      if (!result.quiescent)
        next = nextRemoteTaskPollDelay(polling, entry.delayMs, { kind: 'ok' });
    } catch (error) {
      const code = error instanceof RemoteTaskError ? error.code : undefined;
      if (code === 'feature_preview_disabled' || code === 'remote-task-policy-refused')
        next = polling.maxBackoffMs;
      else if (code === 'remote-task-rate-limited')
        next = nextRemoteTaskPollDelay(polling, entry.delayMs, {
          kind: 'rate-limited',
          ...(error instanceof RemoteTaskError &&
          error.details.retryAfterMs !== undefined
            ? { retryAfterMs: error.details.retryAfterMs }
            : {}),
        });
      else if (code === undefined || TRANSIENT.has(code))
        next = nextRemoteTaskPollDelay(polling, entry.delayMs, {
          kind: 'failed',
        });
      this.#options.logger.warn('Remote task poll failed', {
        connectionId,
        code: code ?? 'error',
        retryInMs: next ?? null,
      });
    }
    if (this.#tracked.get(id) !== entry) return;
    if (next === undefined || this.#stopped) {
      this.#tracked.delete(id);
      return;
    }
    this.track(connectionId, taskId, next);
  }
}
