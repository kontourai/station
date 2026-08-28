import type { CanonicalRuntimeEvent } from '@kontourai/station-contracts/runtime-events';

/**
 * Batches streamed content deltas so one model token stops costing one of
 * everything.
 *
 * Every event reaching `projectAndPublishEvent` pays a read-model projection,
 * a SQLite `SAVEPOINT` + `INSERT` + four projections (FTS5 among them), an
 * execution-coordinator observation, a monitoring bridge call, a recovery
 * observation, and a synchronous bus fan-out — after which each connected SSE
 * client pays its own point lookup and frame. Text deltas arrive per token, so
 * that whole chain ran per token, and the client re-rendered per token.
 *
 * It also blew the resume budgets: a reconnect replays at most
 * ORCHESTRATION_STREAM_RESUME_GAP_THRESHOLD (1000) events or
 * REPLAY_MAX_SERIALIZED_BYTES (96_000) bytes, both of which a single ordinary
 * turn exhausts when every token is an event.
 *
 * Merging is confined to deltas that agree on every identity the event
 * carries — method, thread, turn AND `itemId` — so every field of the merged
 * event is true of every delta inside it, and the only field that changes is
 * the one that accumulates by concatenation. (An earlier revision merged
 * across `itemId` on the grounds that today's two readers concatenate and
 * ignore it; that is a fact about today's readers, not a property of the
 * event, and a persisted `itemId` naming one item while the text spans
 * several is a durable field asserting something untrue.) Nothing here
 * changes the wire shape — a merged delta is still a delta.
 *
 * ORDERING IS THE INVARIANT. A buffered delta must never appear after an event
 * that was produced later, so anything that is not a coalescable delta for
 * that thread flushes it first. That is what keeps a tool call, an approval, a
 * turn boundary and an error in their true positions relative to the text.
 */

/** Methods whose payloads accumulate by concatenation, and so may merge. */
const COALESCABLE = new Set(['content.text-delta', 'content.reasoning-delta']);

/**
 * How many convergence passes `flushAll` will make before giving up. A flush
 * fans out synchronously, so a listener may publish a further delta while the
 * sweep is running; the loop exists to catch that, and the bound exists so a
 * pathological producer cannot spin the process forever.
 */
const FLUSH_ALL_MAX_PASSES = 32;

/** One warning per interval per coalescer, mirroring the event bus's bound. */
const DELIVERY_FAILURE_WARN_INTERVAL_MS = 60_000;

interface CoalescerLogger {
  warn(message: string, meta?: Record<string, unknown>): void;
}

export interface DeltaCoalescerOptions {
  /**
   * How long a delta may wait for a successor. Small enough to stay
   * imperceptible in the transcript, large enough that a fast stream collapses
   * many tokens into one event.
   */
  windowMs?: number;
  /**
   * Flush once the buffered text reaches this size regardless of the window,
   * so a burst cannot build an unbounded event. It bounds event SIZE and
   * nothing else: at the default window a stream would have to sustain
   * >130k chars/sec to reach the cap first, and time-to-first-token is
   * governed by the first-delta pass-through below, not by this.
   */
  maxChars?: number;
  /** Injected in tests; real callers use the module default. */
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
  /**
   * Warned to when a delivery throws on a path that has no caller frame to
   * catch for it. See `deliver` for which paths those are and which
   * deliberately propagate instead.
   */
  logger?: CoalescerLogger;
}

/**
 * What a delivery failure does. `propagate` is for a delivery made
 * synchronously from `offer`, where the adapter-event loop above is already
 * the failure handler; `warn` is for the timer and shutdown paths, which have
 * no such frame.
 */
type DeliveryFailureMode = 'propagate' | 'warn';

interface Pending {
  event: CanonicalRuntimeEvent;
  text: string;
  timer: unknown;
}

/**
 * Whether this event is one the coalescer will batch. Exported so a caller
 * that must observe the RAW stream (turn-stall progress) can tell which events
 * it will otherwise only see merged.
 */
