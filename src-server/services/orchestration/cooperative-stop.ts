import crypto from 'node:crypto';
import {
  COOPERATIVE_STOP_BUDGET_MS,
  type InterruptTurnResult,
} from '@kontourai/station-contracts/orchestration';
import type {
  ProviderKind,
  ProviderSession,
} from '@kontourai/station-contracts/provider';
import type { CanonicalRuntimeEvent } from '@kontourai/station-contracts/runtime-events';
import {
  isProviderInterruptTurnResult,
  type ProviderAdapterShape,
} from '../../providers/adapter-shape.js';
import { interruptibleTurnIdForEvents } from './session-lifecycle-service.js';

/**
 * The cancel-acknowledgement budget now lives in the orchestration contract
 * (`COOPERATIVE_STOP_BUDGET_MS`) rather than privately here: the browser's
 * Stop control has to outwait it, and a second hand-written copy of the
 * number in the UI would drift (UX audit T1).
 */
type StopSettlement = 'acknowledged' | 'completed' | 'deadline';

/**
 * A Stop recorded before its turn existed.
 *
 * `clientTurnId` is what makes this safe (UX audit T1 review): keyed on the
 * thread alone, a cancel whose intended turn never started stayed armed for
 * the whole TTL and would interrupt whatever turn started next. With the key,
 * the `sendTurn` path binds `turnId` the moment its dispatch resolves, and
 * `applyPendingTurnInterrupt` refuses any turn that is not that one. A record
 * with no key at all (a caller that sent none) keeps the old
 * first-turn-wins behaviour, bounded by the TTL.
 */
export interface PendingTurnInterrupt {
  expiresAt: number;
  clientTurnId?: string;
  /** Bound by `sendTurn` once its dispatch resolves to a provider turn. */
  turnId?: string;
  /**
   * Turns whose `turn.started` this record has already seen while it was
   * still waiting for its binding.
   *
   * UX audit T1 review round 3 (HIGH): Claude and ACP publish `turn.started`
   * BEFORE `sendTurn` returns the id, so the ordinary ordering is
   * start-then-bind — and the event-driven apply, correctly refusing to guess
   * which dispatch that start belonged to, had to stand down. Nothing then
   * re-applied on the binding, so the intended turn ran on despite Station
   * having told the user it would be interrupted as soon as it started.
   * Remembering the start is what lets the bind fire immediately, and only
   * for a turn that genuinely IS interruptible.
   */
  startedTurnIds: Set<string>;
  /**
   * The TTL's own timer. The window used to be enforced only when some later
   * event happened to invoke the fold, so a dispatch that never settled and a
   * thread that went quiet left the record armed indefinitely.
   */
  expiryTimer?: ReturnType<typeof setTimeout>;
}

/**
 * The one place a stop settlement becomes the public outcome vocabulary. A
 * label the UI renders for a Stop is derived here, from what actually
 * settled — it is never assembled by the caller.
 */
function interruptTurnResultFor(
  threadId: string,
  turnId: string,
  settlement: StopSettlement,
): InterruptTurnResult {
  if (settlement === 'completed')
    return { outcome: 'turn-completed', threadId, turnId };
  return {
    outcome: settlement === 'acknowledged' ? 'cooperative' : 'forced',
    threadId,
    turnId,
  };
}

interface CooperativeStopTask {
  turnId: string;
  task: Promise<StopSettlement>;
  settleCompleted(): void;
}

