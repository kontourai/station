import type { ChatAttachmentInput } from '@kontourai/station-contracts/chat-attachment';
import type {
  ConnectionRecoveryDecision,
  ConnectionRecoveryIntent,
  ConnectionRecoveryOutcome,
  ConnectionRecoveryProjection,
} from '@kontourai/station-contracts/connection-recovery';
import {
  type CanonicalRuntimeEvent,
  isDeferredRetriableTurnError,
  type TurnStartedEvent,
} from '@kontourai/station-contracts/runtime-events';
import type { ProviderAdapterShape } from '../../providers/adapter-shape.js';
import { dispatchableChatAttachments } from '../../providers/sessions/chat-attachments.js';
import {
  attachmentReplayRefusals,
  connectionRecoveryOutcomes,
} from '../../telemetry/metrics.js';
import type { ClassifiedConnectionFailure } from '../connections/connection-recovery-policy.js';
import {
  classifyConnectionFailure,
  decideConnectionRecovery,
  MAX_RECOVERY_HORIZON_MS,
  resolveRecoveryDueAt,
} from '../connections/connection-recovery-policy.js';
import { type CredentialRecoveryModule } from './credential-recovery-module.js';
import type { EventStore } from './event-store.js';
import type { RecoveryDispatchAdapter } from './recovery-dispatch-adapter.js';
import {
  type RecoveryClaim,
  type RecoveryLedger,
  type RecoveryTransition,
} from './recovery-ledger.js';

const DEFAULT_MAX_ATTEMPTS = 1;
const RECOVERY_SHUTDOWN_SETTLEMENT_MS = 250;
const CANCELLATION_RETRY_MS = 100;

/**
 * Small recovery owner for the orchestration event seam. It schedules only
 * durable intents, while provider work is delegated to one composed Adapter.
 * It is not a general scheduler or credential recovery implementation.
 */
export class SessionRecoveryCoordinator {
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly cancellationRetryTimers = new Map<
    string,
    ReturnType<typeof setTimeout>
  >();
  private stopping = false;
  private readonly inFlight = new Set<Promise<void>>();
  private readonly lifecycleByFingerprint = new Map<string, Promise<void>>();
  private readonly dispatchControllers = new Map<string, AbortController>();
  private readonly activeByThread = new Map<string, string>();
  private readonly ledger: RecoveryLedger;
  private readonly completingFingerprints = new Set<string>();
  /** First cancellation CAS is carried into serialized cleanup exactly once. */
  private readonly cancellationResults = new Map<string, RecoveryTransition>();
  private credentialRecovery?: CredentialRecoveryModule;
  private disposed = false;

  constructor(
    private readonly options: {
      eventStore: EventStore;
      adapterForProvider: (
        provider: string,
      ) => ProviderAdapterShape | undefined;
      recoveryDispatchAdapter: RecoveryDispatchAdapter;
      recoveryLedger?: RecoveryLedger;
      credentialRecovery?: CredentialRecoveryModule;
      isCredentialRestarting?: (threadId: string) => boolean;
      onOutcome?: (input: {
        failureKind: ConnectionRecoveryIntent['failureKind'];
        decision: ConnectionRecoveryIntent['decision'];
        outcome: ConnectionRecoveryOutcome;
      }) => void;
      now?: () => Date;
      /**
       * Optional so no existing caller needs new plumbing (the correlation
       * -bindings convention). Its only use is naming WHY a replay was
       * refused: the durable ledger row records `failed` with no reason
       * column, so without this a user's failed recovery is a mystery.
       */
      logger?: {
        warn: (message: string, meta?: Record<string, unknown>) => void;
      };
    },
  ) {
    this.credentialRecovery = options.credentialRecovery;
    this.ledger =
      options.recoveryLedger ?? options.eventStore.createRecoveryLedger();
  }

  latestProjection(threadId: string): ConnectionRecoveryProjection | undefined {
    return this.ledger.latestProjection(threadId);
  }

  observe(event: CanonicalRuntimeEvent): void {
    // `dispose()` publishes this gate before its first await. Runtime event
    // consumption can still be re-entrant while shutdown persists its durable
    // cancellation fence; admitting a fresh arm in that interval would leave
    // a dispatchable recovery behind after this Module has stopped owning it.
    if (this.stopping || this.disposed) return;
    if (event.method === 'runtime.error') this.observeRuntimeError(event);
    else if (event.method === 'turn.started') this.observeTurnStarted(event);
    else if (event.method === 'turn.completed')
      this.observeTurnCompleted(event.threadId, event.turnId);
    else if (event.method === 'turn.aborted')
      this.observeTurnAborted(event.threadId, event.turnId);
    else if (event.method === 'session.exited')
      this.observeSessionExited(event.threadId);
  }

