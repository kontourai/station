/**
 * EventBus — typed pub/sub for server-side state changes.
 * Any service can emit; the SSE endpoint subscribes and pushes to clients.
 */

import type { ServerEventName } from '@kontourai/station-contracts/runtime-events';

export interface ServerEvent {
  event: ServerEventName;
  data?: Record<string, unknown>;
}

type Listener = (event: ServerEvent) => void;

/**
 * How long one listener's repeated failure stays quiet before it is warned
 * about again (archive#1284, round-3 review MEDIUM 4). Long enough that a
 * per-token failure on `content.text-delta` cannot flood the console;
 * short enough that a persistent problem keeps announcing itself.
 */
const LISTENER_FAILURE_WARN_INTERVAL_MS = 60_000;

/**
 * The floor between warnings when the failure MESSAGE changes. A new failure
 * mode is news and should not wait out the interval above, but "news" cannot
 * be allowed to mean "every emit" — a message carrying per-event data (an
 * event id, a thread id) is otherwise distinct every time, which is the same
 * unbounded flood by another route.
 */
const LISTENER_FAILURE_DISTINCT_WARN_INTERVAL_MS = 1_000;

interface ListenerFailureState {
  lastWarnedAt: number;
  lastMessage: string;
  /** Failures swallowed since the last warning, reported in the next one. */
  suppressed: number;
}

export class EventBus {
  private listeners = new Set<Listener>();
  /**
   * Per-listener throttle state. A `WeakMap` on purpose: an unsubscribed
   * listener's entry is collectable, and nothing here keeps a listener alive.
   */
  private readonly listenerFailures = new WeakMap<
    Listener,
    ListenerFailureState
  >();

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /**
   * A listener that throws KEEPS ITS SUBSCRIPTION (archive#1284, HIGH 3).
   *
   * This bus previously deleted the throwing listener. Every subscriber
   * here is a boot-wired infrastructure singleton — the SSE fan-out, the
   * console bridge, web push, turn-completion notifications, the approval
   * inbox. None of them monitors its own removal and none re-subscribes, so
   * deletion was permanent, silent subsystem death announced at
   * `console.debug`: one transient `SQLITE_BUSY` inside the approval
   * inbox's handler and no approval notification would ever be created or
   * cleared again for the lifetime of the process.
   *
   * The only defensible purpose deletion could serve — stopping one
   * poisoned listener from breaking delivery to the others — is already
   * fully achieved by the `try/catch` alone. Deletion added nothing but the
   * amplification. A persistently-throwing listener now produces repeated
   * `warn`s: observable and diagnosable, which a deleted one is not.
   *
   * Deliberately NO failure-count eviction: that is the same footgun with a
   * fuse on it.
   *
   * The WARNING is rate-limited per listener (round-3 review, MEDIUM 4).
   * Keeping the subscription is right; warning once per delivery was not
   * considered on the noise axis. This bus carries `content.text-delta` —
   * one emit per streamed token — so a listener that throws every time
   * produced one `console.warn` per token per stream, for the life of the
   * process. That is not "observable and diagnosable"; it buries the log it
   * was supposed to inform. Repeats now collapse into one warning per
   * minute per listener, carrying the count of failures suppressed since
   * the previous one, so the signal is preserved and its volume is bounded.
   */
  emit(event: ServerEventName, data?: Record<string, unknown>): void {
    const evt: ServerEvent = { event, data };
    for (const fn of this.listeners) {
      try {
        fn(evt);
      } catch (e) {
        this.warnListenerFailure(fn, event, e);
      }
    }
  }

  private warnListenerFailure(
    listener: Listener,
    event: ServerEventName,
    error: unknown,
  ): void {
    const message = error instanceof Error ? error.message : String(error);
    const now = Date.now();
    const state = this.listenerFailures.get(listener);
    const sinceLastWarning = state
      ? now - state.lastWarnedAt
      : Number.POSITIVE_INFINITY;
    const shouldWarn =
      !state ||
      sinceLastWarning >= LISTENER_FAILURE_WARN_INTERVAL_MS ||
      (message !== state.lastMessage &&
        sinceLastWarning >= LISTENER_FAILURE_DISTINCT_WARN_INTERVAL_MS);

    if (!shouldWarn) {
      if (state) state.suppressed += 1;
      return;
    }

    const suppressed = state?.suppressed ?? 0;
    this.listenerFailures.set(listener, {
      lastWarnedAt: now,
      lastMessage: message,
      suppressed: 0,
    });
    console.warn(
      'Event listener threw; keeping the subscription:',
      event,
      error,
      ...(suppressed > 0
        ? [`(${suppressed} further failures suppressed since the last warning)`]
        : []),
    );
  }
}
