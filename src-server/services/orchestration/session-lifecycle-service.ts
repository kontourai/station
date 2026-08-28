import crypto from 'node:crypto';
import type { TerminalAttribution } from '@kontourai/station-contracts/orchestration';
import type { ProviderSession } from '@kontourai/station-contracts/provider';
import {
  type CanonicalRuntimeEvent,
  isDeferredRetriableTurnError,
  type SessionState,
} from '@kontourai/station-contracts/runtime-events';
import type {
  SessionLifecycleState,
  SessionTransitionReason,
  SessionTransitionSource,
} from '../../../packages/contracts/src/session-lifecycle.js';
import {
  canSessionLifecycleStateResume,
  isSessionLifecycleStateStopped,
  validateSessionLifecycleTransition,
} from '../../../packages/contracts/src/session-lifecycle.js';

interface LifecycleProjection {
  lifecycleState: SessionLifecycleState;
  previousLifecycleState?: SessionLifecycleState;
  transitionReason?: SessionTransitionReason;
  transitionSource?: SessionTransitionSource;
  pendingReview: boolean;
  blockedReason?: string;
  terminalAttribution?: TerminalAttribution;
  projectSlug?: string;
  projectLayoutSlug?: string;
  assignedAgentSlug?: string;
}

/** The detail budget for a terminal attribution's compact one-line notice. */
export const TERMINAL_ATTRIBUTION_DETAIL_MAX_CHARS = 240;

export interface ManualSessionTransitionInput {
  provider: string;
  threadId: string;
  from: SessionLifecycleState;
  to: SessionLifecycleState;
  reason: SessionTransitionReason;
  source: SessionTransitionSource;
  message?: string;
}

export function normalizeCanonicalRuntimeEventLifecycle(
  event: CanonicalRuntimeEvent,
  previousState?: SessionLifecycleState,
  activeTurnId?: string,
): CanonicalRuntimeEvent {
  const transition = deriveLifecycleTransition(
    event,
    previousState,
    activeTurnId,
  );
  if (!transition) return event;
  const next: CanonicalRuntimeEvent = {
    ...event,
    sessionState: event.sessionState ?? transition.to,
    previousState: event.previousState ?? transition.from,
    transitionReason: event.transitionReason ?? transition.reason,
    transitionSource: event.transitionSource ?? transition.source,
  };

  if (next.method === 'session.state-changed') {
    return {
      ...next,
      sessionState: next.sessionState,
      previousState: next.previousState,
    };
  }

  return next;
}

export function createManualSessionTransitionEvent(
  input: ManualSessionTransitionInput,
): CanonicalRuntimeEvent {
  const validation = validateSessionLifecycleTransition(input.from, input.to);
  if (!validation.ok) {
    throw new Error(validation.message ?? validation.code);
  }

  const createdAt = new Date().toISOString();
  return {
    eventId: crypto.randomUUID(),
    provider: input.provider,
    threadId: input.threadId,
    createdAt,
    method: 'session.state-changed',
    sessionId: input.threadId,
    from: lifecycleStateToRuntimeSessionState(input.from),
    to: lifecycleStateToRuntimeSessionState(input.to),
    reason: input.message ?? input.reason,
    sessionState: input.to,
    previousState: input.from,
    transitionReason: input.reason,
    transitionSource: input.source,
  };
}