  /** Rebuild timers after normal provider-session reconstruction. */
  reconcile(): void {
    // The source terminal is durable even if the original cancellation CAS
    // returned unavailable. Repair it before deriving timers, so restart can
    // never re-dispatch a recovery that the source already ended.
    this.ledger.cancelSourceTerminated(this.now().toISOString());
    // CredentialRecoveryModule is the only owner that can turn a prepared
    // profile attempt into candidate-profile compensation.  This coordinator
    // may settle ordinary recovery only; otherwise it would erase the
    // credential identity before its owner can make it safe.
    const unsettled = this.ledger.reconcilePrepared(
      this.now().toISOString(),
      'due',
    );
    for (const intent of unsettled)
      this.recordIntentOutcome(intent, 'indeterminate');
    for (const intent of this.ledger.pending()) {
      if (intent.outcome !== 'armed' || !intent.dueAt) continue;
      this.schedule(intent.fingerprint, intent.dueAt);
    }
    void this.credentialRecovery?.reconcile();
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.stopping = true;
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    // Persist cancellation while this Module can still schedule its bounded
    // exact retry. Marking disposed first used to suppress that retry and
    // allowed an armed recovery to survive shutdown without an obligation.
    const pending = this.ledger.pending();
    // This write is independent of the normal cancellation CAS. It is the
    // durable restart fence if storage stays unavailable for the bounded
    // shutdown window.
    this.ledger.cancelShutdownRequested(this.now().toISOString());
    for (const intent of pending) {
      this.requestIntentCancellation(intent);
    }
    for (const controller of this.dispatchControllers.values())
      controller.abort();
    if (this.inFlight.size > 0) {
      await this.awaitInFlightSettlement();
    }
    this.disposed = true;
    for (const timer of this.cancellationRetryTimers.values())
      clearTimeout(timer);
    this.cancellationRetryTimers.clear();
    this.activeByThread.clear();
    this.completingFingerprints.clear();
    if (this.inFlight.size > 0) await this.awaitInFlightSettlement();
    if (this.inFlight.size === 0) {
      this.lifecycleByFingerprint.clear();
    }
    const unsettled = this.ledger
      .pending()
      .filter(
        (intent) => intent.outcome === 'armed' || intent.outcome === 'resumed',
      );
    if (unsettled.length > 0) {
      throw Object.assign(
        new Error(
          `Recovery shutdown left ${unsettled.length} cancellation obligations unsettled.`,
        ),
        { code: 'RECOVERY_SHUTDOWN_UNSETTLED', pending: unsettled.length },
      );
    }
  }

  private observeRuntimeError(
    event: Extract<CanonicalRuntimeEvent, { method: 'runtime.error' }>,
  ): void {
    // Recovery is strictly observational: malformed provider detail must
    // never escape into (and terminate) adapter event consumption.
    try {
      const resumed = this.findResumedIntent(event.threadId, event.turnId);
      if (!resumed) {
        this.armForRuntimeError(event);
        return;
      }
      if (this.completingFingerprints.has(resumed.fingerprint)) return;
      this.enqueueLifecycle(resumed.fingerprint, () =>
        this.failIntent(resumed),
      );
    } catch {
      // Fail closed: preserve the runtime event without a recovery action.
    }
  }

  private observeTurnStarted(event: TurnStartedEvent): void {
    try {
      const correlationId = event.metadata?.recoveryCorrelationId;
      if (typeof correlationId !== 'string') return;
      const intent = this.ledger.observe({
        recoveryCorrelationId: correlationId,
        turnId: event.turnId,
        now: this.now().toISOString(),
      });
      if (!intent || intent.threadId !== event.threadId) return;
    } catch {
      // Observability cannot terminate the provider event stream.
    }
  }

  private observeTurnCompleted(threadId: string, turnId: string): void {
    const intent = this.ledger
      .pending()
      .find(
        (candidate) =>
          candidate.threadId === threadId && candidate.resumedTurnId === turnId,
      );
    if (!intent) return;
    if (this.completingFingerprints.has(intent.fingerprint)) return;
    this.completingFingerprints.add(intent.fingerprint);
    this.enqueueLifecycle(intent.fingerprint, () =>
      this.completeRecoveredIntent(intent),
    );
  }

  private observeTurnAborted(threadId: string, turnId: string): void {
    const pending = this.ledger
      .pending()
      .filter(
        (intent) =>
          intent.threadId === threadId &&
          (intent.sourceTurnId === turnId || intent.resumedTurnId === turnId),
      );
    for (const intent of pending) {
      this.requestIntentCancellation(intent, turnId);
    }
  }

  private observeSessionExited(threadId: string): void {
    if (this.options.isCredentialRestarting?.(threadId)) return;
    const pending = this.ledger
      .pending()
      .filter((intent) => intent.threadId === threadId);
    for (const intent of pending) {
      this.requestIntentCancellation(intent);
    }
  }

