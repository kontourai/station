import type { ConnectionRecoveryIntent } from '@kontourai/station-contracts/connection-recovery';
import { credentialProfileApplication } from '../../telemetry/metrics.js';
import type { ClassifiedConnectionFailure } from '../connections/connection-recovery-policy.js';
import type { CredentialApplicationHandle } from './credential-application-ledger.js';
import type {
  RecoveryDispatchAdapter,
  RecoveryDispatchReplay,
} from './recovery-dispatch-adapter.js';
import type {
  RecoveryClaim,
  RecoveryLedger,
  RecoveryTransition,
} from './recovery-ledger.js';

/** An opaque candidate from the connection implementation; it never enters events. */
export interface CredentialProfileRecoveryAttempt {
  candidateProfileRef: string;
  capability: 'hot_apply' | 'restart_resume' | 'unsupported';
  commit(): Promise<CredentialSettlementOutcome>;
  rollback(): Promise<CredentialSettlementOutcome>;
  inspect(action: 'commit' | 'rollback'): Promise<CredentialSettlementOutcome>;
  acknowledge(): Promise<CredentialReceiptAcknowledgement>;
}

/**
 * Staging is not a boolean: a throw can happen after the registry or provider
 * has changed.  Only `unavailable` proves that the prepared dispatch may be
 * returned to ordinary recovery.
 */
export type CredentialProfileStageOutcome =
  | { kind: 'unavailable' }
  | { kind: 'staged'; attempt: CredentialProfileRecoveryAttempt }
  | { kind: 'indeterminate'; attempt?: CredentialProfileRecoveryAttempt };

/**
 * The real connection Adapter.  It is deliberately narrower than the Module:
 * it performs individual connection mutations but never decides their order.
 */
export interface CredentialProfileRecoveryAdapter {
  stage(input: {
    provider: string;
    failure: ClassifiedConnectionFailure;
    /** Claim-generated opaque key persisted before the registry is mutated. */
    recoveryFingerprint: string;
  }): Promise<CredentialProfileStageOutcome>;
  inspectStartup?(input: {
    provider: string;
    application: CredentialApplicationHandle;
    action: 'commit' | 'rollback';
  }): Promise<CredentialSettlementOutcome>;
  settleStartup?(input: {
    provider: string;
    application: CredentialApplicationHandle;
    action: 'commit' | 'rollback';
  }): Promise<CredentialSettlementOutcome>;
  acknowledgeStartup?(input: {
    provider: string;
    application: CredentialApplicationHandle;
  }): Promise<CredentialReceiptAcknowledgement>;
  rollbackPending?(providers?: string[]): Promise<void>;
}

/** Exact registry truth. `indeterminate` is the only unknown and never retries a provider. */
export type CredentialSettlementOutcome =
  | { kind: 'adopted' }
  | { kind: 'already-adopted' }
  | { kind: 'rolled-back' }
  | { kind: 'already-rolled-back' }
  | { kind: 'superseded' }
  | { kind: 'staged' }
  | { kind: 'unknown' }
  | { kind: 'indeterminate' };

/** Receipt deletion is a durable cleanup step, never a best-effort boolean. */
export type CredentialReceiptAcknowledgement =
  | { kind: 'applied' }
  | { kind: 'unavailable' };

export interface CredentialRecoveryObservation {
  intent: ConnectionRecoveryIntent;
  /**
   * The dispatch Adapter's own replay shape, not a second copy of it: the two
   * had drifted apart the moment persistence stopped guaranteeing attachment
   * bytes (archive#3374).
   */
  replay: RecoveryDispatchReplay;
}

/** Total results keep callers from reconstructing compensation policy. */
export type CredentialRecoveryOutcome =
  | { kind: 'unnecessary' }
  | { kind: 'conflicted' }
  | { kind: 'restarted'; turnId: string }
  | { kind: 'recovered' }
  | { kind: 'rolled-back' }
  | { kind: 'indeterminate' };

export type CredentialRecoveryReconciliationOutcome =
  | { kind: 'reconciled'; recovered: number }
  | { kind: 'indeterminate'; pending: number };