export function isCoalescableDelta(event: CanonicalRuntimeEvent): boolean {
  return COALESCABLE.has(event.method) && deltaTextOf(event) !== undefined;
}

function deltaTextOf(event: CanonicalRuntimeEvent): string | undefined {
  const delta = (event as unknown as { delta?: unknown }).delta;
  return typeof delta === 'string' ? delta : undefined;
}

/**
 * The identity of the run of text a delta belongs to, within its thread.
 * Deltas merge only within one of these, and the first delta of one is never
 * held.
 */
function streamKeyOf(event: CanonicalRuntimeEvent): string {
  const { turnId, itemId } = event as { turnId?: string; itemId?: string };
  return `${event.method}\u0000${turnId ?? ''}\u0000${itemId ?? ''}`;
}

/**
 * Two deltas merge only when they are the same kind of delta, on the same
 * thread, in the same turn, and part of the same item. Anything else — a
 * different turn, a different item, a different method — is a different
 * stream of text and must not be concatenated into its neighbour.
 */
function mergeable(
  a: CanonicalRuntimeEvent,
  b: CanonicalRuntimeEvent,
): boolean {
  return a.threadId === b.threadId && streamKeyOf(a) === streamKeyOf(b);
}

export class DeltaCoalescer {
  private readonly pending = new Map<string, Pending>();
  /** threadId -> the stream whose first delta has already been delivered. */
  private readonly streamStarts = new Map<string, string>();
  private readonly windowMs: number;
  private readonly maxChars: number;
  private readonly setTimer: (fn: () => void, ms: number) => unknown;
  private readonly clearTimer: (handle: unknown) => void;
  private readonly logger: CoalescerLogger;
  private lastDeliveryWarningAt = 0;
  private suppressedDeliveryFailures = 0;

  constructor(
    private readonly emit: (event: CanonicalRuntimeEvent) => void,
    options: DeltaCoalescerOptions = {},
  ) {
    this.windowMs = options.windowMs ?? 60;
    this.maxChars = options.maxChars ?? 8_000;
    this.setTimer =
      options.setTimer ??
      ((fn, ms) => {
        const handle = setTimeout(fn, ms);
        // A pending delta must never hold the process open by itself; the
        // flush paths below are what guarantee it is not lost.
        (handle as unknown as { unref?: () => void }).unref?.();
        return handle;
      });
    this.clearTimer = options.clearTimer ?? ((h) => clearTimeout(h as never));
    this.logger = options.logger ?? {
      // Only reached by a caller that supplied no logger; a swallowed
      // delivery failure with nothing written anywhere is the one outcome
      // this must not have.
      warn: (message, meta) => console.warn(message, meta),
    };
  }

  /**
   * Offer an event. Returns true when the coalescer took ownership of it (the
   * caller must NOT publish it); false when the caller should publish as
   * normal — after this call, which has already flushed anything buffered for
   * that thread.
   */
  offer(event: CanonicalRuntimeEvent): boolean {
    const text = COALESCABLE.has(event.method) ? deltaTextOf(event) : undefined;

    if (text === undefined) {
      // Not coalescable: whatever is buffered for this thread happened first.
      this.flushPending(event.threadId, 'propagate');
      // A tool call, an approval or a turn boundary ends the current run of
      // text, so whatever text comes next is a fresh paint, not a
      // continuation of what this event interrupted — UNLESS the flush above
      // re-buffered. See `dropMarkerIfIdle`.
      this.dropMarkerIfIdle(event.threadId);
      return false;
    }

    const current = this.pending.get(event.threadId);
    if (current && !mergeable(current.event, event)) {
      // A different turn, item or kind of delta: not the same text.
      this.flushPending(event.threadId, 'propagate');
    }

    // The FIRST delta of a run of text is never held. Batching starts with
    // the second, so time-to-first-token is exactly what it was before this
    // coalescer existed and the window only ever delays text the reader is
    // already reading.
    const stream = streamKeyOf(event);
    if (this.streamStarts.get(event.threadId) !== stream) {
      this.streamStarts.set(event.threadId, stream);
      this.deliver(event, 'propagate');
      return true;
    }

    const existing = this.pending.get(event.threadId);
    if (!existing) {
      this.pending.set(event.threadId, {
        event,
        text,
        timer: this.setTimer(
          () => this.flushThread(event.threadId),
          this.windowMs,
        ),
      });
    } else {
      existing.text += text;
    }

    const held = this.pending.get(event.threadId);
    if (held && held.text.length >= this.maxChars)
      this.flushPending(event.threadId, 'propagate');
    return true;
  }