  private armForRuntimeError(
    event: Extract<CanonicalRuntimeEvent, { method: 'runtime.error' }>,
  ): void {
    const adapter = this.options.adapterForProvider(event.provider);
    const failure = classifyConnectionFailure(event);
    const decision = decideConnectionRecovery({
      capability: adapter?.metadata.recovery,
      failure,
      now: this.now(),
    });
    const source = this.findSourceTurn(event.threadId, event.turnId);
    if (!source) return;
    const intent = this.armRecovery(
      event,
      source,
      failure,
      decision,
      adapter?.metadata.recovery?.maxAttempts,
    );
    this.recordIntentOutcome(intent, intent.outcome);
    if (this.disposed) return;
    if (this.credentialRecovery) {
      this.enqueueLifecycle(intent.fingerprint, async () => {
        const handled = await this.tryProfileRecoveryOrSchedule(intent, source);
        if (
          !handled &&
          !this.disposed &&
          intent.outcome === 'armed' &&
          intent.dueAt
        ) {
          this.schedule(intent.fingerprint, intent.dueAt);
        }
      });
    } else if (intent.outcome === 'armed' && intent.dueAt) {
      this.schedule(intent.fingerprint, intent.dueAt);
    }
  }

  private armRecovery(
    event: Extract<CanonicalRuntimeEvent, { method: 'runtime.error' }>,
    source: TurnStartedEvent,
    failure: ClassifiedConnectionFailure,
    decision: { decision: ConnectionRecoveryDecision; dueAt?: string },
    declaredMaxAttempts?: number,
  ): ConnectionRecoveryIntent {
    const now = this.now().toISOString();
    const dueAt =
      decision.dueAt ??
      (decision.decision === 'retry-now'
        ? resolveRecoveryDueAt(failure.timing, this.now())
        : undefined);
    // Station exposes no reconnect callback. Keep that decision visible but
    // terminal instead of leaving an unactionable intent armed forever.
    const decisionName = decision.decision;
    const terminalManual =
      decisionName === 'manual' || decisionName === 'reconnect';
    return this.ledger.arm({
      fingerprint: `${event.threadId}:${source.turnId}:${failure.kind}:${failure.scope}`,
      threadId: event.threadId,
      provider: event.provider,
      sourceEventId: source.eventId,
      sourceTurnId: source.turnId,
      failureKind: failure.kind,
      scope: failure.scope,
      decision: decisionName,
      ...(dueAt ? { dueAt } : {}),
      maxAttempts: Math.max(
        1,
        Math.min(3, declaredMaxAttempts ?? DEFAULT_MAX_ATTEMPTS),
      ),
      outcome:
        decisionName === 'unsupported'
          ? 'unsupported'
          : terminalManual
            ? 'manual'
            : 'armed',
      createdAt: now,
      updatedAt: now,
    });
  }

  private schedule(fingerprint: string, dueAt: string): void {
    if (this.disposed) return;
    this.clearTimer(fingerprint);
    const dueAtMs = Date.parse(dueAt);
    const rawDelay = dueAtMs - this.now().getTime();
    if (
      !Number.isSafeInteger(dueAtMs) ||
      rawDelay < -MAX_RECOVERY_HORIZON_MS ||
      rawDelay > MAX_RECOVERY_HORIZON_MS
    ) {
      return;
    }
    const delay = Math.max(0, rawDelay);
    const timer = setTimeout(() => {
      this.timers.delete(fingerprint);
      if (!this.disposed) this.trackClaimAndResume(fingerprint);
    }, delay);
    timer.unref?.();
    this.timers.set(fingerprint, timer);
  }

  private async claimAndResume(fingerprint: string): Promise<void> {
    if (this.disposed) return;
    // A reconstructed due intent still gets the same credential-recovery
    // Module before ordinary replay. Its durable claim remains the authority.
    if (this.credentialRecovery) {
      const pending = this.ledger.find(fingerprint);
      const source = pending ? this.findSourceEvent(pending) : undefined;
      if (pending?.outcome === 'armed' && this.replayableSource(source)) {
        const handled = await this.tryProfileRecoveryOrSchedule(
          pending,
          source,
        );
        if (handled) return;
      }
    }
    const prepared = this.ledger.claim({
      fingerprint,
      kind: 'due',
      now: this.now().toISOString(),
    });
    if (prepared.kind !== 'owner') return;
    const intent = this.ledger.find(fingerprint);
    if (!intent) return;
    if (this.disposed) {
      await this.cancelClaimedIntent(intent);
      return;
    }
    this.recordIntentOutcome(intent, 'resumed');
    const source = this.findSourceEvent(intent);
    if (!this.replayableSource(source)) {
      await this.failIntent(intent);
      return;
    }
    this.launchDispatch(intent, source, prepared.attempt);
  }