/**
 * Owns automatic credential recovery as one compensation protocol.
 *
 * Concurrency: one Module instance shares an in-flight observation by durable
 * fingerprint, while SQLite's claim prevents two instances from restarting the
 * same intent. Idempotency: only a durable `resumed` intent can commit; an
 * unclaimed abort may mark compensation only while it remains `armed` or
 * `canceled`, so it cannot overwrite a winner. Timeout/abort: the supplied
 * signal reaches restart, and abandon rolls a staged attempt back.
 * Compensation: a rollback failure is durable as `compensation-required`; a
 * later Module may reconcile it without recovering any credential identity
 * from storage. Startup also performs one identity-free Adapter sweep for
 * interrupted persisted applications without settling later markers. Readiness
 * and order: every automatic `recover` waits for that one startup phase to
 * settle before it stages an Adapter application; concurrent callers join the
 * same readiness and fingerprint operation.
 *
 * Depth keeps the stage/restart/commit/rollback protocol behind this small
 * Interface. Locality keeps candidate identity and compensation state in this
 * Implementation. At the composition Seam, that Leverage lets every automatic
 * recovery caller depend on one Module while the Adapter remains concrete.
 */
export interface CredentialRecoveryModule {
  recover(
    observation: CredentialRecoveryObservation,
  ): Promise<CredentialRecoveryOutcome>;
  complete(
    intent: ConnectionRecoveryIntent,
  ): Promise<CredentialRecoveryOutcome>;
  abandon(intent: ConnectionRecoveryIntent): Promise<CredentialRecoveryOutcome>;
  reconcile(): Promise<CredentialRecoveryReconciliationOutcome>;
}

interface CredentialRecoveryImplementationDependencies {
  ledger: RecoveryLedger;
  adapter: CredentialProfileRecoveryAdapter;
  dispatchAdapter: RecoveryDispatchAdapter;
  restoreSession(input: {
    threadId: string;
    signal: AbortSignal;
  }): Promise<void>;
  quarantineSession?(threadId: string): Promise<void>;
  setRestarting?(threadId: string, restarting: boolean): void;
  now(): Date;
}

/** The Implementation keeps sequencing and candidate identity local. */
class CredentialRecoveryImplementation implements CredentialRecoveryModule {
  private readonly attempts = new Map<
    string,
    CredentialProfileRecoveryAttempt
  >();
  /** Only the live claimant can settle an observed prepared profile turn. */
  private readonly claims = new Map<string, RecoveryClaim>();
  /** Commit completed externally; retry only the durable ledger terminal. */
  private readonly committed = new Set<string>();
  private readonly recovering = new Map<
    string,
    Promise<CredentialRecoveryOutcome>
  >();
  private readonly claimedFingerprints = new Set<string>();
  private reconciliation?: Promise<CredentialRecoveryReconciliationOutcome>;
  private startupReadiness?: Promise<CredentialRecoveryReconciliationOutcome>;
  private startupReconciliationComplete = false;
  private orphanSweepComplete = false;

  constructor(
    private readonly dependencies: CredentialRecoveryImplementationDependencies,
  ) {}

  recover(
    observation: CredentialRecoveryObservation,
  ): Promise<CredentialRecoveryOutcome> {
    const existing = this.recovering.get(observation.intent.fingerprint);
    if (existing) return existing;
    const operation = this.recoverAfterStartup(observation).finally(() => {
      if (this.recovering.get(observation.intent.fingerprint) === operation) {
        this.recovering.delete(observation.intent.fingerprint);
      }
    });
    this.recovering.set(observation.intent.fingerprint, operation);
    return operation;
  }

  private async recoverAfterStartup(
    observation: CredentialRecoveryObservation,
  ): Promise<CredentialRecoveryOutcome> {
    await this.awaitStartupReadiness();
    return this.recoverOne(observation);
  }

  private awaitStartupReadiness(): Promise<CredentialRecoveryReconciliationOutcome> {
    if (this.startupReadiness) return this.startupReadiness;
    // `reconcile()` establishes the shared readiness promise before it starts
    // Adapter work. Calling it here cannot deadlock a later rollback-triggered
    // reconciliation because recovery has not entered staging yet.
    return this.reconcile();
  }