export function projectSessionLifecycle(options: {
  session: ProviderSession;
  events: CanonicalRuntimeEvent[];
}): LifecycleProjection {
  let lifecycleState = providerStatusToLifecycleState(options.session.status);
  let previousLifecycleState: SessionLifecycleState | undefined;
  let transitionReason: SessionTransitionReason | undefined;
  let transitionSource: SessionTransitionSource | undefined;
  let pendingReview = false;
  let blockedReason: string | undefined;
  let terminalEvent: CanonicalRuntimeEvent | undefined;
  let projectSlug: string | undefined;
  let projectLayoutSlug: string | undefined;
  let assignedAgentSlug: string | undefined;

  const resolvedRequestIds = new Set(
    options.events
      .filter((event) => event.method === 'request.resolved')
      .map((event) => event.requestId),
  );

  // archive#3581: this local fold is ONLY ever read by the
  // `deriveLifecycleTransition` call immediately below — nothing else in
  // this function inspects it — so it can track `nextTurnIdentityAnchor`
  // (which retains a turn id across the error/exit that would otherwise
  // discard it) without disturbing `nextActiveTurnId`'s "is a turn open"
  // semantics anywhere else. See `nextTurnIdentityAnchor`'s doc.
  let turnIdentityAnchor: string | undefined;
  for (const event of options.events) {
    const transition = deriveLifecycleTransition(
      event,
      lifecycleState,
      turnIdentityAnchor,
    );
    if (transition) {
      previousLifecycleState = transition.from;
      lifecycleState = transition.to;
      transitionReason = event.transitionReason ?? transition.reason;
      transitionSource = event.transitionSource ?? transition.source;
      terminalEvent = isSessionLifecycleStateStopped(transition.to)
        ? event
        : undefined;
    }
    turnIdentityAnchor = nextTurnIdentityAnchor(turnIdentityAnchor, event);

    if (
      event.method === 'session.started' ||
      event.method === 'session.configured'
    ) {
      projectSlug =
        readStringMetadata(event.metadata, 'projectSlug') ?? projectSlug;
      projectLayoutSlug =
        readStringMetadata(event.metadata, 'projectLayoutSlug') ??
        projectLayoutSlug;
      assignedAgentSlug =
        readStringMetadata(event.metadata, 'assignedAgentSlug') ??
        readStringMetadata(event.metadata, 'agentSlug') ??
        assignedAgentSlug;
    }

    if (event.method === 'session.state-changed' && event.sessionState) {
      previousLifecycleState = event.previousState ?? lifecycleState;
      lifecycleState = event.sessionState;
      transitionReason = event.transitionReason ?? transitionReason;
      transitionSource = event.transitionSource ?? transitionSource;
      if (event.sessionState === 'blocked') {
        blockedReason = event.reason ?? blockedReason;
      }
      terminalEvent = isSessionLifecycleStateStopped(event.sessionState)
        ? event
        : undefined;
    }
  }

  const pendingReviewFromLog = options.events.some(
    (event) =>
      event.method === 'request.opened' &&
      event.requestType !== 'input' &&
      !resolvedRequestIds.has(event.requestId),
  );
  // archive#1296: a request that predates the session's own ending
  // (turn.completed / session.exited / a manual terminal
  // session.state-changed — every one of which the fold above already
  // applied to `lifecycleState`) cannot still "need review": the work is
  // over, so nothing is watching for that approval anymore. Reconciling
  // against the CURRENT lifecycle state — rather than a pure union replayed
  // over the whole persisted log forever — is what stops a resolution that
  // bypassed respondToRequest/stopSession (lost in-memory pending entry, a
  // server restart, ...) from pinning this permanently.
  //
  // archive#1548: the concept that makes a request moot is that the work
  // CANNOT RESUME, not that the state is terminal. archive#1314 reached for a
  // local hardcoded terminality predicate that counted `failed`, but the
  // contract declares `failed -> queued | running`: a failed session is
  // retryable, so an approval opened before the failure is still genuinely
  // outstanding and zeroing it produced no attention item at all. The
  // predicate is now `canSessionLifecycleStateResume`, derived from
  // SESSION_LIFECYCLE_TRANSITIONS, so this can no longer drift from the
  // contract. What archive#1296 was protecting — a cleanly `completed` (or
  // `canceled`) session pinned "Attention needed" with no way to dismiss —
  // is protected unchanged: neither state can resume.
  pendingReview =
    pendingReviewFromLog && canSessionLifecycleStateResume(lifecycleState);

  if (
    pendingReview &&
    lifecycleState !== 'blocked' &&
    // Deliberately the WIDER `stopped` set here, not `canResume`: a stopped
    // state records how the session ended, and relabelling it
    // 'review_pending' would hide that. `failed` is stopped and resumable —
    // it keeps `pendingReview` above (so the approval still surfaces) while
    // still reading 'failed' here (so the failure still surfaces too).
    !isSessionLifecycleStateStopped(lifecycleState)
  ) {
    previousLifecycleState =
      lifecycleState === 'review_pending'
        ? previousLifecycleState
        : lifecycleState;
    lifecycleState = 'review_pending';
    transitionReason = 'review_requested';
    transitionSource = 'runtime';
  }

  const lastBlockingError = [...options.events]
    .reverse()
    .find((event) => event.method === 'runtime.error');
  if (!blockedReason && lastBlockingError?.method === 'runtime.error') {
    blockedReason = lastBlockingError.message;
  }
  // archive#3451 finding 2: a `session.exited` crash (a defined, nonzero
  // exitCode — the same observation `deriveLifecycleTransition`'s
  // 'session.exited' case already folds to `failed`) is otherwise the one
  // 'failed' path with no `runtime.error` to read a cause from, so the UI
  // rendered "No failure detail was recorded" even though the one fact we DO
  // have (the exit code) was sitting right there. Only fills a gap
  // `runtime.error` left open; never overrides a real reported cause.
  if (!blockedReason && lifecycleState === 'failed') {
    const exitFailure = [...options.events]
      .reverse()
      .find(
        (event) =>
          event.method === 'session.exited' &&
          event.exitCode !== undefined &&
          event.exitCode !== 0,
      );
    if (exitFailure?.method === 'session.exited') {
      blockedReason = `Session process exited with code ${exitFailure.exitCode}.`;
    }
  }
  // UX audit V3: the last gap. A session can reach `failed` from the engine
  // binding's own persisted status alone (`error`/`dead` seeds this fold at
  // 'failed' before the loop runs) with no `runtime.error` and no exit code
  // in the window — a transcript that stops mid-word under a red chip and,
  // where the reason should be, "No failure detail was recorded." The binding
  // status is not a rich cause, but it is a real observation and it is the
  // one we have; naming it beats naming nothing.
  if (!blockedReason && lifecycleState === 'failed') {
    if (options.session.status === 'dead') {
      blockedReason =
        "This session's engine process is gone; the turn it was running never finished.";
    } else if (options.session.status === 'error') {
      blockedReason =
        "This session's engine binding is in an error state; the turn it was running never finished.";
    }
  }

  const terminalAttribution = projectTerminalAttribution({
    lifecycleState,
    terminalEvent,
    events: options.events,
  });

  return {
    lifecycleState,
    ...(previousLifecycleState ? { previousLifecycleState } : {}),
    ...(transitionReason ? { transitionReason } : {}),
    ...(transitionSource ? { transitionSource } : {}),
    pendingReview,
    ...(blockedReason ? { blockedReason } : {}),
    ...(terminalAttribution ? { terminalAttribution } : {}),
    ...(projectSlug ? { projectSlug } : {}),
    ...(projectLayoutSlug ? { projectLayoutSlug } : {}),
    ...(assignedAgentSlug ? { assignedAgentSlug } : {}),
  };
}

/**
 * Derives the one compact explanation for the CURRENT stopped outcome.
 *
 * The order below is the contract. It uses the accepted terminal transition
 * from this projection pass, so a Stop from an earlier run cannot label a
 * later failure after the session restarted:
 *
 * 1. a matching requested settled stop;
 * 2. a matching stall-initiated settled stop;
 * 3. a meaningful runtime-error message on the terminal event;
 * 4. an explicit timeout code on that event;
 * 5. an explicit no-output code on that event;
 * 6. a non-zero exit code on that event.
 *
 * There is deliberately no fallback. A stopped session without one of these
 * facts remains unattributed rather than having an invented exit or cause.
 */
