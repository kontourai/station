import type { ProviderKind } from '@kontourai/station-contracts/provider';
import type { CanonicalRuntimeEvent } from '@kontourai/station-contracts/runtime-events';
import { interruptibleTurnIdForEvents } from './session-lifecycle-service.js';

export interface InternalStopSuppressionDeps {
  /** The narrowed durable read `arm()`'s docblock prescribes. */
  listActiveTurnFoldEventPayloads: (
    threadId: string,
  ) => CanonicalRuntimeEvent[];
  emitRedispatchFailed: (payload: {
    threadId: string;
    turnId: string;
    provider: ProviderKind;
  }) => void;
}

/**
 * Internal-stop push suppression (epic #4024 slice 4, #4144): the C5 cluster
 * from the seam map — the cleanest ownership island in the service (one Set,
 * four methods, one external consumer via the service's
 * `consumeInternalStopSuppression` forwarder). The field's full rationale —
 * station#3525 and both fix rounds — moves with it, verbatim, below.
 */
export class InternalStopSuppression {
  /**
   * station#3525: turn ids whose owning session is being stopped by internal
   * Station machinery (a credential-profile recovery restart, or connection-
   * smoke cleanup) rather than a user action or a genuine unattended
   * mid-turn death. `stopSession` on some adapters (codex, station#3473)
   * synthesizes a turn-scoped `runtime.error` for a still-open turn before
   * `session.exited` — correct when a user's session actually died, but
   * wrong here IF the internal stop's own follow-through actually happens:
   * for the credential-restart case, Station means to transparently
   * re-dispatch the exact same turn, and a "your agent needs attention"
   * push about a retry-in-progress would be the opposite of the
   * differentiator this notification path exists for. That "if" is load
   * -bearing — see the FIX 1 paragraph below.
   *
   * Keyed by turn id (armed via `arm()` before the stop
   * call), not a time window: `wireTurnCompletionNotifications` consumes an
   * entry exactly once, against the one event it exists to suppress (and
   * only for a `'failed'` outcome — see that call site), so correctness does
   * not depend on how the adapter's fire-and-forget event stream happens to
   * interleave with the awaited `stopSession()` call.
   *
   * FIX 1 (fix round, BLOCKING — the arm is unconditional, but the premise
   * above is conditional): arming happens before `stopSession`, but the rest
   * of a credential-profile restart can still fail — `throwIfAborted`,
   * `resolveSessionAgentForStart` (deliberately fail-closed),
   * `admitEngineStart`, `adapter.startSession` all run AFTER the arm, and
   * this is a path entered *because credentials just failed*, so
   * `startSession` failing again is a likely outcome, not an edge case.
   * Probe-proven: with `adapter.startSession.mockRejectedValueOnce(...)`,
   * the restart rejects, the orphaned `runtime.error` for the stopped turn
   * lands durably, and — before this fix — the push that SHOULD fire
   * (nothing is retrying any more) was silently swallowed instead, trading
   * #3525's false positive for a false negative on the same surface #3525
   * itself calls "the one surface that reaches a user who is deliberately
   * not looking." `arm()` returns the armed turn id (or
   * `undefined`) so every caller can `rescind()` it
   * once it knows whether a real re-dispatch actually followed —
   * `restartCredentialProfileProviderSession` rescinds for failures in its
   * own body, `restartCredentialProfileRecoverySession` rescinds if its
   * follow-up `sendTurn` then fails, and `CredentialProfileRecovery.restoreSession`
   * (which never dispatches at all) rescinds unconditionally.
   *
   * FIX 2 (fix round): `arm()` reads
   * `listEventsByMethods` narrowed to exactly the canonical
   * terminal/lifecycle methods the fold inspects — NOT the unbounded
   * `listEvents` an earlier version of this fix used, and NOT the bounded
   * `listSessionProjectionEvents` projection `interruptUserTurnCooperatively`
   * uses (they were never "the same fold" despite an earlier version of this
   * comment claiming that). Independent review proved live, against the real
   * `OrchestrationService`, that the bounded projection retains only turn
   * 1's `turn.started` (via `firstTurnStartedWithPrompt`) plus a SINGLE
   * latest-lifecycle-method row (`session.state-changed`/`request.resolved`
   * both count, and neither updates the fold's `activeTurnId`) — so once a
   * lifecycle-method row supersedes the open turn's own `turn.started`, that
   * fold silently returns the CLOSED turn 1 instead of the genuinely open
   * one. `listEvents` fixed the correctness bug but is the wrong instrument:
   * station#3559 fix round correction — the cost `listEventsByMethods`
   * actually avoids here is fewer SQL rows plus skipping `JSON.parse` of
   * every excluded row's payload, NOT attachment-blob hydration:
   * `mapEventRow`'s `hydrateAttachments` fires only on `turn.started`, which
   * this narrowed list retains, so that cost is paid identically by
   * `listEvents` and `listEventsByMethods` either way (see
   * `arm()`'s own docblock for the corrected account).
   * `listEventsByMethods` is a narrowing, not a truncation like the bounded
   * projection was: every OTHER canonical method is a pass-through no-op for
   * this fold, so it is bit-identical to folding the full log at a fraction
   * of the read cost (measured ~8x on a 12k-row synthetic thread — an upper
   * bound, from an attachment-free fixture) — the same "narrow the query,
   * not the semantics" idiom `listOwnershipEventsByThread` already
   * establishes.
   * Still not literally "the adapter's own in-memory `activeTurnId`" (no
   * passive query for that exists on `ProviderAdapterShape`, and adding one
   * was judged too large a change for this fix) — a narrow residual gap
   * remains if the adapter's in-memory state has moved before the
   * corresponding event is durably persisted, symmetric with every other
   * durable-projection reader in this file.
   *
   * Quarantine (`quarantinedThreads`) already suppresses this path's events
   * too, so it is not routed through here — but not because it targets only
   * "non-terminal" events (an earlier version of this comment said that):
   * `publishCanonicalEvent`'s quarantine gate drops EVERYTHING except
   * `session.exited` for a quarantined thread, terminals included, and
   * `runtime.error` is itself a canonical terminal
   * (`session-recovery-coordinator.ts`'s `replayObservedTerminal` docblock).
   * `cleanupObsoleteStartedSession` needs no call here either, but NOT
   * because "no turn id is ever open in the durable log" (false in general —
   * a resumed thread can carry old turn history the bounded-projection bug
   * above could still misread as open): it is safe because it runs
   * immediately after a freshly-constructed `adapter.startSession()`, before
   * any `sendTurn` is ever dispatched through that adapter instance, so the
   * adapter's own IN-MEMORY `activeTurnId` — what codex's synthesis actually
   * reads — cannot be set there regardless of what any durable read returns.
   */
  private readonly internalStopTurnIds = new Set<string>();