  private async recoverOne(
    observation: CredentialRecoveryObservation,
  ): Promise<CredentialRecoveryOutcome> {
    const { intent } = observation;
    const prepared = this.dependencies.ledger.claim({
      fingerprint: intent.fingerprint,
      kind: 'profile',
      now: this.now(),
    });
    if (prepared.kind !== 'owner') return { kind: 'conflicted' };
    this.claims.set(intent.fingerprint, prepared.attempt);
    const claimed = this.dependencies.ledger.find(intent.fingerprint);
    if (!claimed) {
      this.claims.delete(intent.fingerprint);
      return { kind: 'conflicted' };
    }
    if (observation.replay.signal.aborted) {
      const released = prepared.attempt.releaseBeforeInvocation({
        outcome: intent.outcome === 'manual' ? 'manual' : 'armed',
        now: this.now(),
      });
      if (released.kind === 'applied') this.claims.delete(intent.fingerprint);
      return released.kind === 'applied'
        ? { kind: 'rolled-back' }
        : { kind: 'conflicted' };
    }
    const credential = prepared.attempt.prepareCredential(this.now());
    if (credential.kind !== 'owner') {
      return this.indeterminateProfileDispatch(claimed, prepared.attempt);
    }
    const staged = await this.stage(intent, credential.attemptId);
    if (staged.kind === 'unavailable') {
      const released = prepared.attempt.releaseBeforeInvocation({
        outcome: intent.outcome === 'manual' ? 'manual' : 'armed',
        now: this.now(),
      });
      if (released.kind === 'applied') {
        this.claims.delete(intent.fingerprint);
        return { kind: 'unnecessary' };
      }
      return { kind: 'conflicted' };
    }
    if (staged.kind === 'indeterminate') {
      if (staged.attempt) {
        this.attempts.set(intent.fingerprint, staged.attempt);
        this.claimedFingerprints.add(intent.fingerprint);
      }
      return this.indeterminateProfileDispatch(claimed, prepared.attempt);
    }
    const attempt = staged.attempt;
    this.attempts.set(intent.fingerprint, attempt);
    this.claimedFingerprints.add(intent.fingerprint);
    if (observation.replay.signal.aborted) {
      return this.abandon(claimed);
    }
    this.dependencies.setRestarting?.(intent.threadId, true);
    try {
      const replay = prepared.attempt.replay(observation.replay);
      const outcome = await this.dependencies.dispatchAdapter.dispatch({
        intent: claimed,
        replay: replay satisfies RecoveryDispatchReplay,
        credentialProfileRef: attempt.candidateProfileRef,
      });
      if (outcome.kind === 'accepted') {
        const accepted = prepared.attempt.acceptFromProvider({
          turnId: outcome.turnId,
          now: this.now(),
        });
        if (accepted.kind !== 'applied') {
          await this.interruptLateTurn(claimed.threadId, outcome.turnId);
          return { kind: 'conflicted' };
        }
        return { kind: 'restarted', turnId: outcome.turnId };
      }
      if (outcome.kind === 'rejected') {
        const rolledBack = await this.rollback(claimed, 'adoption_failed');
        if (!rolledBack) {
          const marked = this.markCompensationRequired(claimed);
          if (marked.kind !== 'applied') return { kind: 'indeterminate' };
          return { kind: 'indeterminate' };
        } else if (
          this.dependencies.ledger.terminal(
            claimed.fingerprint,
            'failed',
            this.now(),
          ).kind !== 'applied'
        ) {
          return { kind: 'conflicted' };
        }
        return { kind: 'rolled-back' };
      }
      if (outcome.kind === 'observed') {
        // A canonical local turn.started is evidence of correlation only. It
        // remains prepared for this live process; startup will fail closed if
        // no provider acknowledgement subsequently arrives.
        this.dependencies.ledger.observe({
          recoveryCorrelationId: replay.recoveryCorrelationId,
          turnId: outcome.turnId,
          now: this.now(),
        });
        return { kind: 'indeterminate' };
      }
      return this.indeterminateProfileDispatch(claimed, prepared.attempt);
    } catch {
      return this.indeterminateProfileDispatch(claimed, prepared.attempt);
    } finally {
      this.dependencies.setRestarting?.(intent.threadId, false);
    }
  }

  private async interruptLateTurn(
    threadId: string,
    turnId: string,
  ): Promise<void> {
    try {
      await this.dependencies.dispatchAdapter.interrupt?.({ threadId, turnId });
    } catch {
      // The durable intent remains non-retryable; cleanup is best effort.
    }
  }