  /**
   * A different enrolled account is actionable immediately; its adoption
   * must not wait for the exhausted account's reset time. If no eligible
   * profile can be staged, preserve the ordinary timing-based recovery.
   */
  private async tryProfileRecoveryOrSchedule(
    intent: ConnectionRecoveryIntent,
    source: TurnStartedEvent,
  ): Promise<boolean> {
    const module = this.credentialRecovery;
    if (!module) return false;
    const controller = new AbortController();
    this.dispatchControllers.set(intent.fingerprint, controller);
    const outcome = await module.recover({
      intent,
      replay: this.buildReplayInput(
        intent.threadId,
        source,
        '',
        controller.signal,
      ),
    });
    if (outcome.kind === 'unnecessary') {
      this.clearIntentRuntime(intent, false);
      return false;
    }
    if (outcome.kind === 'restarted') {
      const claimed = this.ledger.find(intent.fingerprint);
      if (claimed?.outcome === 'resumed') {
        this.clearTimer(intent.fingerprint);
        this.activeByThread.set(intent.threadId, intent.fingerprint);
        this.recordIntentOutcome(claimed, 'resumed');
      }
      return true;
    }
    if (outcome.kind === 'conflicted') {
      // A different Module instance owns the durable claim. Do not convert its
      // live recovery into a local failure, and do not start ordinary replay.
      this.clearIntentRuntime(intent, false);
      return true;
    }
    this.clearIntentRuntime(intent, true);
    const current = this.ledger.find(intent.fingerprint);
    if (outcome.kind === 'indeterminate') {
      this.recordIntentOutcome(intent, 'compensation-required');
    } else if (current?.outcome === 'resumed') {
      const failed = this.ledger.terminal(
        intent.fingerprint,
        'failed',
        this.now().toISOString(),
      );
      if (failed.kind === 'applied') this.recordIntentOutcome(intent, 'failed');
    }
    return true;
  }

  private async completeRecoveredIntent(
    intent: ConnectionRecoveryIntent,
  ): Promise<void> {
    try {
      const current = this.ledger.find(intent.fingerprint);
      const credentialRecovery = this.credentialRecovery;
      const profileCompletion =
        current?.dispatchKind === 'profile' && credentialRecovery !== undefined;
      if (
        current?.outcome !== 'resumed' ||
        (!profileCompletion && current.dispatchSettlement !== 'accepted')
      ) {
        return;
      }
      if (this.disposed) {
        await this.cancelClaimedIntent(intent);
        return;
      }
      const outcome = profileCompletion
        ? await credentialRecovery.complete(intent)
        : { kind: 'recovered' as const };
      if (outcome.kind === 'indeterminate') {
        this.clearIntentRuntime(intent, true);
        this.recordIntentOutcome(intent, 'compensation-required');
        return;
      }
      if (outcome.kind === 'rolled-back' || outcome.kind === 'conflicted') {
        this.clearIntentRuntime(intent, true);
        this.recordIntentOutcome(intent, 'failed');
        return;
      }
      if (current.dispatchKind !== 'profile') {
        const succeeded = this.ledger.terminal(
          intent.fingerprint,
          'succeeded',
          this.now().toISOString(),
        );
        if (succeeded.kind !== 'applied') return;
      }
      this.clearIntentRuntime(intent, false);
      this.recordIntentOutcome(intent, 'succeeded');
    } finally {
      this.completingFingerprints.delete(intent.fingerprint);
    }
  }

  private async dispatchClaimedIntent(
    intent: ConnectionRecoveryIntent,
    source: TurnStartedEvent,
    dispatchAttempt: RecoveryClaim,
  ): Promise<void> {
    const fingerprint = intent.fingerprint;
    if (this.activeByThread.has(intent.threadId)) {
      await this.enqueueLifecycle(fingerprint, () => this.failIntent(intent));
      return;
    }
    const controller = new AbortController();
    this.dispatchControllers.set(fingerprint, controller);
    this.activeByThread.set(intent.threadId, fingerprint);
    try {
      if (!this.canDispatch(intent, controller.signal)) {
        await this.enqueueLifecycle(fingerprint, () =>
          this.cancelClaimedIntent(intent),
        );
        return;
      }
      const replay = dispatchAttempt.replay(
        this.buildReplayInput(intent.threadId, source, '', controller.signal),
      );
      const outcome = await this.options.recoveryDispatchAdapter.dispatch({
        intent,
        replay,
      });
      if (outcome.kind === 'rejected') {
        await this.enqueueLifecycle(fingerprint, () => this.failIntent(intent));
        return;
      }
      if (outcome.kind === 'accepted') {
        const accepted = dispatchAttempt.acceptFromProvider({
          turnId: outcome.turnId,
          now: this.now().toISOString(),
        });
        if (accepted.kind !== 'applied')
          await this.interruptLateRecoveredTurn(intent, outcome.turnId);
        else this.replayObservedTerminal(intent, outcome.turnId);
        return;
      }
      if (outcome.kind === 'observed') {
        // A local turn.started proves correlation, not provider acceptance.
        // Persist the observation while retaining the prepared capability;
        // only a later startup owner may classify the unknown invocation.
        this.ledger.observe({
          recoveryCorrelationId: replay.recoveryCorrelationId,
          turnId: outcome.turnId,
          now: this.now().toISOString(),
        });
        return;
      }
      if (
        dispatchAttempt.indeterminate(this.now().toISOString()).kind ===
        'applied'
      )
        this.recordIntentOutcome(intent, 'indeterminate');
    } catch {
      await this.enqueueLifecycle(fingerprint, () =>
        this.handleDispatchFailure(intent, controller.signal),
      );
    } finally {
      this.finishDispatchAttempt(intent);
    }
  }