export interface CooperativeStopDeps {
  /** Called, not captured: reads the LIVE `options.cooperativeStopBudgetMs`. */
  configuredBudgetMs: () => number | undefined;
  /**
   * The projection read (station#3473), with the optional store and the
   * payload map absorbed at the ctor seam.
   */
  listSessionProjectionEvents: (threadId: string) => CanonicalRuntimeEvent[];
  /** C7's live adapter index, as a lookup — never a Map handle. */
  sessionAdapterFor: (threadId: string) => ProviderAdapterShape | undefined;
  /**
   * C2's projection+publish. Returns boolean in-service; every site here
   * discards it, so this is `void` on purpose.
   */
  publishEvent: (event: CanonicalRuntimeEvent) => void;
  /** C1 stays on the service — throws; do not swallow. */
  assertAdapterCurrentAfterCommand: (adapter: ProviderAdapterShape) => void;
  /**
   * The in-memory row, falling back to the persisted one. The `??` is
   * declared at the ctor seam so this module never sees the event store,
   * and C7's terminal rename inherits one named reader.
   */
  loadedOrPersistedSession: (threadId: string) => ProviderSession | undefined;
  /**
   * The DURABLE row alone (station#3493 residual 3): the `error` marker a
   * failed start writes (station#1090) lands durably first, and the
   * in-memory row can lag it — a boot snapshot still saying `running`
   * shadows a durable `error` through the `??` above. The status
   * preservation in {@link persistResumableStoppedSession} must therefore
   * consult this reader too, not just the loaded one.
   */
  persistedSession: (threadId: string) => ProviderSession | undefined;
  /**
   * C7's map, as a NAMED WRITE — one of the file's two raw writes; never a
   * Map handle. The paired durable write is a separate dep so the
   * in-memory/persisted split stays visible.
   */
  upsertLoadedSession: (threadId: string, session: ProviderSession) => void;
  upsertSession: (session: ProviderSession) => void;
  /**
   * The slice-2 teardown seam. The divergent flags
   * ({ policyThreads, turnProgress }) are written literally at the ctor
   * seam — the slice-2 source invariant scans only that file.
   */
  forgetThreadState: (threadId: string) => void;
  logger: { warn(message: string, meta?: Record<string, unknown>): void };
}

/**
 * Cooperative stop & deferred interrupt (epic #4024 slice 10, #4204): the
 * C4 cluster from the seam map — the FIRST extracted cluster owning live
 * mutable per-thread state: the one-stop-protocol-per-thread map, the
 * pending-interrupt map, and their timers all live here, with every write
 * internal to this module.
 *
 * `settleCompletedTurn` is the C2 spine's settle-read and MUST be called in
 * `publishCanonicalEvent` BEFORE the quarantine gate (T5) — pinned by a
 * source invariant in the orchestration suite.
 *
 * The `'stall'` `initiatedBy` arm is DORMANT plumbing (station#2959): stall
 * detection is observe-only by review decision, and the only live callers
 * pass `'user'` — see `interruptUserTurnCooperatively`'s docblock.
 *
 * The teardown flags for `forgetLiveUserSession` are declared at the ctor
 * seam, not here (T10(3)). This module holds no Map handle to foreign
 * state (T13) and emits no metrics (T12).
 */
export class CooperativeStop {
  /** One user-stop protocol per thread; concurrent stop commands join it. */
  private readonly cooperativeStops = new Map<string, CooperativeStopTask>();
  /**
   * UX audit T1 (live verification): a Stop pressed between "the turn was
   * dispatched" and "the engine's provider session exists" was refused with
   * `No provider session found for thread` — and that window covered EVERY
   * real press, because the composer's own Stop control disappeared before the
   * session was created. This holds `threadId -> expiry`: a cancel recorded
   * against a thread with no engine yet, applied to that thread's next
   * `turn.started` and discarded after `PENDING_TURN_INTERRUPT_TTL_MS` so a
   * cancel for a turn that never arrives cannot kill an unrelated later one.
   */
  private readonly pendingTurnInterrupts = new Map<
    string,
    PendingTurnInterrupt
  >();

  constructor(private readonly deps: CooperativeStopDeps) {}