  async complete(
    intent: ConnectionRecoveryIntent,
  ): Promise<CredentialRecoveryOutcome> {
    const current = this.dependencies.ledger.find(intent.fingerprint);
    // The ledger terminal may have committed before receipt acknowledgement
    // became unavailable. Retry only that exact cleanup: never commit again.
    if (current?.outcome === 'succeeded') {
      const acknowledgedAttempt = this.attempts.get(intent.fingerprint);
      if (!acknowledgedAttempt) return { kind: 'indeterminate' };
      const acknowledged = await acknowledgedAttempt.acknowledge();
      if (acknowledged.kind !== 'applied') return { kind: 'indeterminate' };
      this.attempts.delete(intent.fingerprint);
      this.claims.delete(intent.fingerprint);
      this.committed.delete(intent.fingerprint);
      this.claimedFingerprints.delete(intent.fingerprint);
      return { kind: 'recovered' };
    }
    if (
      current?.outcome === 'resumed' &&
      current.dispatchSettlement === 'prepared' &&
      current.dispatchKind === 'profile'
    ) {
      // Only the process that still has the opaque claim may settle a live
      // observed terminal. A restart has no claim: startup reconciliation is
      // the sole bulk owner and conservatively turns it indeterminate.
      const claim = this.claims.get(intent.fingerprint);
      if (claim?.indeterminate(this.now()).kind === 'applied') {
        const compensation = this.markCompensationRequired(
          intent,
          'indeterminate',
          false,
        );
        if (compensation.kind !== 'applied') return { kind: 'indeterminate' };
        const restored = await this.restoreOrQuarantine(intent);
        const hasExactAttempt = this.attempts.has(intent.fingerprint);
        const rolledBack = await this.rollback(intent, 'adoption_failed');
        if (hasExactAttempt && restored && rolledBack) {
          const resolved = this.dependencies.ledger.resolveCompensation(
            intent.fingerprint,
            this.now(),
          );
          if (resolved.kind === 'applied')
            this.claims.delete(intent.fingerprint);
        } else {
          // A reconstructed process has no opaque candidate. Keep the exact
          // durable marker for this Module's scoped reconciliation.
          void this.drainScopedCompensation();
        }
        return { kind: 'indeterminate' };
      }
      return { kind: 'conflicted' };
    }
    if (
      current?.outcome !== 'resumed' ||
      current.dispatchSettlement !== 'accepted'
    ) {
      return { kind: 'conflicted' };
    }
    const attempt = this.attempts.get(intent.fingerprint);
    if (!attempt) {
      // A new process cannot prove it owns the opaque staged attempt, so it
      // must never classify the remote application as committed. Startup
      // reconciliation can safely sweep unowned persisted applications before
      // this terminal signal arrives; otherwise leave durable compensation.
      if (this.orphanSweepComplete) {
        const terminal = this.dependencies.ledger.terminal(
          intent.fingerprint,
          'failed',
          this.now(),
        );
        return terminal.kind === 'applied'
          ? { kind: 'rolled-back' }
          : { kind: 'indeterminate' };
      }
      const marked = this.markCompensationRequired(intent);
      if (marked.kind !== 'applied') return { kind: 'indeterminate' };
      return { kind: 'indeterminate' };
    }
    try {
      if (!this.committed.has(intent.fingerprint)) {
        const committed = await attempt.commit();
        if (
          committed.kind !== 'adopted' &&
          committed.kind !== 'already-adopted'
        ) {
          return { kind: 'indeterminate' };
        }
        this.committed.add(intent.fingerprint);
        credentialProfileApplication.add(1, {
          source: 'recovery',
          capability: attempt.capability,
          outcome: 'adopted',
          scope: intent.scope,
          reason: 'account_exhausted',
        });
      }
      const persisted = this.dependencies.ledger.terminal(
        intent.fingerprint,
        'succeeded',
        this.now(),
      );
      if (persisted.kind !== 'applied') return { kind: 'indeterminate' };
      const acknowledged = await attempt.acknowledge();
      if (acknowledged.kind !== 'applied') return { kind: 'indeterminate' };
      this.attempts.delete(intent.fingerprint);
      this.claims.delete(intent.fingerprint);
      this.committed.delete(intent.fingerprint);
      this.claimedFingerprints.delete(intent.fingerprint);
      return { kind: 'recovered' };
    } catch {
      credentialProfileApplication.add(1, {
        source: 'recovery',
        capability: attempt.capability,
        outcome: 'failed',
        scope: intent.scope,
        reason: 'adoption_failed',
      });
      // Commit is no longer possible. Mark compensation before any rollback,
      // restoration, or quarantine call can fail, then resolve it only after
      // every local and Adapter cleanup step has proven successful.
      const marked = this.markCompensationRequired(intent, 'resumed', false);
      if (marked.kind !== 'applied') return { kind: 'indeterminate' };
      const rolledBack = await this.rollback(intent, 'adoption_failed');
      const restored = await this.restoreOrQuarantine(intent);
      if (!rolledBack || !restored) {
        void this.drainScopedCompensation();
        return { kind: 'indeterminate' };
      }
      const resolved = this.dependencies.ledger.resolveCompensation(
        intent.fingerprint,
        this.now(),
      );
      if (resolved.kind !== 'applied') return { kind: 'indeterminate' };
      this.claimedFingerprints.delete(intent.fingerprint);
      return { kind: 'rolled-back' };
    }
  }