function projectTerminalAttribution(options: {
  lifecycleState: SessionLifecycleState;
  terminalEvent: CanonicalRuntimeEvent | undefined;
  events: CanonicalRuntimeEvent[];
}): TerminalAttribution | undefined {
  if (!isSessionLifecycleStateStopped(options.lifecycleState)) return undefined;

  const terminalTurnId = options.terminalEvent?.turnId;
  const settledStops = terminalTurnId
    ? options.events.filter(
        (
          event,
        ): event is Extract<
          CanonicalRuntimeEvent,
          {
            method: 'session.stop-settled';
          }
        > =>
          event.method === 'session.stop-settled' &&
          event.turnId === terminalTurnId,
      )
    : [];
  // `initiatedBy: 'user'` means a cooperative stop was REQUESTED through the
  // public interrupt path; it does not prove a human issued that request
  // (an agent-callable control tool reaches the same path). The label and
  // copy therefore describe the durable fact, never an inferred actor.
  if (settledStops.some((event) => event.initiatedBy === 'user')) {
    return { kind: 'requested_stop', detail: 'Stopped by request.' };
  }
  if (settledStops.some((event) => event.initiatedBy === 'stall')) {
    return {
      kind: 'stall_stop',
      detail: 'Station stopped it after no progress was detected.',
    };
  }

  if (options.terminalEvent?.method === 'runtime.error') {
    const detail = compactTerminalDetail(
      options.terminalEvent.message,
      'The engine reported an error: ',
    );
    if (detail) return { kind: 'runtime_error', detail };

    if (isTimeoutEvidence(options.terminalEvent.code)) {
      return {
        kind: 'timeout',
        detail: 'Station ended the session after it timed out.',
      };
    }
    if (isNoOutputEvidence(options.terminalEvent.code)) {
      return {
        kind: 'no_output',
        detail: 'The engine ended without output.',
      };
    }
  }

  if (
    options.terminalEvent?.method === 'session.exited' &&
    options.terminalEvent.exitCode !== undefined &&
    options.terminalEvent.exitCode !== 0
  ) {
    return {
      kind: 'exit',
      detail: `The engine exited with code ${options.terminalEvent.exitCode}.`,
    };
  }

  return undefined;
}

function compactTerminalDetail(
  value: string | undefined,
  prefix = '',
): string | undefined {
  // Adapters may append a captured output tail to an otherwise useful error
  // sentence. It belongs in the transcript, not this one-line inbox
  // projection; retain only the human-shaped prefix before that excerpt.
  // This is compacting, not secret detection: the same authorized viewer can
  // read the transcript, so this projection neither adds a claim to detect
  // secrets nor treats absence of a detector as clearance.
  const firstLine = (
    value
      ? stripTerminalControlCharacters(value.split(/\r?\n/, 1)[0])
      : undefined
  )
    ?.replace(/\s+(?:[a-z][\w-]*\s+)?(?:output|stdout|stderr)\s*:\s*.*/i, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!firstLine) return undefined;
  const detail = `${prefix}${firstLine}`;
  if (detail.length <= TERMINAL_ATTRIBUTION_DETAIL_MAX_CHARS) {
    return detail;
  }
  return `${detail.slice(0, TERMINAL_ATTRIBUTION_DETAIL_MAX_CHARS - 1)}…`;
}

function stripTerminalControlCharacters(value: string): string {
  let clean = '';
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    // ANSI CSI escape: ESC [ parameter/intermediate bytes final-byte.
    if (code === 0x1b && value.charCodeAt(index + 1) === 0x5b) {
      index += 2;
      while (index < value.length) {
        const candidate = value.charCodeAt(index);
        if (candidate >= 0x40 && candidate <= 0x7e) break;
        index += 1;
      }
      continue;
    }
    if (code === 0x09 || code === 0x0b || code === 0x0c) {
      clean += ' ';
      continue;
    }
    if (code < 0x20 || code === 0x7f) continue;
    clean += value[index];
  }
  return clean;
}

function isTimeoutEvidence(code: string | undefined): boolean {
  return code === 'muse-turn-timeout' || code === 'turn-timeout';
}

function isNoOutputEvidence(code: string | undefined): boolean {
  return (
    code === 'no-output' || code === 'no_output' || code === 'empty-output'
  );
}

/**
 * Returns the locally tracked in-flight turn. A terminal event may close that
 * slot only when it names that turn; an orphaned terminal event must not erase
 * a real turn that is still starting/running.
 */
export function activeTurnIdForEvents(
  events: CanonicalRuntimeEvent[],
): string | undefined {
  let activeTurnId: string | undefined;
  for (const event of events) {
    activeTurnId = nextActiveTurnId(activeTurnId, event);
  }
  return activeTurnId;
}

/**
 * archive#3473 (paths 3/4): the turn id a user-initiated Stop — or the stall
 * watchdog's forced-stop, once archive#2959's observe-only decision lifts — should
 * still target. Deliberately NOT the same fold as `activeTurnIdForEvents`:
 * that function (and the `hasActiveTurn`/board reads built on it) is a
 * considered, tested tradeoff — `orchestration-session-state.ts`'s
 * `hasOpenTurn` docblock and the pinned
 * "is false after a codex-adapter-shaped turn error" test both document that
 * a codex deferred-retriable `runtime.error` (willRetry) is treated as
 * closing the turn for DISPLAY, because a permanently-stuck-`true` reading is
 * worse than a self-healing under-report. That tradeoff must not move.
 *
 * Stop is not a display, though: re-deriving "no active turn" from that same
 * fold made `interruptUserTurnCooperatively` early-return without even
 * attempting `adapter.interruptTurn` — Stop became a silent no-op in exactly
 * the window a user is most likely to reach for it (codex retrying after a
 * transient error). This fold keeps that turn interruptible until a REAL
 * terminal event (a genuine `turn.completed`/`turn.aborted`, a non-deferred
 * `runtime.error`, or `session.exited`) closes it.
 */
export function interruptibleTurnIdForEvents(
  events: CanonicalRuntimeEvent[],
): string | undefined {
  let activeTurnId: string | undefined;
  for (const event of events) {
    activeTurnId = nextActiveTurnId(activeTurnId, event, {
      preserveDeferredRetry: true,
    });
  }
  return activeTurnId;
}

// archive#3451 fix round D5: moved to packages/contracts/src/runtime-events.ts,
// which src-server AND src-ui both already depend on — re-exported here so
// every existing src-server import of this module keeps working unchanged.
export { isDeferredRetriableTurnError } from '@kontourai/station-contracts/runtime-events';

// archive#3525/#3559 fix rounds: `InternalStopSuppression.arm`
// and `steerTurn` (orchestration-service.ts) each fold over
// `listEventsByMethods` narrowed to exactly the methods THIS function
// inspects below, as a performance narrowing — every other canonical method
// is a pass-through no-op here, so the fold is bit-identical over the
// narrowed set. Exported so both call sites (and the differential test that
// pins the narrowing against the full canonical method list) import the SAME
// list instead of hand-duplicating it, which at least keeps the two call
// sites from disagreeing WITH EACH OTHER. It does NOT, by itself, keep this
// list in lockstep with a future branch added below: the differential test
// (`orchestration-service.test.ts`) is the thing that actually proves that,
// by replaying every excluded method a second time against a genuinely open
// turn so a newly fold-relevant method excluded here diverges observably.
export const ACTIVE_TURN_FOLD_METHODS = [
  'turn.started',
  'turn.completed',
  'turn.aborted',
  'runtime.error',
  'session.exited',
] as const;

