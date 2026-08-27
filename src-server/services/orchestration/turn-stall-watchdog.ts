import type { CanonicalRuntimeEvent } from '@kontourai/station-contracts/runtime-events';
import { isDeferredRetriableTurnError } from './session-lifecycle-service.js';

/**
 * station#3451 finding H2, corrected by fix round D4: matches `retriable &&
 * no turnId` — a SHAPE, not a single publisher. Named for that shape, not
 * for the one call site that motivated it; the round-1 name
 * (`isDeferredStreamRestartError`) claimed a uniqueness this predicate does
 * not have, and the round-2 review found THREE producers that match it:
 *
 * 1. orchestration-service's adapter-stream-restart error (~line 5358: any
 *    provider, `retriable: true`, deliberately no `turnId` — session-scoped,
 *    published when a dead adapter stream restarts consumption; its own
 *    comment says a restarted consumer "may still receive a legitimate later
 *    `turn.completed` for a turn that kept running through the hiccup").
 *    This is the intended target — the reason the predicate exists.
 * 2. `orchestration-session-state.ts`'s session-recovery-failure event
 *    (~line 1121, `code: SESSION_RECOVERY_FAILED_CODE`, `retriable: true`,
 *    no `turnId`) — an entirely DIFFERENT meaning (a session that
 *    definitively failed to reopen, not a mid-turn hiccup). Harmless here:
 *    it is written via `appendEventIfAbsent` and never reaches the
 *    EventBus, so it never reaches this watchdog at all.
 * 3. codex's own `'error'` notification when it omits `turnId` with
 *    `willRetry: true` — a genuine session-scoped codex signal, so treating
 *    it as non-terminal here is correct overlap, not a defect.
 *
 * `isDeferredRetriableTurnError` alone only recognizes codex's turn-scoped
 * willRetry error (by design — station-agent-adapter's two `retriable: true`
 * sites are ALREADY terminal, but both carry a `turnId`, which is what tells
 * them apart, not the provider). Before finding H2, a claude/acp/bedrock
 * turn hit by (1) had its still-legitimately-running watch cleared — the
 * same metric-pollution class finding 4 fixed, in the opposite direction.
 */
function isSessionScopedRetriableError(
  event: Pick<CanonicalRuntimeEvent, 'method' | 'turnId'> & {
    retriable?: boolean;
  },
): boolean {
  return (
    event.method === 'runtime.error' &&
    event.retriable === true &&
    !event.turnId
  );
}

/**
 * station#2959: the layer above station#1207/#1256's shared
 * `readWithStallWatchdog` (`@kontourai/station-contracts/stall-watchdog`),
 * which only detects a stalled underlying stream READ. This watches the
 * canonical runtime-event stream `OrchestrationService` already projects for
 * every turn and flags a turn that is technically still streaming (or
 * otherwise emitting adapter events) but has produced no PROGRESS within its
 * agent's declared window.
 *
 * "Progress" is intentionally derived from the event stream itself, not
 * elapsed wall-clock: a streamed content/reasoning chunk, a tool lifecycle
 * event, or a session state transition each reset the window. A turn making
 * steady progress at any rate — however slow any single step is — is never
 * flagged; only a genuine silence for the full window fires.
 */
const PROGRESS_METHODS: ReadonlySet<CanonicalRuntimeEvent['method']> = new Set([
  'content.text-delta',
  'content.reasoning-delta',
  'tool.started',
  'tool.progress',
  'tool.completed',
]);

/**
 * Events that close a turn's watch outright — no further reset is possible.
 *
 * `runtime.error` is deliberately NOT listed here (station#3451 findings 4/6):
 * it needs conditional handling — see `observe()` — because a codex
 * deferred-retriable `runtime.error` (`willRetry`) is not proof the turn is
 * over (the same fact `turn-completion-notifications.ts` and
 * `session-lifecycle-service.ts`'s `interruptibleTurnIdForEvents` already
 * account for). Folding it in here unconditionally would stop timing a turn
 * that may still be silently stuck in a codex retry loop — exactly the case
 * this watchdog exists to catch.
 */