  async abandon(
    intent: ConnectionRecoveryIntent,
  ): Promise<CredentialRecoveryOutcome> {
    const rolledBack = await this.rollback(intent, 'conflict');
    if (!rolledBack) {
      const current = this.dependencies.ledger.find(intent.fingerprint);
      if (
        this.claimedFingerprints.has(intent.fingerprint) &&
        (current?.outcome === 'resumed' || current?.outcome === 'canceled')
      ) {
        const marked = this.markCompensationRequired(intent, current.outcome);
        if (marked.kind !== 'applied') return { kind: 'indeterminate' };
      }
      return { kind: 'indeterminate' };
    }
    this.claimedFingerprints.delete(intent.fingerprint);
    return { kind: 'rolled-back' };
  }

  async reconcile(): Promise<CredentialRecoveryReconciliationOutcome> {
    if (this.startupReconciliationComplete)
      return this.drainScopedCompensation();
    if (this.startupReadiness) return this.startupReadiness;

    // Bulk prepared reconciliation is startup-only. A live terminal must use
    // its process-local claim capability; no second connection can take it.
    const operation = this.reconcileStartupPrepared().catch(() => ({
      kind: 'indeterminate' as const,
      pending: 0,
    }));
    this.startupReadiness = operation.then((outcome) => {
      // A transient inspect/settle/ack failure is itself a durable pending
      // obligation. Do not consume the startup sweep or permanently latch a
      // false-ready Module; the next caller must retry the exact snapshot.
      if (outcome.kind === 'reconciled') {
        this.startupReconciliationComplete = true;
      } else {
        this.startupReadiness = undefined;
      }
      return outcome;
    });
    return this.startupReadiness;
  }

