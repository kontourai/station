/**
 * Polls a remote task only while someone is reading it, on its connection's
 * cadence, and stops once the task is quiescent (finished, idle, or waiting
 * for the person). The work keeps running on the vendor's machines whatever
 * Station does; the tracker only catches Station up for a reader.
 *
 * - Interest: a poll runs only while a client touched the task (created it,
 *   wrote to it, synced it or read its messages) within the interest window.
 *   No reader, no polling: nothing spends the owner's vendor quota or disk
 *   unseen. After a restart nothing polls until a client reads a task again;
 *   that read resumes from the stored vendor cursor.
 * - Cadence: `nextRemoteTaskPollDelay`. Success polls after the interval; a
 *   failure doubles the delay up to the connection's `maxBackoffMs`; a rate
 *   limit waits at least as long as the vendor asked.
 * - Retried: only refusals that resolve on their own (the preview or the
 *   policy turned off, a rate limit, an unreachable vendor). Anything else
 *   (no acknowledgement or credential, a connection that is gone, a store or
 *   vendor answer Station cannot handle, or an unexpected error) stops
 *   polling the task until a client touches it again.
 */
import {
  nextRemoteTaskPollDelay,
  REMOTE_TASK_POLLING_DEFAULT,
} from '@kontourai/station-contracts/remote-task-engine';
import type { Logger } from '../../utils/logger.js';
import { FeaturePreviewDisabledError } from '../feature-previews/feature-preview-refusal.js';
import { RemoteTaskError } from './remote-task-error.js';
import type { RemoteTaskEngineService } from './service.js';

/** How long one read keeps a task polled. */
export const REMOTE_TASK_INTEREST_WINDOW_MS = 15 * 60_000;

export interface RemoteTaskTrackerOptions {
  readonly service: Pick<
    RemoteTaskEngineService,
    'syncTask' | 'isActive' | 'pollingFor'
  >;
  readonly logger: Logger;
  readonly setTimer?: (run: () => void, ms: number) => unknown;
  readonly clearTimer?: (handle: unknown) => void;
  readonly now?: () => number;
  readonly interestWindowMs?: number;
}

/** Vendor refusals that resolve on their own; retried with backoff. */
const TRANSIENT_VENDOR = new Set([
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
  readonly #interest = new Map<string, number>();
  /** Tasks stopped by a failure only a person can fix; a read does not restart them. */
  readonly #halted = new Set<string>();
  readonly #setTimer: (run: () => void, ms: number) => unknown;
  readonly #clearTimer: (handle: unknown) => void;
  readonly #now: () => number;
  readonly #windowMs: number;
  #stopped = false;

  constructor(options: RemoteTaskTrackerOptions) {
    this.#options = options;
    this.#now = options.now ?? Date.now;
    this.#windowMs = options.interestWindowMs ?? REMOTE_TASK_INTEREST_WINDOW_MS;
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

  /**
   * A client read or wrote the task: keep it polled for the interest window,
   * starting now if it is active and not already scheduled. A pending poll is
   * left alone, so a client reading every few seconds never shortens the
   * cadence.
   */
  noteInterest(
    connectionId: string,
    taskId: string,
    options: { explicit?: boolean } = {},
  ): void {
    if (this.#stopped) return;
    const id = key(connectionId, taskId);
    // A write or an explicit sync is a new attempt; a read is not, so a task
    // a vendor refused is not polled again on every read.
    if (options.explicit) this.#halted.delete(id);
    if (this.#halted.has(id)) return;
    if (!this.#options.service.isActive(connectionId, taskId)) {
      this.#interest.delete(id);
      return;
    }
    this.#interest.set(id, this.#now());
    if (this.#tracked.has(id)) return;
    this.#schedule(connectionId, taskId, 0);
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

  #schedule(connectionId: string, taskId: string, delayMs: number): void {
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

  #interested(id: string): boolean {
    const at = this.#interest.get(id);
    return at !== undefined && this.#now() - at <= this.#windowMs;
  }

  async #poll(connectionId: string, taskId: string, entry: Tracked) {
    const id = key(connectionId, taskId);
    if (this.#tracked.get(id) !== entry || this.#stopped) return;
    if (!this.#interested(id)) {
      // Nobody has read the task lately: stop until someone does.
      this.#tracked.delete(id);
      this.#interest.delete(id);
      return;
    }
    const polling =
      this.#options.service.pollingFor(connectionId) ??
      REMOTE_TASK_POLLING_DEFAULT;
    let next: number | undefined;
    let failedHard = false;
    try {
      const result = await this.#options.service.syncTask(connectionId, taskId);
      if (!result.quiescent)
        next = nextRemoteTaskPollDelay(polling, entry.delayMs, { kind: 'ok' });
    } catch (error) {
      const code = error instanceof RemoteTaskError ? error.code : undefined;
      if (
        error instanceof FeaturePreviewDisabledError ||
        code === 'remote-task-policy-refused'
      )
        next = polling.maxBackoffMs;
      else if (code === 'remote-task-rate-limited')
        next = nextRemoteTaskPollDelay(polling, entry.delayMs, {
          kind: 'rate-limited',
          ...(error instanceof RemoteTaskError &&
          error.details.retryAfterMs !== undefined
            ? { retryAfterMs: error.details.retryAfterMs }
            : {}),
        });
      else if (code !== undefined && TRANSIENT_VENDOR.has(code))
        next = nextRemoteTaskPollDelay(polling, entry.delayMs, {
          kind: 'failed',
        });
      else failedHard = true;
      this.#options.logger.warn('Remote task poll failed', {
        connectionId,
        code:
          code ??
          (error instanceof FeaturePreviewDisabledError
            ? 'feature_preview_disabled'
            : 'unexpected'),
        retryInMs: next ?? null,
      });
    }
    if (this.#tracked.get(id) !== entry) return;
    if (next === undefined || this.#stopped) {
      this.#tracked.delete(id);
      this.#interest.delete(id);
      if (failedHard) this.#halted.add(id);
      return;
    }
    this.#schedule(connectionId, taskId, next);
  }
}