  private async handleDispatchFailure(
    intent: ConnectionRecoveryIntent,
    signal: AbortSignal,
  ): Promise<void> {
    const outcome = this.ledger.find(intent.fingerprint)?.outcome;
    if (
      outcome === 'canceled' ||
      outcome === 'failed' ||
      outcome === 'succeeded'
    ) {
      return;
    }
    if (this.disposed || signal.aborted) await this.cancelClaimedIntent(intent);
    else await this.failIntent(intent);
  }

  private finishDispatchAttempt(intent: ConnectionRecoveryIntent): void {
    const outcome = this.ledger.find(intent.fingerprint)?.outcome;
    if (outcome !== 'resumed') this.clearIntentRuntime(intent, false);
  }

  private trackClaimAndResume(fingerprint: string): void {
    this.enqueueLifecycle(fingerprint, () => this.claimAndResume(fingerprint));
  }

  private launchDispatch(
    intent: ConnectionRecoveryIntent,
    source: TurnStartedEvent,
    dispatchAttempt: RecoveryClaim,
  ): void {
    this.trackOperation(
      this.dispatchClaimedIntent(intent, source, dispatchAttempt),
    );
  }

  private async interruptLateRecoveredTurn(
    intent: ConnectionRecoveryIntent,
    turnId: string,
  ): Promise<void> {
    try {
      await this.options.recoveryDispatchAdapter.interrupt?.({
        threadId: intent.threadId,
        turnId,
      });
    } catch {
      // The durable recovery is already canceled; provider cleanup is
      // best-effort and must not reopen the terminal state.
    }
  }

  /**
   * Provider streams can publish a canonical terminal event before their
   * dispatch promise returns acceptance. Settlement stays one-way, then this
   * catches that already-durable event without treating `turn.started` as
   * provider proof.
   *
   * station#3510: `runtime.error` is also a canonical terminal (station#3442)
   * — a failed turn publishes it INSTEAD of `turn.completed`, never
   * alongside — so a search that only recognized `turn.completed`/
   * `turn.aborted` could find nothing for a turn that failed before dispatch
   * acceptance resolved, leaving the recovery intent pending forever. Uses
   * `isDeferredRetriableTurnError` to exclude codex's willRetry error: that
   * one `runtime.error` shape is explicitly not proof the turn is over.
   *
   * NOT literally "the same predicate the stall watchdog uses" (an earlier
   * version of this comment claimed that): the watchdog gates its clear on
   * TWO predicates, `!isDeferredRetriableTurnError(event) &&
   * !isSessionScopedRetriableError(event)` — the second excludes a
   * SESSION-scoped retriable error (`runtime.error` with no `turnId`). This
   * search is correct using only the first, for a reason specific to its own
   * query rather than parity with the watchdog: `listEventsForTurn(threadId,
   * turnId)` filters on `turn_id = ?` in SQL, and a session-scoped error is
   * stored with a NULL `turn_id` — it can never match this query's `turnId`
   * parameter, so `isSessionScopedRetriableError`'s wider predicate is
   * unreachable here regardless of whether this search checks it.
   *
   * DISCLOSED, NOT FIXED — the other half of the same race, CONFIRMED by
   * independent review: this closes the ORIGINAL intent (the durable-state
   * leak), but does not undo the SECOND intent
   * `observeRuntimeError`/`armForRuntimeError` may already have armed live,
   * before this replay ran, for the SAME failure. `findResumedIntent`
   * (`observeRuntimeError`'s live path) fails to find the resumed intent in
   * exactly this window because `observeRecoveryDispatchCorrelation`'s
   * `resumed_turn_id` UPDATE is itself gated `WHERE ... outcome = 'resumed'`
   * (`event-store.ts`) — pre-acceptance the row has not reached that
   * outcome yet, so the UPDATE matches nothing and `findSourceTurn` matches
   * instead. Reading `armForRuntimeError`/`findSourceTurn`: when the race in
   * station#3510's issue text occurs, the live `runtime.error` carries the
   * RECOVERED turn's own `turnId`, and every adapter publishes that
   * recovered turn's `turn.started` synchronously at the start of `sendTurn`
   * — before any failure can occur — so `findSourceTurn(threadId,
   * event.turnId)` finds a match and `armForRuntimeError` arms a second,
   * independent intent keyed on the recovered turn as its OWN source. This
   * method has no visibility into that intent (different fingerprint) and
   * does not search for or cancel it. Whether it then double-dispatches
   * depends on `activeByThread` timing this method does not control. Left
   * open rather than attempting an
   * unverified change to the live-observation ordering under time pressure;
   * station#3510's own title names this half explicitly and it is still
   * unaddressed.
   */
  private replayObservedTerminal(
    intent: ConnectionRecoveryIntent,
    turnId: string,
  ): void {
    const terminal = this.options.eventStore
      .listEventsForTurn(intent.threadId, turnId)
      .map((event) => event.payload)
      .reverse()
      .find(
        (event) =>
          (event.method === 'turn.completed' ||
            event.method === 'turn.aborted' ||
            event.method === 'runtime.error') &&
          !isDeferredRetriableTurnError(event),
      );
    if (terminal?.method === 'turn.completed') {
      this.observeTurnCompleted(intent.threadId, turnId);
    } else if (terminal?.method === 'turn.aborted') {
      this.observeTurnAborted(intent.threadId, turnId);
    } else if (terminal?.method === 'runtime.error') {
      this.observeRuntimeError(terminal);
    }
  }