  private async reconcileStartupPrepared(): Promise<CredentialRecoveryReconciliationOutcome> {
    let pending = 0;
    const exactPrepared = this.dependencies.ledger.reconcilePreparedCredentials(
      this.now(),
    );
    for (const prepared of exactPrepared) {
      const { intent } = prepared;
      const state = await prepared.inspect();
      if (
        !state ||
        state.kind === 'unknown' ||
        state.kind === 'indeterminate'
      ) {
        // A missing receipt is idempotent only after this exact ledger row
        // already reached its durable terminal (the prior process may have
        // acknowledged it immediately before crashing).
        if (intent.outcome === 'succeeded') continue;
        // There is durable linkage but no exact registry truth. Keep the
        // ledger indeterminate and linked for a later exact probe; broad
        // rollback could erase a successor that this row cannot name.
        pending += 1;
        continue;
      }
      if (state.kind === 'adopted' || state.kind === 'already-adopted') {
        const terminal =
          intent.outcome === 'succeeded'
            ? { kind: 'applied' as const }
            : this.dependencies.ledger.terminal(
                intent.fingerprint,
                'succeeded',
                this.now(),
              );
        if (
          terminal.kind !== 'applied' ||
          (await prepared.acknowledge()).kind !== 'applied'
        )
          pending += 1;
        continue;
      }
      const marked = this.dependencies.ledger.compensationRequired(
        intent.fingerprint,
        this.now(),
        intent.outcome === 'resumed' ? 'resumed' : 'indeterminate',
      );
      if (marked.kind !== 'applied') {
        pending += 1;
        continue;
      }
      if (state.kind === 'staged') {
        const rolledBack = await prepared.settle('rollback');
        if (
          rolledBack?.kind !== 'rolled-back' &&
          rolledBack?.kind !== 'already-rolled-back'
        ) {
          pending += 1;
          continue;
        }
      }
      const terminal = this.dependencies.ledger.resolveCompensation(
        intent.fingerprint,
        this.now(),
      );
      if (
        terminal.kind !== 'applied' ||
        (await prepared.acknowledge()).kind !== 'applied'
      )
        pending += 1;
    }
    // Legacy prepared rows predate the durable registry key. They cannot name
    // a candidate safely, so startup quarantines the recovery itself instead
    // of invoking an identity-free cleanup that could disturb a successor.
    let quarantined = 0;
    const legacyPrepared = this.dependencies.ledger.reconcilePrepared(
      this.now(),
      'profile',
      // A linked exact attempt has its own receipt authority. It must never
      // enter the identity-free legacy sweep, even after an unknown inspect.
      true,
    );
    for (const intent of legacyPrepared) {
      const marked = this.dependencies.ledger.terminal(
        intent.fingerprint,
        'failed',
        this.now(),
      );
      if (marked.kind === 'applied') {
        quarantined += 1;
        credentialProfileApplication.add(1, {
          source: 'recovery',
          capability: 'unsupported',
          outcome: 'failed',
          scope: intent.scope,
          reason: 'legacy_unlinked_quarantined',
        });
      } else pending += 1;
    }
    if (pending > 0 || exactPrepared.length > 0 || legacyPrepared.length > 0) {
      const adapter = this.dependencies.adapter;
      // Exact and legacy preparation are independent of existing compensation
      // markers. A transient receipt inspect/terminal failure must block only
      // the identity-free orphan sweep, never starve an unrelated exact
      // compensation that this Module can still settle safely.
      const scoped = adapter.rollbackPending
        ? await this.reconcileScopedWithLaterMarkers(adapter)
        : ({ kind: 'reconciled', recovered: 0 } as const);
      if (pending > 0) {
        return {
          kind: 'indeterminate',
          pending:
            pending + (scoped.kind === 'indeterminate' ? scoped.pending : 0),
        };
      }
      // Exact receipts suppress only the unsafe unscoped orphan sweep. Legacy
      // rows are terminally quarantined above. Both still admit the scoped
      // drain that owns independent durable compensation markers.
      return scoped.kind === 'reconciled'
        ? { kind: 'reconciled', recovered: scoped.recovered + quarantined }
        : scoped;
    }
    // Exact rows settle through their private handles. Legacy rows are
    // terminally quarantined above. Existing scoped compensation still runs
    // through the Adapter; only the legacy path may never authorize broad
    // cleanup.
    const adapter = this.dependencies.adapter;
    if (!adapter.rollbackPending)
      return { kind: 'reconciled', recovered: quarantined };
    const reconciled = await this.reconcileStartup(adapter);
    return reconciled.kind === 'reconciled'
      ? { kind: 'reconciled', recovered: reconciled.recovered + quarantined }
      : reconciled;
  }

  /** Live retry drains only existing compensation markers, never prepared work. */
  private drainScopedCompensation(): Promise<CredentialRecoveryReconciliationOutcome> {
    const adapter = this.dependencies.adapter;
    if (!adapter.rollbackPending)
      return Promise.resolve({ kind: 'reconciled', recovered: 0 });
    if (this.reconciliation) return this.reconciliation;
    this.reconciliation = this.reconcileScopedWithLaterMarkers(adapter)
      .catch(() => ({ kind: 'indeterminate' as const, pending: 0 }))
      .finally(() => {
        this.reconciliation = undefined;
      });
    return this.reconciliation;
  }

  private async indeterminateProfileDispatch(
    intent: ConnectionRecoveryIntent,
    attempt: { indeterminate(now: string): { kind: string } },
  ): Promise<CredentialRecoveryOutcome> {
    // First make retry impossible.  Every fallible cleanup runs after this
    // durable authority exists, so neither an Adapter throw nor a restart
    // failure can re-arm a possibly invoked provider turn.
    const markedIndeterminate = attempt.indeterminate(this.now());
    if (markedIndeterminate.kind !== 'applied') return { kind: 'conflicted' };
    const compensation = this.markCompensationRequired(
      intent,
      'indeterminate',
      false,
    );
    if (compensation.kind !== 'applied') return { kind: 'indeterminate' };
    const restored = await this.restoreOrQuarantine(intent);
    const hasExactAttempt = this.attempts.has(intent.fingerprint);
    const rolledBack = await this.rollback(intent, 'adoption_failed');
    if (hasExactAttempt && rolledBack && restored) {
      const resolved = this.dependencies.ledger.resolveCompensation(
        intent.fingerprint,
        this.now(),
      );
      if (resolved.kind === 'applied') this.claims.delete(intent.fingerprint);
    } else {
      void this.drainScopedCompensation();
    }
    return { kind: 'indeterminate' };
  }