// archive#3558 exported this alongside `acceptsTurnTerminalEvent` so
// `deriveAgentRunStatus` could track the SAME `activeTurnId` this module's
// own folds track. archive#3581 review MEDIUM 1: that reason is gone —
// `deriveAgentRunStatus`/`findTerminalFailureEvent`/
// `wireTurnCompletionNotifications` all fold `nextTurnIdentityAnchor` now,
// not this function, and nothing outside this module imports
// `nextActiveTurnId` directly any more (verified: only `activeTurnIdForEvents`
// and `interruptibleTurnIdForEvents`, both below, call it). Kept
// module-private so a future edit cannot pick the wrong one of two
// similarly-named, similarly-shaped fold functions — the two are NOT
// interchangeable: this one clears to `undefined` on `runtime.error`/
// `session.exited` (the "is a turn currently open" question);
// `nextTurnIdentityAnchor` deliberately does not (the "which turn was last
// active" question). See that function's doc for the full contrast.
function nextActiveTurnId(
  activeTurnId: string | undefined,
  event: CanonicalRuntimeEvent,
  options?: { preserveDeferredRetry?: boolean },
): string | undefined {
  if (event.method === 'turn.started') return event.turnId;
  if (event.method === 'turn.completed' || event.method === 'turn.aborted') {
    return acceptsTurnTerminalEvent(event, activeTurnId)
      ? undefined
      : activeTurnId;
  }
  if (event.method === 'runtime.error' || event.method === 'session.exited') {
    if (
      options?.preserveDeferredRetry &&
      isDeferredRetriableTurnError(event) &&
      // archive#3451 finding B1: fail-closed on identity. The bounded fact
      // set `interruptibleTurnIdForEvents` folds over (event-store.ts's
      // `listSessionProjectionEvents`, not the full log) can hold a STALE
      // `activeTurnId` from an earlier turn while missing the CURRENT
      // turn's own `turn.started` (it lost its one lifecycle slot to the
      // runtime.error that immediately follows it). Without this check, a
      // second turn's deferred-retriable error would preserve the WRONG
      // (earlier, already-completed) turn id instead of failing safe —
      // worse than `activeTurnIdForEvents`'s plain `undefined`, because a
      // caller could act on it. Requiring a MATCHING `turnId` restores that
      // same safe `undefined` for the case the bounded fact set cannot
      // represent.
      //
      // archive#3451 fix round D1: no `!event.turnId` escape. That
      // disjunct reproduced the exact same bug through the OTHER arm — the
      // adapter-stream-restart error (orchestration-service.ts, retriable:
      // true, deliberately no turnId) is itself a LIFECYCLE_METHODS event
      // and can evict turn-2's turn.started from the bounded fact set
      // exactly like the turnId-bearing case did, and an unconditional
      // escape would then preserve turn-1's stale id. The deferred-retry
      // case this whole branch exists for (archive#3442's premise) is precisely
      // the one that DOES name its turn — codex's `'error'` notification
      // always carries the turnId it is about — so the escape bought
      // nothing real and cost this same defect a second entry point.
      event.turnId === activeTurnId
    ) {
      return activeTurnId;
    }
    return undefined;
  }
  return activeTurnId;
}

// archive#3558: exported so `orchestration-session-state.ts`'s
// `deriveAgentRunStatus` can guard `turn.completed`/`turn.aborted` with the
// SAME identity check `deriveLifecycleTransition` already applies below,
// rather than re-deriving a second copy of the rule. Before this export the
// two folds read the same events and could disagree: a stale terminal for a
// turn the session has moved past (codex's own protocol timing — see
// `codex-adapter-notifications.ts`'s `'turn/completed'` case) closed
// `deriveLifecycleTransition`'s state machine (guarded) but still forced
// `deriveAgentRunStatus`'s `status` to `'completed'`/`'cancelled'`
// (unguarded), so `buildAgentRunSummary` could report a run `completed` for a
// session `buildOrchestrationSessionSummary` folded, from the identical
// events, as still `running`.
//
// archive#3557/#3558 fix-round review BLOCK 2 / archive#3581 (FIXED): the
// PREVIOUS revision of this function was a permissive default keyed off
// `activeTurnId === undefined` — `(event, undefined)` was unconditionally
// `true` for any terminal that names a turn at all. `nextActiveTurnId`'s
// forward fold reaches `activeTurnId === undefined` on plenty of live,
// non-stale paths (no turn ever started yet; a `runtime.error`/
// `session.exited` clearing the slot with no `preserveDeferredRetry`), and
// this function could not tell that case apart from "a stale terminal
// arrived after the session's tracked turn was cleared" — it accepted both.
// It was a real guard against a stale terminal arriving while `activeTurnId`
// still named the PRECEDING turn; it was not a guard against one arriving
// after `activeTurnId` had already gone `undefined`.
//
// The fix is NOT "reject once `undefined` arrived via a real turn's own
// error/exit": the same-turn retry case (`turn.started(t1)` →
// `runtime.error(t1)` → `turn.completed(t1)`) reaches `undefined` that way
// too and must still ACCEPT (`event-store.test.ts`'s
// `a same-turn retry-then-complete still reports completed after
// turn-scoping` non-regression). The discriminator is TURN IDENTITY, not the
// provenance of `undefined`. This function's own body did not need to
// change — `Boolean(event.turnId) && (!activeTurnId || event.turnId ===
// activeTurnId)` already implements the right rule for whatever identity
// value it is handed. What was wrong was WHICH value `projectSessionLifecycle`
// and `deriveAgentRunStatus` handed it: their own local `nextActiveTurnId`
// fold, which discards the cleared turn's id on `runtime.error`/
// `session.exited` — the very value this function needs to still compare
// against. Both now fold `nextTurnIdentityAnchor` (below) instead, which
// retains that id as a last-known value instead of discarding it, so a
// terminal naming an EARLIER, already-superseded turn is correctly rejected
// while a turn's own later completion (after its own earlier error) is still
// accepted. `nextActiveTurnId` itself is UNCHANGED and still clears to
// `undefined` on those events — `activeTurnIdForEvents`/`hasOpenTurn` and
// `interruptibleTurnIdForEvents` depend on exactly that clearing semantics
// ("is a turn currently open") and must not gain a stale-but-defined id.
//
// archive#3581 review round 2, addressing three further findings on top of
// the above:
//   BLOCK 1: this guard was still bypassable. `deriveLifecycleTransition`
//   honors a persisted `sessionState` STAMP before ever reaching this
//   function (its own early return, further down) — and the write path
//   that mints that stamp (`orchestration-service.ts`'s `consumeAdapterEvents`)
//   was still computing it from the CLEARING fold (`activeTurnIdForEvents`),
//   so a stale terminal got stamped `sessionState: 'completed'` on disk and
//   sailed past this guard entirely. Fixed two ways: the write path now
//   folds `nextTurnIdentityAnchor`/`turnIdentityAnchorForEvents` (below) —
//   the SAME identity rule this guard applies — so the stamp stops being
//   minted; and `deriveLifecycleTransition`'s stamp early-return now ALSO
//   distrusts a stamped `turn.completed`/`turn.aborted` this guard would
//   reject, which is what heals rows already persisted with the old,
//   unguarded stamp (a write-side fix alone cannot reach those).
//   MEDIUM 3: `nextTurnIdentityAnchor` used to clear back to `undefined` the
//   moment it accepted a terminal, which reopened this exact permissive
//   hole for anything arriving afterward with no turn of its own to compare
//   against. It now retains the last-started turn's id for the rest of the
//   session's life — see that function's doc for the discriminating case
//   and why the Stop double-terminal case still accepts correctly.
export function acceptsTurnTerminalEvent(
  event: Extract<
    CanonicalRuntimeEvent,
    { method: 'turn.completed' | 'turn.aborted' }
  >,
  activeTurnId?: string,
): boolean {
  // A no-active-turn terminal can still be a valid recovered completion, but
  // only when it explicitly names its target. With an active turn, require an
  // exact match so a resume/reconnect handshake cannot stomp it.
  return (
    Boolean(event.turnId) && (!activeTurnId || event.turnId === activeTurnId)
  );
}