  private enqueueLifecycle(
    fingerprint: string,
    operation: () => Promise<void>,
  ): Promise<void> {
    const predecessor = this.lifecycleByFingerprint.get(fingerprint);
    let current: Promise<void>;
    if (predecessor) {
      current = predecessor.catch(() => undefined).then(operation);
    } else {
      try {
        current = operation();
      } catch (error) {
        current = Promise.reject(error);
      }
    }
    this.lifecycleByFingerprint.set(fingerprint, current);
    this.trackOperation(current);
    const cleanup = () => {
      if (this.lifecycleByFingerprint.get(fingerprint) === current) {
        this.lifecycleByFingerprint.delete(fingerprint);
      }
    };
    void current.then(cleanup, cleanup);
    return current;
  }

  private trackOperation(operation: Promise<void>): void {
    this.inFlight.add(operation);
    void operation.then(
      () => this.inFlight.delete(operation),
      () => this.inFlight.delete(operation),
    );
  }

  /**
   * A recorded turn can be replayed only when everything it carried can be
   * sent again. `prompt` has always been that test; attachment bytes are now
   * part of it (station#3374), because retention can reclaim a blob and
   * re-running the turn without the image the user attached asks the model a
   * different question than the user did.
   */
  private replayableSource(
    source: TurnStartedEvent | undefined,
  ): source is TurnStartedEvent {
    if (!source || source.prompt === undefined) return false;
    if (!source.attachments?.length) return true;
    if (dispatchableChatAttachments(source.attachments) !== undefined) {
      return true;
    }
    const unresolved = source.attachments
      .filter((attachment) => attachment.dataUrl === undefined)
      .map((attachment) => attachment.name);
    this.options.logger?.warn(
      'Recovery cannot replay this turn: its attachment bytes are no longer stored',
      {
        threadId: source.threadId,
        turnId: source.turnId,
        attachments: unresolved,
      },
    );
    try {
      attachmentReplayRefusals.add(1, { provider: source.provider });
    } catch {
      // Observation only.
    }
    return false;
  }

  private buildReplayInput(
    threadId: string,
    source: TurnStartedEvent,
    recoveryCorrelationId: string,
    signal: AbortSignal,
  ): {
    threadId: string;
    input: string;
    attachments?: ChatAttachmentInput[];
    ambientContext?: string;
    modelId?: string;
    modelOptions?: Record<string, string | number | boolean>;
    recoveryCorrelationId: string;
    signal: AbortSignal;
  } {
    const dispatchable = dispatchableChatAttachments(source.attachments);
    return {
      threadId,
      input: source.prompt ?? '',
      ...(dispatchable ? { attachments: dispatchable } : {}),
      ...(source.ambientContext
        ? { ambientContext: source.ambientContext }
        : {}),
      ...this.sourceModelConfiguration(source),
      recoveryCorrelationId,
      signal,
    };
  }