  private async stage(
    intent: ConnectionRecoveryIntent,
    recoveryFingerprint: string,
  ): Promise<CredentialProfileStageOutcome> {
    try {
      const outcome = await this.dependencies.adapter.stage({
        provider: intent.provider,
        failure: { kind: intent.failureKind, scope: intent.scope, timing: {} },
        recoveryFingerprint,
      });
      if (outcome.kind !== 'staged') return outcome;
      if (outcome.attempt.capability !== 'restart_resume') {
        if (outcome.attempt.capability === 'hot_apply') {
          credentialProfileApplication.add(1, {
            source: 'recovery',
            capability: 'hot_apply',
            outcome: 'rejected',
            scope: intent.scope,
            reason: 'unsupported',
          });
        }
        return { kind: 'indeterminate', attempt: outcome.attempt };
      }
      credentialProfileApplication.add(1, {
        source: 'recovery',
        capability: outcome.attempt.capability,
        outcome: 'staged',
        scope: intent.scope,
        reason: 'account_exhausted',
      });
      return outcome;
    } catch {
      credentialProfileApplication.add(1, {
        source: 'recovery',
        capability: 'unsupported',
        outcome: 'rejected',
        scope: intent.scope,
        reason: 'conflict',
      });
      return { kind: 'indeterminate' };
    }
  }

  private async rollback(
    intent: ConnectionRecoveryIntent,
    reason: 'adoption_failed' | 'conflict',
  ): Promise<boolean> {
    const attempt = this.attempts.get(intent.fingerprint);
    if (!attempt) return true;
    try {
      const outcome = await attempt.rollback();
      if (
        outcome.kind !== 'rolled-back' &&
        outcome.kind !== 'already-rolled-back'
      ) {
        return false;
      }
      credentialProfileApplication.add(1, {
        source: 'recovery',
        capability: attempt.capability,
        outcome: 'rolled_back',
        scope: intent.scope,
        reason,
      });
      if (this.attempts.get(intent.fingerprint) === attempt) {
        this.attempts.delete(intent.fingerprint);
      }
      return true;
    } catch {
      credentialProfileApplication.add(1, {
        source: 'recovery',
        capability: attempt.capability,
        outcome: 'failed',
        scope: intent.scope,
        reason,
      });
      return false;
    }
  }

  /**
   * Runtime startup has no candidate identity after a process interruption.
   * The connection Adapter owns the only safe cleanup operation: clear its
   * persisted pending application without selecting a provider. This sweep
   * does not settle any durable intent, so later or cross-provider markers
   * retain their own scoped compensation pass. Startup runs explicit scoped
   * obligations first, then this identity-free sweep; markers written after
   * the scoped snapshot remain durable for their own scoped pass.
   */
  private reconcileOrphans(
    adapter: CredentialProfileRecoveryAdapter,
  ): Promise<CredentialRecoveryReconciliationOutcome> {
    if (this.orphanSweepComplete)
      return Promise.resolve({
        kind: 'reconciled',
        recovered: 0,
      });
    return adapter.rollbackPending!(undefined)
      .then(() => {
        this.orphanSweepComplete = true;
        return { kind: 'reconciled' as const, recovered: 0 };
      })
      .catch(() => ({ kind: 'indeterminate' as const, pending: 0 }));
  }

  private async reconcileStartup(
    adapter: CredentialProfileRecoveryAdapter,
  ): Promise<CredentialRecoveryReconciliationOutcome> {
    const initial = this.compensationSnapshot();
    const scoped = await this.reconcileScopedSnapshot(adapter, initial);
    // Run exactly once even if the scoped pass is indeterminate. It clears
    // only Adapter-owned orphan state and never settles durable markers.
    const orphanSweep = await this.reconcileOrphans(adapter);
    const laterScoped = await this.reconcileNewScopedSnapshots(
      adapter,
      new Set(initial.map((intent) => intent.fingerprint)),
    );
    return this.combineReconciliationOutcomes([
      scoped,
      orphanSweep,
      ...laterScoped,
    ]);
  }