  constructor(private readonly deps: InternalStopSuppressionDeps) {}

  consume(turnId: string): boolean {
    return this.internalStopTurnIds.delete(turnId);
  }

  /**
   * station#3525: arms turn-id-scoped push suppression for a stop this
   * process is about to initiate as internal machinery — call immediately
   * before invoking whatever mechanism actually tears the session down
   * (`adapter.stopSession`, or the `stopSession` command dispatch). A no-op
   * when the thread has no currently open turn.
   *
   * Returns the armed turn id (or `undefined` when the thread has no open
   * turn), so a caller whose subsequent re-dispatch never happens can
   * rescind it explicitly — see `rescind` and its call sites for why that
   * matters (fix round, FIX 1).
   *
   * station#3525 fix round FIX 2: reads via
   * `deps.listActiveTurnFoldEventPayloads` — `listEventsByMethods` narrowed
   * to `ACTIVE_TURN_FOLD_METHODS`, exactly the canonical terminal/lifecycle
   * methods `nextActiveTurnId`'s fold actually inspects — not the unbounded
   * `listEvents`. Narrowing to this method list is not a truncation like the
   * bounded projection was: `nextActiveTurnId` treats every OTHER canonical
   * method as a pass-through no-op, so the fold is bit-identical to folding
   * the full log (pinned by a differential test against all 27 canonical
   * methods), at a fraction of the read cost — fewer rows returned by the
   * SQL query plus skipping `JSON.parse` of every excluded row's payload
   * (station#3559 fix round: NOT attachment-blob hydration, which fires only
   * on `turn.started` and is retained by this list either way, so is paid
   * identically by both variants — measured ~8x on a 12k-row synthetic
   * thread with no attachments, an upper bound that narrows toward 1x as
   * attachment weight grows) — the same "narrow the query, not the
   * semantics" idiom `listOwnershipEventsByThread` already establishes
   * elsewhere in the store.
   */
  arm(threadId: string): string | undefined {
    const turnId = interruptibleTurnIdForEvents(
      this.deps.listActiveTurnFoldEventPayloads(threadId),
    );
    if (!turnId) return undefined;
    this.internalStopTurnIds.add(turnId);
    // Leak-prevention only (see `internalStopTurnIds`'s doc), not the
    // correctness-bearing path — that is `consume`'s exact-match-and-delete.
    // Generous on purpose: `stopSession` at this call site has no deadline
    // wrapper (unlike the smoke path's `runCleanupWithinDeadline`), so a
    // slow provider stop really can outlive a short bound — a fired timer
    // means suppression silently stops working for this entry past that
    // point (fail-open, a missed suppression), not a false one, but it is a
    // real, disclosed gap: this bound does not guarantee `stopSession`
    // finishes first, only make it unlikely for a well-behaved adapter.
    setTimeout(
      () => this.internalStopTurnIds.delete(turnId),
      10 * 60_000,
    ).unref?.();
    return turnId;
  }

  rescind(turnId: string | undefined): void {
    if (turnId) this.internalStopTurnIds.delete(turnId);
  }

  reportRedispatchFailed(
    threadId: string,
    turnId: string | undefined,
    provider: ProviderKind,
  ): void {
    if (!turnId) return;
    this.rescind(turnId);
    this.deps.emitRedispatchFailed({ threadId, turnId, provider });
  }
}