  private sourceModelConfiguration(source: TurnStartedEvent): {
    modelId?: string;
    modelOptions?: Record<string, string | number | boolean>;
  } {
    const metadata = source.metadata;
    if (!metadata || typeof metadata !== 'object') return {};
    const modelId = metadata.effectiveModel;
    const rawOptions = metadata.effectiveModelOptions;
    const effectiveOptions =
      rawOptions && typeof rawOptions === 'object' && !Array.isArray(rawOptions)
        ? Object.fromEntries(
            Object.entries(rawOptions)
              .slice(0, 16)
              .filter(
                (entry): entry is [string, string | number | boolean] =>
                  entry[0].length <= 128 &&
                  (typeof entry[1] === 'string'
                    ? entry[1].length <= 128
                    : typeof entry[1] === 'boolean' ||
                      (typeof entry[1] === 'number' &&
                        Number.isFinite(entry[1]))),
              ),
          )
        : undefined;
    const approvalOptions = this.sourceApprovalConfiguration(metadata);
    const modelOptions = {
      ...effectiveOptions,
      ...approvalOptions,
    };
    return {
      ...(typeof modelId === 'string' && modelId.length <= 256
        ? { modelId }
        : {}),
      ...(Object.keys(modelOptions).length > 0 ? { modelOptions } : {}),
    };
  }

  private sourceApprovalConfiguration(
    metadata: Record<string, unknown>,
  ): Record<string, string> {
    const approvalMode = metadata.approvalMode;
    if (
      approvalMode === 'ask' ||
      approvalMode === 'auto' ||
      approvalMode === 'never'
    ) {
      return { approvalMode };
    }
    if (metadata.permissionMode === 'plan') return { permissionMode: 'plan' };
    const claudeMode = {
      default: 'ask',
      acceptEdits: 'auto',
      bypassPermissions: 'never',
    }[String(metadata.permissionMode)];
    if (claudeMode) return { approvalMode: claudeMode };
    const codexPair = `${String(metadata.approvalPolicy)}:${String(metadata.sandbox)}`;
    const codexMode = {
      'untrusted:workspace-write': 'ask',
      'on-request:workspace-write': 'auto',
      'never:danger-full-access': 'never',
    }[codexPair];
    return codexMode ? { approvalMode: codexMode } : {};
  }

  private canDispatch(
    intent: ConnectionRecoveryIntent,
    signal: AbortSignal,
  ): boolean {
    if (this.disposed || this.stopping || signal.aborted) return false;
    const current = this.ledger.find(intent.fingerprint);
    return (
      current?.outcome === 'resumed' &&
      current.dispatchSettlement === 'prepared'
    );
  }

  private async cancelIntentWork(
    intent: ConnectionRecoveryIntent,
    abortedTurnId?: string,
  ): Promise<void> {
    const current = this.ledger.find(intent.fingerprint);
    if (current?.outcome === 'succeeded' || current?.outcome === 'failed')
      return;
    let canceled =
      this.cancellationResults.get(intent.fingerprint) ??
      this.ledger.cancel(intent.fingerprint, this.now().toISOString());
    this.cancellationResults.delete(intent.fingerprint);
    // The request-path CAS is intentionally early so an abort reaches the
    // Adapter promptly. If its storage result was unavailable, the serialized
    // lifecycle turn retries the exact cancellation before projecting it.
    if (canceled.kind === 'unavailable') {
      canceled = this.ledger.cancel(
        intent.fingerprint,
        this.now().toISOString(),
      );
    }
    if (canceled.kind === 'unavailable') {
      // Keep the durable intent visible. A later retry or the startup source
      // terminal fence owns cancellation; callers must not see a false
      // canceled projection while SQLite is unavailable.
      this.scheduleCancellationRetry(intent, abortedTurnId);
      return;
    }
    this.clearTimer(intent.fingerprint);
    this.clearIntentRuntime(intent, true);
    if (intent.resumedTurnId && abortedTurnId !== intent.resumedTurnId) {
      this.trackOperation(
        this.options.recoveryDispatchAdapter
          .interrupt?.({
            threadId: intent.threadId,
            turnId: intent.resumedTurnId,
          })
          ?.catch(() => undefined) ?? Promise.resolve(),
      );
    }
    if (canceled.kind === 'applied')
      this.recordIntentOutcome(intent, 'canceled');
    await this.credentialRecovery?.abandon(intent);
  }

  private async cancelClaimedIntent(
    intent: ConnectionRecoveryIntent,
  ): Promise<void> {
    const current = this.ledger.find(intent.fingerprint);
    if (current?.outcome === 'succeeded' || current?.outcome === 'failed')
      return;
    if (current?.outcome !== 'canceled') {
      const canceled = this.ledger.cancel(
        intent.fingerprint,
        this.now().toISOString(),
      );
      if (canceled.kind === 'unavailable') {
        this.scheduleCancellationRetry(intent);
        return;
      }
      if (canceled.kind !== 'applied') return;
    }
    this.clearIntentRuntime(intent, true);
    this.recordIntentOutcome(intent, 'canceled');
    await this.credentialRecovery?.abandon(intent);
  }