  /**
   * The C2 spine's settle-read (epic #4024 slice 10): MUST be called in
   * `publishCanonicalEvent` BEFORE the quarantine gate — a stop must settle
   * even for an event the gate declines, or a stop on a quarantined thread
   * never settles and rides its full budget into a forced teardown of a
   * turn that had already completed. Pinned by a source invariant in the
   * orchestration suite; exactly one dispatch file-wide.
   */
  settleCompletedTurn(
    threadId: string,
    turnId: string | undefined,
    method: CanonicalRuntimeEvent['method'],
  ): void {
    const cooperativeStop = this.cooperativeStops.get(threadId);
    if (
      cooperativeStop &&
      turnId === cooperativeStop.turnId &&
      method === 'turn.completed'
    ) {
      cooperativeStop.settleCompleted();
    }
  }

  private cooperativeStopBudgetMs(): number {
    return Math.max(
      1,
      this.deps.configuredBudgetMs() ?? COOPERATIVE_STOP_BUDGET_MS,
    );
  }

  /**
   * Applies a Stop that arrived before this thread had an engine (see
   * {@link pendingTurnInterrupts}). Fired on the thread's next `turn.started`:
   * that is the first moment there is a turn to cancel and an adapter to ask.
   *
   * Deliberately fire-and-forget — `interruptUserTurnCooperatively` waits out
   * the cancel budget, and awaiting it here would stall the adapter's whole
   * event stream for seconds. The stop's own events (`session.stop-settled`,
   * `turn.aborted`) are the durable record of what it did; this call site
   * reports nothing.
   *
   * The entry is dropped on ANY terminal for the thread as well, so a stale
   * cancel cannot reach a turn the user started later.
   */
  applyPendingTurnInterrupt(
    adapter: ProviderAdapterShape,
    event: CanonicalRuntimeEvent,
  ): void {
    const pending = this.pendingTurnInterrupts.get(event.threadId);
    if (!pending) return;
    if (Date.now() > pending.expiresAt) {
      this.clearPendingTurnInterrupt(event.threadId);
      return;
    }
    if (event.method !== 'turn.started') {
      // A terminal for the turn this cancel is bound to (or, for an
      // uncorrelated record, any terminal on the thread) ends its life.
      if (
        (event.method === 'session.exited' ||
          event.method === 'turn.completed' ||
          event.method === 'turn.aborted') &&
        (pending.turnId === undefined || pending.turnId === event.turnId)
      ) {
        this.clearPendingTurnInterrupt(event.threadId);
      }
      return;
    }
    if (event.turnId) pending.startedTurnIds.add(event.turnId);
    // UX audit T1 review: a correlated cancel may only reach the turn its own
    // dispatch produced. Until that binding exists the record waits — a turn
    // starting now belongs to some other dispatch, and interrupting it would
    // stop work the user never asked to stop. Round 3: the wait now ENDS, at
    // `bindPendingTurnInterrupt`, using the start just recorded above.
    if (pending.clientTurnId !== undefined && pending.turnId === undefined) {
      return;
    }
    if (pending.turnId !== undefined && pending.turnId !== event.turnId) return;
    this.clearPendingTurnInterrupt(event.threadId);
    this.dispatchDeferredInterrupt(adapter, event.threadId, event.turnId);
  }

  /** Records a held Stop and arms its own expiry (see {@link PendingTurnInterrupt}). */
  recordPendingTurnInterrupt(
    threadId: string,
    pending: PendingTurnInterrupt,
  ): void {
    this.clearPendingTurnInterrupt(threadId);
    const timer = setTimeout(
      () => this.clearPendingTurnInterrupt(threadId),
      Math.max(0, pending.expiresAt - Date.now()),
    );
    // A held cancel must never be the reason this process stays alive.
    (timer as { unref?: () => void }).unref?.();
    this.pendingTurnInterrupts.set(threadId, {
      ...pending,
      expiryTimer: timer,
    });
  }