/**
 * archive#3581: tracks the turn identity `acceptsTurnTerminalEvent` should
 * check a `turn.completed`/`turn.aborted` against. Deliberately NOT the same
 * fold as `nextActiveTurnId`: that (module-private) function clears to
 * `undefined` on `runtime.error`/`session.exited` (and, arguably, on an
 * accepted terminal) because ITS value answers "is a turn currently open"
 * (`activeTurnIdForEvents`/`hasOpenTurn`, `interruptibleTurnIdForEvents`),
 * and a real failure/exit/completion genuinely does end a turn's ability to
 * keep running. But clearing to `undefined` there also erases WHICH turn
 * was last active — so a stale terminal for an EARLIER turn, arriving after
 * that clearing event, reached `acceptsTurnTerminalEvent(event, undefined)`,
 * which is unconditionally `true` (that function's permissive
 * no-turn-ever-started default).
 *
 * This fold instead RETAINS the last-started turn's id for the REST OF THE
 * SESSION'S LIFE — the only event that ever changes it is a fresh
 * `turn.started`, which unconditionally supersedes whatever came before.
 * `archive#3581` specifies accepting freely only when "no turn has ever started",
 * not merely "no turn is currently open" — an earlier revision of this fold
 * cleared the anchor to `undefined` the moment an ACCEPTED terminal closed
 * a turn, which reopened exactly that hole for anything arriving afterward
 * with no turn of its own to compare against (archive#3581 review MEDIUM 3):
 *
 * ```
 * turn.started(t1) → turn.started(t2) → turn.completed(t2) [accepted, real]
 *   → runtime.error("engine died", no turnId) → turn.completed(t1) [stale]
 * ```
 *
 * With the earlier clear-on-accept revision, the accepted `turn.completed(t2)`
 * reset the anchor to `undefined`, so the later `runtime.error` (which never
 * carries a turnId here) left it `undefined`, and the stale `turn.completed(t1)`
 * then hit the permissive default and was wrongly accepted. Retaining `t2`
 * through both of those events rejects it correctly. Verified this does not
 * regress the Stop double-terminal case (`turn.aborted(t1)` then a same-turn
 * `turn.completed(t1, finishReason:'cancelled')`): the second terminal now
 * matches the retained anchor by EXACT identity instead of falling through
 * to the permissive default — same accept, better reason.
 *
 * Consumed by `projectSessionLifecycle`, `orchestration-session-state.ts`'s
 * `deriveAgentRunStatus`/`findTerminalFailureEvent`, and
 * `turn-completion-notifications.ts`'s `wireTurnCompletionNotifications`, in
 * place of `nextActiveTurnId`. Also consumed at WRITE time
 * (`orchestration-service.ts`'s `consumeAdapterEvents`, via
 * `turnIdentityAnchorForEvents` below) so the `sessionState` Station stamps
 * onto a persisted event is computed with the SAME identity rule the read
 * folds apply — see `deriveLifecycleTransition`'s stamp early-return for why
 * the write and read sides must agree.
 *
 * LOAD-BEARING INVARIANT (archive#3581 review round 2, finding 2): a
 * terminal is only EVER wrongly rejected by this fold if it names a turn
 * whose OWN `turn.started` was never published — a rejection otherwise
 * requires (by construction) that a DIFFERENT, later `turn.started`
 * superseded it, which is exactly the correct-to-reject case. So this fold
 * is safe only because every real terminal publisher also publishes a
 * pairing `turn.started` for the same turn id. Audited at review time: all
 * nine adapters that publish `turn.completed`/`turn.aborted` (bedrock,
 * ollama, claude, codex, acp, station-agent, muse, plus
 * `claude-transcript-session-source.ts`) pair them with their own
 * `turn.started`; `acp-adapter.ts` additionally gates its terminal publish
 * on matching the session's own tracked turn identity; and the bounded
 * projection's `latestEventByMethod('turn.started')` slot is never evicted
 * by turn-scoping. Nothing in this module enforces that invariant — a
 * future adapter (or a synthetic/replayed event source) that publishes a
 * terminal with no paired `turn.started` would have that terminal silently
 * and permanently rejected by every consumer of this fold, with no test
 * anywhere positioned to catch it.
 */
export function nextTurnIdentityAnchor(
  turnIdentityAnchor: string | undefined,
  event: CanonicalRuntimeEvent,
): string | undefined {
  if (event.method === 'turn.started') return event.turnId;
  // Every other canonical method — including an ACCEPTED
  // `turn.completed`/`turn.aborted` — retains. See the doc above for why
  // clearing on accept was itself the bug this fold exists to close.
  return turnIdentityAnchor;
}