  /**
   * Emit whatever is buffered for one thread, in order. This is the
   * no-caller-frame form — the window timer, `flushAll`, a quarantine — so a
   * failed delivery warns rather than propagating. The flushes `offer` makes
   * on its own synchronous path deliberately do not come through here; see
   * `deliver`.
   */
  flushThread(threadId: string): void {
    this.flushPending(threadId, 'warn');
  }

  /**
   * Drop every trace of one thread. It flushes first, so this can never be
   * the thing that silently deletes text the model produced; then it clears
   * the first-paint marker, which `offer` only removes when a non-coalescable
   * event arrives — so a thread that dies mid-stream leaves one behind
   * forever. `pending` self-cleans on every flush; this did not.
   */
  forgetThread(threadId: string): void {
    this.flushThread(threadId);
    this.dropMarkerIfIdle(threadId);
  }

  /**
   * Drop a thread's first-paint marker, but only while the thread is holding
   * no text.
   *
   * Every caller of this runs AFTER a flush, and a flush fans out
   * synchronously: a listener can publish a further delta for the same thread
   * while the flush is still on the stack, and that delta buffers. Dropping
   * the marker then leaves the thread holding text with no marker, and the
   * next delta takes the first-paint branch in `offer` and publishes
   * IMMEDIATELY — ahead of the text already buffered, which was produced
   * first. That is the one thing this module's ordering invariant forbids.
   *
   * Keeping the marker costs a map entry until the thread's next flush; the
   * alternative costs the transcript its order.
   */
  private dropMarkerIfIdle(threadId: string): void {
    if (!this.pending.has(threadId)) this.streamStarts.delete(threadId);
  }

  private flushPending(threadId: string, onFailure: DeliveryFailureMode): void {
    const held = this.pending.get(threadId);
    if (!held) return;
    this.pending.delete(threadId);
    this.clearTimer(held.timer);
    this.deliver(
      { ...held.event, delta: held.text } as CanonicalRuntimeEvent,
      onFailure,
    );
  }

  /**
   * Emit everything buffered, for every thread. Shutdown and disposal must
   * call this: a delta still in the buffer is text the model produced and the
   * operator never saw.
   *
   * It converges rather than sweeping a snapshot once: a flush's synchronous
   * fan-out can re-enter with a delta for a thread the snapshot never held,
   * and on the shutdown path that buffer would then be the lost text this
   * exists to prevent.
   */
  flushAll(): void {
    try {
      for (let pass = 0; this.pending.size > 0; pass += 1) {
        if (pass >= FLUSH_ALL_MAX_PASSES) {
          // Giving up with buffers still held would make this the lost text it
          // exists to prevent, so make one final best-effort emit over a
          // snapshot of the keys. It is bounded because it never revisits what
          // that pass re-buffers — and the warning below then reports what
          // genuinely remains rather than what was about to be dropped.
          for (const threadId of [...this.pending.keys()])
            this.flushThread(threadId);
          try {
            this.logger.warn(
              'Delta coalescing flush did not converge; buffered content deltas remain unpublished',
              { passes: pass, pendingThreads: this.pending.size },
            );
          } catch {
            // Same torn-down-pino case `warnDeliveryFailure` guards for, and
            // the same nowhere-left-to-report answer. `shutdown` calls this
            // inside a catch that warns through this SAME logger and rethrows,
            // so an escape here escapes `shutdown()` itself.
          }
          return;
        }
        for (const threadId of [...this.pending.keys()])
          this.flushThread(threadId);
      }
    } finally {
      // A thread with nothing buffered has no run of text in progress, and
      // retaining its marker only leaks one entry per thread that never
      // produced a terminal event. A thread that IS still buffered keeps its
      // marker: the bounded path above can return with text held, and
      // dropping the marker there would let the next delta paint ahead of it.
      for (const threadId of [...this.streamStarts.keys()])
        this.dropMarkerIfIdle(threadId);
    }
  }