  private clearPendingTurnInterrupt(threadId: string): void {
    const pending = this.pendingTurnInterrupts.get(threadId);
    if (!pending) return;
    if (pending.expiryTimer) clearTimeout(pending.expiryTimer);
    this.pendingTurnInterrupts.delete(threadId);
  }

  private dispatchDeferredInterrupt(
    adapter: ProviderAdapterShape,
    threadId: string,
    turnId: string | undefined,
  ): void {
    void this.interruptUserTurnCooperatively(adapter, threadId, turnId).catch(
      (error) => {
        this.deps.logger.warn('Deferred user stop could not be applied', {
          provider: adapter.provider,
          threadId,
          error: error instanceof Error ? error.message : String(error),
        });
      },
    );
  }

  /**
   * Binds a pending Stop to the provider turn its own dispatch produced, or
   * drops it when that dispatch produced none. See {@link PendingTurnInterrupt}.
   *
   * UX audit T1 review round 3 (HIGH): this is also where a held cancel is
   * APPLIED, not merely recorded. Claude and ACP publish `turn.started` before
   * `sendTurn` returns its id, so in the ordinary case the event-driven apply
   * has already seen the start and stood down for want of a binding — and no
   * later event was guaranteed to arrive and re-check. Firing here closes that
   * race, and only for a turn whose start this record actually observed: an
   * unstarted turn has nothing to interrupt, and firing blind would consume
   * the record against a `no-active-turn` and lose the user's Stop entirely.
   */
  bindPendingTurnInterrupt(
    threadId: string,
    clientTurnId: string | undefined,
    turnId: string | undefined,
  ): void {
    if (!clientTurnId) return;
    const pending = this.pendingTurnInterrupts.get(threadId);
    if (!pending || pending.clientTurnId !== clientTurnId) return;
    if (!turnId) {
      this.clearPendingTurnInterrupt(threadId);
      return;
    }
    if (!pending.startedTurnIds.has(turnId)) {
      // Bind-before-start: the `turn.started` still to come takes it.
      this.pendingTurnInterrupts.set(threadId, { ...pending, turnId });
      return;
    }
    const adapter = this.deps.sessionAdapterFor(threadId);
    if (!adapter) {
      // The stream that published the start owns this thread's adapter; with
      // no adapter there is nothing to ask, so leave the record bound and let
      // the TTL or a later event settle it rather than dropping the Stop.
      this.pendingTurnInterrupts.set(threadId, { ...pending, turnId });
      return;
    }
    this.clearPendingTurnInterrupt(threadId);
    this.dispatchDeferredInterrupt(adapter, threadId, turnId);
  }