const TERMINAL_METHODS: ReadonlySet<CanonicalRuntimeEvent['method']> = new Set([
  'turn.completed',
  'turn.aborted',
  'session.stop-settled',
  'session.exited',
]);

/**
 * Review HIGH 1 (#2959): a turn awaiting a HUMAN — an approval prompt, an
 * input request — is alive but deliberately silent, for as long as the human
 * takes. Deferred approval is a first-class feature (the approvals inbox and
 * CLI exist to answer later), so silence after `request.opened` is not a
 * stall and must not even be COUNTED as one: approval waits polluting the
 * metric would corrupt exactly the data this observe-only phase exists to
 * collect. The watch suspends on open and re-arms on resolution.
 */
const SUSPEND_METHODS: ReadonlySet<CanonicalRuntimeEvent['method']> = new Set([
  'request.opened',
]);
const RESUME_METHODS: ReadonlySet<CanonicalRuntimeEvent['method']> = new Set([
  'request.resolved',
]);

interface WatchedTurn {
  turnId: string;
  timer?: ReturnType<typeof setTimeout>;
  windowMs: number;
  lastProgressEventAt: string;
}

export type TurnStallCallback = (threadId: string, turnId: string) => void;

export interface TurnStallLifecycleCallbacks {
  onStall: TurnStallCallback;
  onProgress?: (input: {
    threadId: string;
    turnId: string;
    lastProgressEventAt: string;
  }) => void;
  onClear?: (input: { threadId: string; turnId?: string }) => void;
}

type TurnStallCallbacks = TurnStallCallback | TurnStallLifecycleCallbacks;

function lifecycleCallbacks(
  callbacks: TurnStallCallbacks,
): TurnStallLifecycleCallbacks {
  return typeof callbacks === 'function' ? { onStall: callbacks } : callbacks;
}

/**
 * One watchdog instance per `OrchestrationService`. Tracks at most one
 * in-flight watch per thread (a thread has at most one active turn), so a
 * fresh `turn.started` for the same thread simply replaces the prior watch —
 * matching `activeTurnIdForEvents`' single-active-turn assumption elsewhere
 * in this service.
 */
export class TurnStallWatchdog {
  private readonly watched = new Map<string, WatchedTurn>();
  /** Turns whose watch is suspended awaiting a human response. */
  private readonly suspended = new Map<string, string>();

  /** Live timer count this instance currently owns (test/shutdown hook). */
  get size(): number {
    return [...this.watched.values()].filter((watched) => watched.timer).length;
  }

  /**
   * station#3594: true when `turnId` names a turn other than the one
   * `threadId` is currently tracking — i.e. this is a STALE terminal/error
   * for a turn the session has already moved past (a codex session runs
   * turn-1 then turn-2; turn-1's terminal arrives late, after turn-2 has
   * started). Direct comparison against the tracked turn id, not a fold:
   * this watchdog already tracks at most one turn per thread (set by
   * `start()`, always paired with the `turn.started` that names it), so
   * there is no "last known anchor after clearing" question to answer the
   * way `session-lifecycle-service.ts`'s `acceptsTurnTerminalEvent`/
   * `nextTurnIdentityAnchor` do for the lifecycle folds (station#3581) — and
   * that predicate's type is narrowed to `turn.completed`/`turn.aborted`
   * only (it would also reject a no-`turnId` terminal outright, which
   * `session.exited` and a session-scoped `runtime.error` both are and must
   * NOT be rejected/kept-watching for), so it cannot cover this method's
   * other callers (`session.stop-settled`, `runtime.error`) without a second,
   * differently-shaped variant anyway.
   *
   * Review HIGH 1 (station#3594): checks BOTH `this.watched` and
   * `this.suspended`, not just `watched`. A turn awaiting a human
   * (`SUSPEND_METHODS`) has its entry moved out of `watched` entirely — an
   * earlier revision of this method read only `watched` and returned `false`
   * (not stale — "nothing to protect") for a thread whose real tracked turn
   * was merely suspended, so a stale terminal for an EARLIER turn cleared the
   * suspension outright (`clear()` deletes it unconditionally) and the
   * eventual `request.resolved` found nothing to resume: this issue's exact
   * scenario, reachable specifically through the approval-wait state this
   * file treats as first-class (`:89-96`).
   *
   * An event with no `turnId` at all cannot be stale for one SPECIFIC other
   * turn (there is nothing to compare), so it is never treated as such here —
   * it is up to each call site whether "no turnId" should still clear
   * unconditionally (`session.exited` does, structurally, in `observe()`) or
   * fall through to another exclusion (a session-scoped `runtime.error` is
   * excluded earlier, by `isSessionScopedRetriableError`).
   */
  private isStaleForAnotherTurn(
    threadId: string,
    turnId: string | undefined,
  ): boolean {
    if (!turnId) return false;
    const current =
      this.watched.get(threadId)?.turnId ?? this.suspended.get(threadId);
    return current !== undefined && turnId !== current;
  }