  /** Threads currently holding buffered text. Diagnostics only. */
  pendingThreadCount(): number {
    return this.pending.size;
  }

  /**
   * Threads holding a first-paint marker. Diagnostics only — but unlike
   * `pending`, this map is not emptied by flushing, so it is the one whose
   * growth is worth being able to assert on.
   */
  trackedThreadCount(): number {
    return this.streamStarts.size;
  }

  /**
   * Hand one event to the publish chain.
   *
   * On the TIMER and shutdown paths a throw must not propagate: those
   * callbacks have no caller frame, so an escaping error would reach
   * `uncaughtException` and take the whole server down for one undeliverable
   * delta. Those deliver with `warn` — the event bus's listener contract:
   * keep going, warn, stay usable, rate-limited because this carries one
   * delivery per stream window.
   *
   * A delivery made synchronously from `offer` is NOT one of those. Its caller
   * is `consumeAdapterEvents`, whose catch already classifies a SQLITE_BUSY as
   * store contention (archive#3304): it counts
   * `orchestrationStoreContentionObserved`, publishes a `runtime.error` naming
   * the locked store so the operator can find the second Station process, and
   * restarts the stream. Deltas are the bulk of a turn and so the likeliest
   * event to hit BUSY first; swallowing them here would make the whole
   * mechanism unreachable in practice and replace a user-visible error with a
   * server-log line nobody reads. Those deliver with `propagate`.
   *
   * What a propagating throw leaves behind is `pending`-clean only: the buffer
   * is dropped before the delivery is attempted, so no thread is left holding
   * stale text. The first-paint MARKER is a different matter — the first-delta
   * pass-through sets it before delivering, so a throw there leaves a marker
   * saying "painted" for text that never painted, and a throw out of the
   * non-coalescable flush skips the delete that would have retired one. Both
   * are cleaned by the same caller frame that makes `propagate` correct in the
   * first place: `consumeAdapterEvents` surfaces a `runtime.error` for the
   * throwing thread, and a `runtime.error` is not a coalescable delta, so it
   * retires that thread's marker on its way through `offer`. Setting the
   * marker after the delivery instead would change what a re-entrant offer
   * sees mid-paint; this path does not need that.
   */
  private deliver(
    event: CanonicalRuntimeEvent,
    onFailure: DeliveryFailureMode,
  ): void {
    if (onFailure === 'propagate') {
      this.emit(event);
      return;
    }
    try {
      this.emit(event);
    } catch (error) {
      this.warnDeliveryFailure(event, error);
    }
  }

  private warnDeliveryFailure(
    event: CanonicalRuntimeEvent,
    error: unknown,
  ): void {
    const now = Date.now();
    if (
      this.lastDeliveryWarningAt !== 0 &&
      now - this.lastDeliveryWarningAt < DELIVERY_FAILURE_WARN_INTERVAL_MS
    ) {
      this.suppressedDeliveryFailures += 1;
      return;
    }
    const suppressed = this.suppressedDeliveryFailures;
    this.lastDeliveryWarningAt = now;
    this.suppressedDeliveryFailures = 0;
    try {
      this.logger.warn('Content delta could not be published', {
        method: event.method,
        threadId: event.threadId,
        error: error instanceof Error ? error.message : String(error),
        ...(suppressed > 0
          ? { suppressedSincePreviousWarning: suppressed }
          : {}),
      });
    } catch {
      // This runs from inside `deliver`'s catch, so a throwing logger escapes
      // as the exact `uncaughtException` that catch exists to prevent — and a
      // write to a torn-down pino destination during shutdown is precisely
      // when it happens. There is nowhere left to report it.
    }
  }
}