  /**
   * User interrupt is deliberately different from internal teardown. It asks the
   * engine to cancel the active turn, then derives the outcome from the first
   * local settlement: engine acknowledgement, normal turn completion, or
   * this service's budget timer. No command input or adapter
   * payload can choose an outcome.
   *
   * station#2959: `initiatedBy` composes station#2806's protocol with
   * turn-stall detection rather than inventing a second termination path.
   * The `'stall'` arm is DORMANT plumbing held for the #2959 follow-up:
   * stall detection (`TurnProgressTracker`, epic #4024 slice 1) is
   * observe-only by review decision and currently calls nothing — the only
   * live callers pass `initiatedBy: 'user'`. The value is an explicit
   * parameter threaded straight through to the emitted
   * `session.stop-settled` event; it is never inferred afterward from
   * `outcome` or reason text.
   */
  async interruptUserTurnCooperatively(
    adapter: ProviderAdapterShape,
    threadId: string,
    requestedTurnId?: string,
    initiatedBy: 'user' | 'stall' = 'user',
  ): Promise<InterruptTurnResult> {
    const existing = this.cooperativeStops.get(threadId);
    if (existing) {
      // A second Stop for the same thread rides the first one's task rather
      // than starting a second cancel (the pre-existing coalescing), and now
      // reports the SAME derived outcome instead of an untyped void the
      // caller has to guess at (UX audit T1: a double-click must not produce
      // two different labels for one stop).
      return interruptTurnResultFor(
        threadId,
        existing.turnId,
        await existing.task,
      );
    }

    // station#3473: `interruptibleTurnIdForEvents`, not `activeTurnIdForEvents`
    // — Stop must still find a codex turn that is deferred-retriable (see
    // that function's doc), or it silently no-ops in exactly the window a
    // user is most likely to reach for it.
    const activeTurnId = interruptibleTurnIdForEvents(
      this.deps.listSessionProjectionEvents(threadId),
    );
    if (!activeTurnId) {
      return { outcome: 'no-active-turn', threadId };
    }
    if (requestedTurnId && requestedTurnId !== activeTurnId)
      return { outcome: 'no-active-turn', threadId };
    const turnId = requestedTurnId ?? activeTurnId;

    let settleCompleted!: () => void;
    const completed = new Promise<void>((resolve) => {
      settleCompleted = resolve;
    });
    const state = {} as CooperativeStopTask;
    state.turnId = turnId;
    state.settleCompleted = settleCompleted;
    state.task = this.runCooperativeStop(
      adapter,
      threadId,
      state,
      completed,
      initiatedBy,
    );
    this.cooperativeStops.set(threadId, state);
    try {
      return interruptTurnResultFor(threadId, turnId, await state.task);
    } finally {
      if (this.cooperativeStops.get(threadId) === state) {
        this.cooperativeStops.delete(threadId);
      }
    }
  }

  private async runCooperativeStop(
    adapter: ProviderAdapterShape,
    threadId: string,
    state: CooperativeStopTask,
    completed: Promise<void>,
    initiatedBy: 'user' | 'stall',
  ): Promise<StopSettlement> {
    const settlement = await new Promise<StopSettlement>((resolve) => {
      let settled = false;
      const settle = (next: StopSettlement) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(next);
      };
      const timer = setTimeout(
        () => settle('deadline'),
        this.cooperativeStopBudgetMs(),
      );
      completed.then(() => settle('completed'));
      void Promise.resolve()
        .then(() => adapter.interruptTurn(threadId, state.turnId))
        .then((result) => {
          if (
            isProviderInterruptTurnResult(result) &&
            result.outcome === 'cancelled' &&
            result.turnId === state.turnId
          ) {
            settle('acknowledged');
            return;
          }
          this.deps.logger.warn(
            'Engine did not confirm cooperative stop target',
            { provider: adapter.provider, threadId, result },
          );
        })
        .catch((error) => {
          // A cancel rejection is not an engine error for the user who asked
          // to stop. It is simply no acknowledgement, so the named budget
          // still owns the transition to the existing hard teardown.
          this.deps.logger.warn('Engine did not acknowledge cooperative stop', {
            provider: adapter.provider,
            threadId,
            error: error instanceof Error ? error.message : String(error),
          });
        })
        // A plugin's foreign thenable or even the logger itself can throw.
        // This fire-and-forget observer must never leak that as an unhandled
        // rejection; its only effect is to leave the budget in charge.
        .catch(() => undefined);
    });

    if (settlement === 'completed') {
      // The engine completed its turn while the request was in flight. Its
      // existing turn.completed event is the only terminal fact; never add a
      // stop outcome after the fact.
      return settlement;
    }

    if (settlement === 'acknowledged') {
      this.deps.publishEvent({
        eventId: crypto.randomUUID(),
        provider: adapter.provider,
        threadId,
        turnId: state.turnId,
        createdAt: new Date().toISOString(),
        method: 'session.stop-settled',
        outcome: 'cooperative',
        initiatedBy,
      });
      this.persistResumableStoppedSession(adapter.provider, threadId);
      return settlement;
    }