  private async reconcileScopedWithLaterMarkers(
    adapter: CredentialProfileRecoveryAdapter,
  ): Promise<CredentialRecoveryReconciliationOutcome> {
    const initial = this.compensationSnapshot();
    const scoped = await this.reconcileScopedSnapshot(adapter, initial);
    const laterScoped = await this.reconcileNewScopedSnapshots(
      adapter,
      new Set(initial.map((intent) => intent.fingerprint)),
    );
    return this.combineReconciliationOutcomes([scoped, ...laterScoped]);
  }

  /**
   * Each successful snapshot pass acknowledges only the rows it observed.
   * Rows inserted while that Adapter call was pending get a separate pass. A
   * failed pass stops this drain: durable state remains visible and avoids a
   * tight retry loop against an unavailable Adapter.
   */
  private async reconcileNewScopedSnapshots(
    adapter: CredentialProfileRecoveryAdapter,
    observed: Set<string>,
  ): Promise<CredentialRecoveryReconciliationOutcome[]> {
    const outcomes: CredentialRecoveryReconciliationOutcome[] = [];
    while (true) {
      const next = this.compensationSnapshot(observed);
      if (next.length === 0) return outcomes;
      for (const intent of next) observed.add(intent.fingerprint);
      const outcome = await this.reconcileScopedSnapshot(adapter, next);
      outcomes.push(outcome);
      if (outcome.kind === 'indeterminate') return outcomes;
    }
  }

  private compensationSnapshot(excluding = new Set<string>()) {
    return this.dependencies.ledger
      .compensationSnapshot()
      .filter((intent) => !excluding.has(intent.fingerprint));
  }

  private async reconcileScopedSnapshot(
    adapter: CredentialProfileRecoveryAdapter,
    intents: ConnectionRecoveryIntent[],
  ): Promise<CredentialRecoveryReconciliationOutcome> {
    if (intents.length === 0) return { kind: 'reconciled', recovered: 0 };
    const providers = [...new Set(intents.map((intent) => intent.provider))];
    try {
      await adapter.rollbackPending!(providers);
      let recovered = 0;
      for (const intent of intents) {
        const resolved = this.dependencies.ledger.resolveCompensation(
          intent.fingerprint,
          this.now(),
        );
        if (resolved.kind === 'applied') {
          recovered += 1;
          this.attempts.delete(intent.fingerprint);
          this.claims.delete(intent.fingerprint);
          this.committed.delete(intent.fingerprint);
          this.claimedFingerprints.delete(intent.fingerprint);
        }
      }
      return recovered === intents.length
        ? { kind: 'reconciled', recovered }
        : { kind: 'indeterminate', pending: intents.length - recovered };
    } catch {
      return { kind: 'indeterminate', pending: intents.length };
    }
  }

  private combineReconciliationOutcomes(
    outcomes: readonly CredentialRecoveryReconciliationOutcome[],
  ): CredentialRecoveryReconciliationOutcome {
    if (outcomes.some((outcome) => outcome.kind === 'indeterminate')) {
      return {
        kind: 'indeterminate',
        pending: this.compensationSnapshot().length,
      };
    }
    return {
      kind: 'reconciled',
      recovered: outcomes.reduce(
        (count, outcome) =>
          count + (outcome.kind === 'reconciled' ? outcome.recovered : 0),
        0,
      ),
    };
  }

  private async restoreOrQuarantine(
    intent: ConnectionRecoveryIntent,
  ): Promise<boolean> {
    try {
      await this.dependencies.restoreSession({
        threadId: intent.threadId,
        signal: new AbortController().signal,
      });
      return true;
    } catch {
      try {
        if (!this.dependencies.quarantineSession) return false;
        await this.dependencies.quarantineSession(intent.threadId);
        return true;
      } catch {
        return false;
      }
    }
  }

  private markCompensationRequired(
    intent: ConnectionRecoveryIntent,
    expectedOutcome: 'resumed' | 'canceled' | 'indeterminate' = 'resumed',
    schedule = true,
  ): RecoveryTransition {
    const marked = this.dependencies.ledger.compensationRequired(
      intent.fingerprint,
      this.now(),
      expectedOutcome,
    );
    if (marked.kind === 'applied' && schedule)
      void this.drainScopedCompensation();
    return marked;
  }

  private now(): string {
    return this.dependencies.now().toISOString();
  }
}

/** Creates the one recovery Module at the orchestration/connection Seam. */
export function createCredentialRecoveryModule(
  dependencies: CredentialRecoveryImplementationDependencies,
): CredentialRecoveryModule {
  return new CredentialRecoveryImplementation(dependencies);
}