/**
 * archive#3581 BLOCK 1 (review): the `turnIdentityAnchorForEvents` sibling of
 * `activeTurnIdForEvents`, folding `nextTurnIdentityAnchor` instead of
 * `nextActiveTurnId`. Exported specifically so `orchestration-service.ts`'s
 * `consumeAdapterEvents` can compute the SAME identity value at WRITE time
 * that `deriveLifecycleTransition`/`deriveAgentRunStatus` compute at READ
 * time — using `activeTurnIdForEvents` there (as this codebase did before
 * this fix) stamps a persisted event's `sessionState` from the CLEARING
 * fold, which reopens BLOCK 1's exact gap: a stale terminal arriving after
 * its superseding turn's own error/exit gets accepted and stamped
 * `sessionState: 'completed'` on disk, and `deriveLifecycleTransition`'s
 * stamp early-return then honors that stamp before its own
 * `acceptsTurnTerminalEvent` guard is ever reached.
 */
export function turnIdentityAnchorForEvents(
  events: CanonicalRuntimeEvent[],
): string | undefined {
  let turnIdentityAnchor: string | undefined;
  for (const event of events) {
    turnIdentityAnchor = nextTurnIdentityAnchor(turnIdentityAnchor, event);
  }
  return turnIdentityAnchor;
}

function providerStatusToLifecycleState(
  status: ProviderSession['status'],
): SessionLifecycleState {
  if (status === 'connecting') return 'queued';
  if (status === 'error') return 'failed';
  // archive#1827: `dead` is a terminal engine-reported failure, same
  // lifecycle outcome as `error` — the distinction between the two only
  // matters to recovery/replay (orchestration-session-state.ts).
  if (status === 'dead') return 'failed';
  if (status === 'closed') return 'canceled';
  // 'ready' is connected-and-idle — with attach events transition-neutral
  // (archive#1073) this initial value is what an attach-only session keeps, and
  // 'running' here would silently re-introduce the lie.
  if (status === 'ready') return 'queued';
  return 'running';
}

/**
 * archive#1073: attach-time events must not fabricate activity. `session.started` /
 * `session.configured` are published whenever a runtime attaches — including
 * for every persisted session resumed at a service restart — so folding them
 * into 'queued'/'running' overwrote the session's true state (a completed
 * session re-attached as "running" forever, with no turn in flight). Both are
 * now transition-neutral unless they explicitly carry state, and the stamps
 * this fold itself used to fabricate onto persisted events (recognizable by
 * their attach-time transition reasons) are distrusted so historical event
 * logs heal at projection time without a data migration. Deliberate manual /
 * board transitions ride `session.state-changed` with their own reasons and
 * stay trusted.
 */
function isLegacyAttachStamp(event: CanonicalRuntimeEvent): boolean {
  // The full fabricated tuple, not just method+reason: a deliberately
  // authored event that happens to reuse the canonical reason but carries a
  // different state or source is NOT the legacy stamp and stays trusted
  // (review MED: the heuristic must recognize exactly what the old
  // normalize generated).
  if (event.transitionSource !== 'runtime') return false;
  return (
    (event.method === 'session.configured' &&
      // 'running': the pre-#1073 fabrication. 'queued': the archive#1121-era
      // stamp (main briefly mapped non-terminal attaches to 'queued'
      // before neutrality landed) — both are attach facts, not authored
      // state.
      (event.sessionState === 'running' || event.sessionState === 'queued') &&
      event.transitionReason === 'session_configured') ||
    (event.method === 'session.started' &&
      event.sessionState === 'queued' &&
      event.transitionReason === 'session_started')
  );
}

/**
 * A `runtime.error` that names no turn at all.
 *
 * UX audit AW-8 (live-reproduced): killing a pooled Claude Code engine after
 * its turn had already finished publishes exactly this — a session-scoped
 * error about the PROCESS (`Claude model "..." failed: Claude Code process
 * terminated by signal SIGKILL`, `claude-adapter.ts`, no `turnId`) — and both
 * read folds rewrote the answered session to `failed`, transcript and token
 * count still on screen. A session's outcome comes from its recorded terminal
 * TURN events; the later death of the process that hosted them is a fact about
 * the substrate.
 *
 * The turn id is what discriminates, and it has to be, because two other real
 * cases look superficially similar and MUST still fail the session (both
 * pinned in `event-store.test.ts`):
 *  - a turn's own failure arriving just after its terminal
 *    (`turn.completed(t1, 'other')` then `runtime.error(t1, 'usage limit
 *    reached')`) — same turn, so it is that turn's account of itself;
 *  - a ghost turn (`runtime.error(t2)` for a turn whose `turn.started` was
 *    never published) — a different turn, so it is a new, unaccounted failure.
 * Only an error attributed to NO turn is unattributable to the work, and only
 * then, and only once the work has stopped, is it not the outcome.
 */
export function isUnattributedRuntimeError(
  event: CanonicalRuntimeEvent,
): boolean {
  return event.method === 'runtime.error' && event.turnId === undefined;
}