  /** Start (or restart) the window for `turnId` on `threadId`. */
  start(
    threadId: string,
    turnId: string,
    windowMs: number,
    callbacks: TurnStallCallbacks,
    lastProgressEventAt = new Date().toISOString(),
  ): void {
    const lifecycle = lifecycleCallbacks(callbacks);
    this.clear(threadId, lifecycle);
    const timer = setTimeout(() => {
      const watched = this.watched.get(threadId);
      if (!watched || watched.turnId !== turnId) return;
      // Keep the observation until the next progress or terminal event. The
      // old timer-only representation forgot this identity at fire time,
      // which made a later progress event unable to clear a user-visible
      // silence observation (#4054).
      watched.timer = undefined;
      lifecycle.onStall(threadId, turnId);
    }, windowMs);
    // A wedged turn must never be the reason the process can't exit.
    timer.unref?.();
    this.watched.set(threadId, {
      turnId,
      timer,
      windowMs,
      lastProgressEventAt,
    });
    lifecycle.onProgress?.({ threadId, turnId, lastProgressEventAt });
  }

  /**
   * Feed one runtime event through the watchdog. Call for every event on the
   * thread's stream in order, including `turn.started` and every terminal
   * method — this is the single seam that starts, resets, and clears a
   * watch, so a caller can never drift from what it is actually observing.
   */
  observe(
    event: Pick<CanonicalRuntimeEvent, 'method' | 'threadId' | 'turnId'> & {
      /** True when this event carries a lifecycle state transition. */
      isStateTransition?: boolean;
      /** Only meaningful (and only ever read) for a `runtime.error` event. */
      provider?: CanonicalRuntimeEvent['provider'];
      /** Canonical event timestamp; retained as the watchdog's progress fact. */
      createdAt?: string;
      /** Only meaningful (and only ever set) for a `runtime.error` event. */
      retriable?: boolean;
    },
    windowMs: number,
    callbacks: TurnStallCallbacks,
  ): void {
    if (event.method === 'runtime.error') {
      // station#3451 findings 4/6: a genuine (non-deferred) `runtime.error`
      // is a terminal fact this watch must stop timing, exactly like the
      // methods in TERMINAL_METHODS — otherwise a turn that already ended
      // fires a spurious stall detection later, polluting the one metric
      // this observe-only phase exists to collect (#2959). A codex
      // deferred-retriable one is not terminal and is not progress either
      // (unchanged from before this fix): the watch, if armed, keeps
      // counting down toward its existing deadline — the retry may still be
      // silently stuck, which is exactly the case this watchdog exists to
      // catch.
      if (
        !isDeferredRetriableTurnError(event) &&
        !isSessionScopedRetriableError(event) &&
        // station#3594: a genuine, turn-scoped runtime.error naming a turn
        // this thread has already moved past must not clear the watch for
        // the turn that is actually running — same identity gate as
        // TERMINAL_METHODS below, and the same defect shape (found auditing
        // this file for #3594; not itself in the original issue's cited
        // lines, but the identical unconditional-clear mechanism).
        !this.isStaleForAnotherTurn(event.threadId, event.turnId)
      ) {
        this.clear(event.threadId, lifecycleCallbacks(callbacks));
      }
      return;
    }
    if (TERMINAL_METHODS.has(event.method)) {
      // station#3594: gate the clear on turn identity. Before this fix, a
      // `turn.completed`/`turn.aborted`/`session.stop-settled` naming a
      // SUPERSEDED turn (one the thread has already moved past) cancelled
      // the watch for the turn that is genuinely still running — silently
      // removing the safety net this watchdog exists to provide, with the
      // absence of a stall alert indistinguishable from a healthy session.
      //
      // Review MEDIUM 1: `session.exited` is excluded from the gate
      // STRUCTURALLY, not merely because no known publisher happens to set
      // its (optional, base-inherited) `turnId` today. It is session-scoped
      // by definition — the whole session ended — so it must always clear
      // regardless of any `turnId` it might carry, now or from a future
      // publisher; making that the code's behavior rather than an unenforced
      // fact about current publishers is what keeps this correct if that
      // fact ever stops holding.
      if (
        event.method === 'session.exited' ||
        !this.isStaleForAnotherTurn(event.threadId, event.turnId)
      ) {
        this.clear(event.threadId, lifecycleCallbacks(callbacks));
      }
      return;
    }
    if (event.method === 'turn.started') {
      if (!event.turnId) return;
      this.start(
        event.threadId,
        event.turnId,
        windowMs,
        callbacks,
        event.createdAt,
      );
      return;
    }
    if (SUSPEND_METHODS.has(event.method)) {
      // Delta-review F1 (#4054 round 2): the same identity gate the terminal
      // paths use. A DELAYED request.opened naming a superseded turn must not
      // suspend — and, since the fired-watch retention fix, must not clear —
      // the observation of the turn that is actually running. A no-turnId
      // request.opened remains session-scoped and suspends unconditionally.
      if (this.isStaleForAnotherTurn(event.threadId, event.turnId)) return;
      const suspended = this.watched.get(event.threadId);
      if (suspended) {
        if (suspended.timer) clearTimeout(suspended.timer);
        this.suspended.set(event.threadId, suspended.turnId);
        this.watched.delete(event.threadId);
        // A fired watch retains identity solely so a later progress or turn
        // end can clear its observation. Once an approval wait suspends the
        // watch, Station deliberately stops observing silence, so keeping a
        // user-visible quiet marker would overclaim (#4054 fix round F2).
        lifecycleCallbacks(callbacks).onClear?.({
          threadId: event.threadId,
          turnId: suspended.turnId,
        });
      }
      return;
    }
    if (RESUME_METHODS.has(event.method)) {
      const resumeTurnId = this.suspended.get(event.threadId);
      if (resumeTurnId !== undefined) {
        this.suspended.delete(event.threadId);
        this.start(
          event.threadId,
          resumeTurnId,
          windowMs,
          callbacks,
          event.createdAt,
        );
      }
      return;
    }
    const watching = this.watched.get(event.threadId);
    if (!watching) return;
    if (event.turnId && event.turnId !== watching.turnId) return;
    const isProgress =
      PROGRESS_METHODS.has(event.method) || event.isStateTransition === true;
    if (!isProgress) return;
    this.start(
      event.threadId,
      watching.turnId,
      windowMs,
      callbacks,
      event.createdAt,
    );
  }

  /** Clear any watch for `threadId` without firing. */
  clear(threadId: string, callbacks?: TurnStallLifecycleCallbacks): void {
    const suspendedTurnId = this.suspended.get(threadId);
    this.suspended.delete(threadId);
    const watching = this.watched.get(threadId);
    if (!watching && !suspendedTurnId) return;
    if (watching?.timer) clearTimeout(watching.timer);
    this.watched.delete(threadId);
    callbacks?.onClear?.({
      threadId,
      turnId: watching?.turnId ?? suspendedTurnId,
    });
  }

  /** Clear every watch this instance owns (service shutdown/disposal). */
  clearAll(): void {
    for (const threadId of new Set([
      ...this.watched.keys(),
      ...this.suspended.keys(),
    ])) {
      this.clear(threadId);
    }
  }
}