  private requestIntentCancellation(
    intent: ConnectionRecoveryIntent,
    abortedTurnId?: string,
  ): void {
    this.clearTimer(intent.fingerprint);
    if (!this.completingFingerprints.has(intent.fingerprint)) {
      const canceled = this.ledger.cancel(
        intent.fingerprint,
        this.now().toISOString(),
      );
      this.cancellationResults.set(intent.fingerprint, canceled);
      this.dispatchControllers.get(intent.fingerprint)?.abort();
    }
    this.enqueueLifecycle(intent.fingerprint, () =>
      this.cancelIntentWork(intent, abortedTurnId),
    );
  }

  private scheduleCancellationRetry(
    intent: ConnectionRecoveryIntent,
    abortedTurnId?: string,
  ): void {
    if (this.disposed || this.cancellationRetryTimers.has(intent.fingerprint))
      return;
    const timer = setTimeout(() => {
      this.cancellationRetryTimers.delete(intent.fingerprint);
      this.enqueueLifecycle(intent.fingerprint, () =>
        this.cancelIntentWork(intent, abortedTurnId),
      );
    }, CANCELLATION_RETRY_MS);
    this.cancellationRetryTimers.set(intent.fingerprint, timer);
  }

  private async failIntent(intent: ConnectionRecoveryIntent): Promise<void> {
    const failed = this.ledger.terminal(
      intent.fingerprint,
      'failed',
      this.now().toISOString(),
    );
    this.clearIntentRuntime(intent, true);
    if (failed.kind === 'applied') this.recordIntentOutcome(intent, 'failed');
    await this.credentialRecovery?.abandon(intent);
  }

  private clearIntentRuntime(
    intent: ConnectionRecoveryIntent,
    abort: boolean,
  ): void {
    const controller = this.dispatchControllers.get(intent.fingerprint);
    if (abort) controller?.abort();
    this.dispatchControllers.delete(intent.fingerprint);
    this.cancellationResults.delete(intent.fingerprint);
    const cancellationTimer = this.cancellationRetryTimers.get(
      intent.fingerprint,
    );
    if (cancellationTimer) clearTimeout(cancellationTimer);
    this.cancellationRetryTimers.delete(intent.fingerprint);
    if (this.activeByThread.get(intent.threadId) === intent.fingerprint) {
      this.activeByThread.delete(intent.threadId);
    }
  }

  private recordIntentOutcome(
    intent: ConnectionRecoveryIntent,
    outcome: ConnectionRecoveryOutcome,
  ): void {
    this.record(
      outcome,
      intent.provider,
      intent.failureKind,
      intent.scope,
      intent.decision,
    );
    try {
      this.options.onOutcome?.({
        failureKind: intent.failureKind,
        decision: intent.decision,
        outcome,
      });
    } catch {
      // Optional telemetry must never affect recovery's durable state machine.
    }
  }

  private async awaitInFlightSettlement(): Promise<void> {
    const operations = Promise.allSettled([...this.inFlight]);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        operations,
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, RECOVERY_SHUTDOWN_SETTLEMENT_MS);
          timer.unref?.();
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private findSourceTurn(
    threadId: string,
    turnId?: string,
  ): TurnStartedEvent | undefined {
    if (turnId) {
      return this.options.eventStore
        .listEventsForTurn(threadId, turnId)
        .map((entry) => entry.payload)
        .reverse()
        .find(
          (candidate): candidate is TurnStartedEvent =>
            candidate.method === 'turn.started',
        );
    }
    const event = this.options.eventStore.latestEventByMethod(
      threadId,
      'turn.started',
    )?.payload;
    return event?.method === 'turn.started' ? event : undefined;
  }

  private findSourceEvent(
    intent: ConnectionRecoveryIntent,
  ): TurnStartedEvent | undefined {
    const event = this.options.eventStore.eventById(
      intent.threadId,
      intent.sourceEventId,
    )?.payload;
    return event?.method === 'turn.started' ? event : undefined;
  }

  private findResumedIntent(threadId: string, turnId?: string) {
    if (!turnId) return undefined;
    return this.ledger
      .pending()
      .find(
        (candidate) =>
          candidate.threadId === threadId && candidate.resumedTurnId === turnId,
      );
  }

  private clearTimer(fingerprint: string): void {
    const timer = this.timers.get(fingerprint);
    if (timer) clearTimeout(timer);
    this.timers.delete(fingerprint);
  }

  private now(): Date {
    return this.options.now?.() ?? new Date();
  }

  private record(
    outcome: ConnectionRecoveryOutcome,
    provider: string,
    failureKind: string,
    scope: string,
    decision: string,
  ): void {
    connectionRecoveryOutcomes.add(1, {
      outcome,
      provider,
      failure_kind: failureKind,
      scope,
      decision,
    });
  }
}