function deriveLifecycleTransition(
  event: CanonicalRuntimeEvent,
  previousState?: SessionLifecycleState,
  // archive#3581: named for what this parameter actually needs to be, not
  // for `nextActiveTurnId`'s "is a turn open" value — see
  // `nextTurnIdentityAnchor`'s doc. Both callers now pass a value folded by
  // `nextTurnIdentityAnchor`/`turnIdentityAnchorForEvents`:
  // `projectSessionLifecycle` (below) folds it directly, and
  // `normalizeCanonicalRuntimeEventLifecycle` (the WRITE-time caller, via
  // `orchestration-service.ts`'s `consumeAdapterEvents`) now passes
  // `turnIdentityAnchorForEvents` over the bounded projection instead of
  // `activeTurnIdForEvents` — review BLOCK 1: passing the CLEARING fold's
  // value there stamped a persisted event's `sessionState` from a stale
  // terminal exactly like this function's own `acceptsTurnTerminalEvent`
  // guard below exists to reject, and the stamp early-return runs BEFORE
  // that guard is ever reached (see `isStaleTurnTerminal` below). Left
  // untyped (`string` rather than a branded type) because there is no
  // static way to enforce which fold produced a given `string | undefined`;
  // the discipline is "always `nextTurnIdentityAnchor`", documented here.
  turnIdentityAnchor?: string,
): {
  from: SessionLifecycleState;
  to: SessionLifecycleState;
  reason: SessionTransitionReason;
  source: SessionTransitionSource;
} | null {
  const from = event.previousState ?? previousState ?? 'queued';
  // archive#3557/#3558 fix-round review BLOCK 3 delta-review MEDIUM (archive#3581
  // is BLOCK 2, this is a separate, later-caught finding): a persisted
  // `turn.completed` is normalized and stamped with `sessionState` BEFORE
  // it is written (`consumeAdapterEvents` -> `normalizeCanonicalRuntimeEventLifecycle`,
  // `orchestration-service.ts:5641-5645`; `projectAndPublishEvent` persists
  // it via `appendEvent`). For a codex Stop, the WRITE-TIME guard already
  // accepts the confirmation (`turn.aborted` cleared `activeTurnId`, so
  // `acceptsTurnTerminalEvent(event, undefined)` is permissively true), so
  // every codex/ACP/muse/station-agent Stop already on disk is stamped
  // `sessionState: 'completed'` — the very value the `finishReason` check
  // below exists to correct. Without this exclusion, the early return above
  // reads that stamp and returns `to: 'completed'` BEFORE the switch's
  // `'turn.completed'` case (and its `finishReason` check) is ever reached,
  // so this fold says `completed` while `deriveAgentRunStatus` (which has no
  // such early return and always reaches the `finishReason` check) says
  // `cancelled` — the exact two-fold disagreement archive#3558 exists to close,
  // reintroduced for every already-persisted Stop. Overriding the stamp here
  // is correct specifically BECAUSE the stamp is Station's own derived
  // value, not an adapter assertion: the early return exists to honour
  // adapter-authored state, and this one value was authored by the very
  // write path this fix is correcting.
  const isStampedStaleCancellation =
    event.method === 'turn.completed' && event.finishReason === 'cancelled';
  // archive#3581 review BLOCK 1: the SAME trap that produced
  // `isStampedStaleCancellation`, in its general form. That exclusion was
  // written narrowly for a stamped CANCELLATION — an ACCEPTED terminal
  // whose `finishReason` correction only happens in the switch below — and
  // left the general case open: a stamped `turn.completed`/`turn.aborted`
  // the identity anchor REJECTS also carries `event.sessionState` (written
  // by `normalizeCanonicalRuntimeEventLifecycle` at persist time, itself
  // now folding `turnIdentityAnchorForEvents`), and this early return used
  // to honor that stamp BEFORE the switch's own `acceptsTurnTerminalEvent`
  // guard (`case 'turn.completed'`/`case 'turn.aborted'` below) ever ran —
  // so a stale terminal's stamp made this fold say `completed` while
  // `deriveAgentRunStatus`/`findTerminalFailureEvent` (which have no such
  // early return to bypass) correctly rejected the same event and said
  // `failed`. Distrusting the stamp here — not just fixing the write path —
  // is what heals every row ALREADY persisted with the old, unguarded
  // stamp; a write-side-only fix cannot reach rows already on disk.
  const isStaleTurnTerminal =
    (event.method === 'turn.completed' || event.method === 'turn.aborted') &&
    !acceptsTurnTerminalEvent(event, turnIdentityAnchor);
  if (
    event.sessionState &&
    !isLegacyAttachStamp(event) &&
    !isStampedStaleCancellation &&
    !isStaleTurnTerminal
  ) {
    return {
      from,
      to: event.sessionState,
      reason: event.transitionReason ?? 'manual_update',
      source: event.transitionSource ?? 'runtime',
    };
  }

  switch (event.method) {
    case 'session.started':
      // Every adapter publishes `initialState: 'created'` on EVERY
      // startSession — including recovery/reattach of a session with real
      // history — so 'created' is an attach fact, not a work state, and
      // must stay transition-neutral or a reattach resets completed/failed
      // sessions to queued (review HIGH). A fresh session's 'queued' comes
      // from the projection's initial value. Any other explicitly-carried
      // initial state is an adapter deliberately reporting where the
      // session began, and is honored.
      return event.initialState && event.initialState !== 'created'
        ? {
            from,
            to: runtimeSessionStateToLifecycleState(event.initialState),
            reason: 'session_started',
            source: 'runtime',
          }
        : null;
    case 'session.configured':
      // Attach fact, not a work state (archive#1073; main's archive#1121 shipped
      // the terminal-guarded variant mid-flight). Adapters publish this
      // whenever a runtime attaches — including every persisted session
      // re-attached at startup — so it contributes no lifecycle transition
      // at all. Neutrality is the strict superset of archive#1121's
      // non-terminal→'queued' mapping: a fresh session's 'queued' comes
      // from the projection's initial value, and neutrality additionally
      // preserves needs_input/review_pending/blocked across a re-attach
      // instead of resetting them to 'queued'.
      return null;
    case 'session.state-changed': {
      const to = runtimeSessionStateToLifecycleState(event.to);
      // A runtime reporting itself attached-but-idle is describing its own
      // connection, not the outcome of the work: it must not overwrite a
      // recorded result. `stopped` (archive#1548) is the contract-derived
      // name for exactly that set — completed/failed/canceled, the states
      // whose only way out is an explicit restart. Genuine states (running,
      // completed, failed, ...) still apply from any prior state, so a
      // resumed thread transitions normally.
      if (to === 'queued' && isSessionLifecycleStateStopped(from)) return null;
      return {
        from,
        to,
        reason: mapRuntimeTransitionReason(event.to, event.reason),
        source: 'runtime',
      };
    }
    case 'turn.started':
      return { from, to: 'running', reason: 'turn_started', source: 'runtime' };
    case 'turn.completed':
      if (!acceptsTurnTerminalEvent(event, turnIdentityAnchor)) return null;
      // archive#3557/#3558 fix-round review BLOCK 3: codex's own Stop
      // confirmation publishes `turn.completed(finishReason: 'cancelled')`
      // for the SAME turn `turn.aborted` already closed — both real events,
      // not adapter noise — and the max-sequence rule that resolves a
      // single terminal fact (event-store.ts's `latestTerminalEventForTurn`,
      // and the separate, unscoped `LIFECYCLE_METHODS` slot) always picks
      // whichever of the two sorts later, ordinarily `turn.completed`.
      // Reading `finishReason` here means the transition is correct no
      // matter which of the two physical rows survives eviction.
      if (event.finishReason === 'cancelled') {
        return {
          from,
          to: 'canceled',
          reason: 'user_canceled',
          source: 'runtime',
        };
      }
      return {
        from,
        to: 'completed',
        reason: 'turn_completed',
        source: 'runtime',
      };
    case 'turn.aborted':
      if (!acceptsTurnTerminalEvent(event, turnIdentityAnchor)) return null;
      return {
        from,
        to: 'canceled',
        reason: 'user_canceled',
        source: 'runtime',
      };
    case 'request.opened':
      return {
        from,
        to: event.requestType === 'input' ? 'needs_input' : 'review_pending',
        reason:
          event.requestType === 'input'
            ? 'input_requested'
            : 'review_requested',
        source: 'runtime',
      };
    case 'request.resolved':
      return {
        from,
        to: 'running',
        reason: 'request_resolved',
        source: 'user_action',
      };
    case 'runtime.error':
      // UX audit AW-8 (live), mirroring the `session.exited` guard below.
      if (
        isUnattributedRuntimeError(event) &&
        isSessionLifecycleStateStopped(from)
      )
        return null;
      return { from, to: 'failed', reason: 'runtime_error', source: 'runtime' };
    case 'session.exited': {
      // archive#3442: `exitCode` is the only field here an adapter ever sets
      // from an actual observation (see `codex-adapter-transport.ts`'s
      // `finalizeUnexpectedExit`) — every adapter's own user-initiated
      // `stopSession`/`interruptTurn` publishes `session.exited` with NO
      // `exitCode` at all (`reason: 'stopped'`), so `undefined` here means
      // "an intentional stop, no exit-code observation available" and stays
      // 'canceled'. A DEFINED, non-zero exit code is the runtime reporting
      // its own process actually crashed — that is a failure, not a
      // cancellation, and (unlike 'canceled', whose only way out is
      // re-queuing from scratch) 'failed' is what the contract already
      // declares retryable.
      //
      // archive#3451 finding M1: `exitCode === 0` FILLS rather than
      // overrides. It is a real fact about the OS process, not the turn —
      // archive#3473's `finalizeUnexpectedExit` now always synthesizes a
      // `runtime.error` (folding `from` to 'failed') before publishing
      // `session.exited`, so a process that dies mid-turn with exit code 0
      // (a graceful-shutdown handler, a kill racing a clean-exit path) would
      // otherwise clobber the failure this VERY EVENT STREAM just recorded
      // back to 'completed' — reporting success for a turn that failed.
      // Once `from` is already 'failed', a later 0 exit code is not evidence
      // that turn succeeded; it stays 'failed'.
      //
      // UX audit AW-R8: generalized from that one arm to every
      // arm. A session whose work already ENDED — `completed`, `canceled`
      // or `failed`, the three states `isSessionLifecycleStateStopped`
      // names — has its outcome recorded by a terminal TURN event. The
      // later death of the pooled engine process is a fact about the
      // substrate, not about that work, and Station keeps those processes
      // resident long after a turn ends, so this event routinely arrives
      // minutes late. Overwriting a recorded `completed` with `failed`
      // (non-zero exit) or `canceled` (no exit code, i.e. an ordinary
      // `stopSession`) is what showed answered sessions as `✗ Failed` with
      // their completed transcripts still on screen
      // (reports/2-agent-workflows/REPORT.md AW-R8). Returning `null` is
      // "this event records no lifecycle transition" — the event is still
      // persisted and still readable as history; it just no longer decides
      // the outcome. A turn still IN PROGRESS is `running` (or queued /
      // needs_input / review_pending / blocked), none of which are stopped,
      // so the crash-mid-turn -> `failed` fold archive#3451 finding 1 added
      // is untouched. Mirrored by `deriveAgentRunStatus`'s
      // `isTerminalAgentRunStatus(status)` guard on the same event.
      if (isSessionLifecycleStateStopped(from)) return null;
      // `from === 'failed'` no longer needs its own arm here: the stopped
      // guard above already returned for it (finding M1's case is a strict
      // subset of the general rule).
      const to =
        event.exitCode === 0
          ? 'completed'
          : event.exitCode !== undefined
            ? 'failed'
            : 'canceled';
      return {
        from,
        to,
        reason: to === 'failed' ? 'runtime_error' : 'runtime_exit',
        source: 'runtime',
      };
    }
    default:
      return null;
  }
}