    // The deadline is the sole path to hard teardown. Persist both the
    // derived fact and a terminal turn before touching the engine process so
    // recovery retains a complete, resumable transcript even if teardown dies.
    this.deps.publishEvent({
      eventId: crypto.randomUUID(),
      provider: adapter.provider,
      threadId,
      turnId: state.turnId,
      createdAt: new Date().toISOString(),
      method: 'session.stop-settled',
      outcome: 'forced',
      initiatedBy,
    });
    this.deps.publishEvent({
      eventId: crypto.randomUUID(),
      provider: adapter.provider,
      threadId,
      turnId: state.turnId,
      createdAt: new Date().toISOString(),
      method: 'turn.aborted',
      reason:
        initiatedBy === 'stall'
          ? 'Stopped after the turn-stall window elapsed with no observed progress, then the cooperative cancel budget expired.'
          : 'Stopped after the cooperative cancel budget expired.',
    });
    this.persistResumableStoppedSession(adapter.provider, threadId);
    await adapter.stopSession(threadId);
    this.deps.assertAdapterCurrentAfterCommand(adapter);
    this.forgetLiveUserSession(threadId);
    return settlement;
  }

  /**
   * station#3476: the engine-free half of {@link stopUserSessionImmediately},
   * for a session this process restored at boot and never started. It keeps
   * the same two guarantees the live path gives a user Stop — the row stays
   * resumable (`status: 'ready'`, `resumeCursor` intact) and the thread is no
   * longer live here — without spawning a process in order to kill it.
   * The one exception (station#3493 residual 3): an `error` row keeps its
   * `error` — see {@link persistResumableStoppedSession}.
   */
  stopDormantSessionImmediately(threadId: string): void {
    const current = this.deps.loadedOrPersistedSession(threadId);
    if (current)
      this.persistResumableStoppedSession(current.provider, threadId);
    this.forgetLiveUserSession(threadId);
  }

  async stopUserSessionImmediately(
    adapter: ProviderAdapterShape,
    threadId: string,
  ): Promise<void> {
    // No active turn can acknowledge a cancel. Keep this user-requested stop
    // resumable, but preserve immediate teardown for the idle path.
    this.persistResumableStoppedSession(adapter.provider, threadId);
    await adapter.stopSession(threadId);
    this.deps.assertAdapterCurrentAfterCommand(adapter);
    this.forgetLiveUserSession(threadId);
  }

  /**
   * `provider` rather than the adapter it used to take (station#3476): this
   * reads exactly one field, and the dormant-stop path above has a persisted
   * provider but deliberately no adapter.
   */
  private persistResumableStoppedSession(
    provider: ProviderKind,
    threadId: string,
  ): void {
    const current = this.deps.loadedOrPersistedSession(threadId);
    if (!current) return;
    // station#3493 residual 3: `error` is station#1090's row-level marker
    // that a start failed, and recovery deliberately keeps retrying such
    // rows — a Stop must not manufacture readiness out of one. The
    // `runtime.error` event would survive either way, but the row's summary
    // state is what lists and recovery read first. The durable row is
    // consulted alongside the loaded one because the marker lands durably
    // first and the in-memory row can lag it (fix-round seam test caught
    // the loaded row shadowing a durable `error`). Everything else a user
    // Stop leaves resumable.
    const durable = this.deps.persistedSession(threadId);
    const resumable: ProviderSession = {
      ...current,
      provider,
      status:
        current.status === 'error' || durable?.status === 'error'
          ? 'error'
          : 'ready',
      updatedAt: new Date().toISOString(),
    };
    this.deps.upsertLoadedSession(threadId, resumable);
    this.deps.upsertSession(resumable);
  }

  private forgetLiveUserSession(threadId: string): void {
    // The divergent-flag declaration ({ policyThreads, turnProgress }) lives
    // at the ctor seam in orchestration-service.ts — the slice-2 source
    // invariant scans only that file and pins all six flagged call sites.
    this.deps.forgetThreadState(threadId);
  }
}