function runtimeSessionStateToLifecycleState(
  state: SessionState,
): SessionLifecycleState {
  if (state === 'created') return 'queued';
  // 'configured' and 'idle' describe attachment, not work: the runtime is
  // there and able to accept a turn, but none is executing. Mapping them to
  // 'running' is the same conflation archive#1073 fixed for session.configured —
  // and a worse one, because bedrock/ollama publish state-changed -> 'idle'
  // immediately AFTER turn.completed, so every completed turn folded back to
  // 'running' on those providers (archive#1121 review).
  if (state === 'configured') return 'queued';
  if (state === 'idle') return 'queued';
  if (state === 'running') return 'running';
  if (state === 'awaiting-approval') return 'review_pending';
  if (state === 'completed') return 'completed';
  if (state === 'aborted') return 'canceled';
  if (state === 'errored') return 'failed';
  if (state === 'exited') return 'canceled';
  return 'running';
}

function lifecycleStateToRuntimeSessionState(
  state: SessionLifecycleState,
): SessionState {
  if (state === 'queued') return 'created';
  if (state === 'needs_input') return 'awaiting-approval';
  if (state === 'review_pending') return 'awaiting-approval';
  if (state === 'blocked') return 'errored';
  if (state === 'completed') return 'completed';
  if (state === 'failed') return 'errored';
  if (state === 'canceled') return 'aborted';
  return 'running';
}

function mapRuntimeTransitionReason(
  state: SessionState,
  reason?: string,
): SessionTransitionReason {
  if (state === 'awaiting-approval') return 'approval_requested';
  if (state === 'completed') return 'turn_completed';
  if (state === 'aborted') return 'user_canceled';
  if (state === 'errored') return 'runtime_error';
  if (reason === 'system_recovered') return 'system_recovered';
  return 'manual_update';
}

function readStringMetadata(
  metadata: Record<string, unknown> | undefined,
  key: string,
): string | undefined {
  const value = metadata?.[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}
