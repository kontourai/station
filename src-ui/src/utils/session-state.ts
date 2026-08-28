import { sessionAttentionDisposition } from '@kontourai/station-contracts/session-attention';
import type {
  OrchestrationSessionSummary,
  SessionBoardLifecycleState,
} from '@kontourai/station-sdk';
import { lifecycleLabelText } from './lifecycle-priority';

/**
 * WHAT STATE A SESSION IS IN, and the word a surface prints for it — one
 * derivation, one owner (archive#3227 A1).
 *
 * ITS OWN MODULE, not `sessionDisplay.ts`, for a measured reason. The fold
 * feeds `home-view-model.ts`, which is EAGER — it is in the entry chunk — so
 * importing it through `sessionDisplay` hoisted that whole module (project
 * attribution, engine names, icon resolution) and its `answerability` /
 * contracts dependencies into the entry bundle, +1246 gzip bytes over the
 * ceiling for four functions that need none of it. This module depends on
 * `lifecycle-priority` (already eager) and the dependency-free
 * `@kontourai/station-contracts/session-attention` leaf (the shared
 * failed/finished/awaiting adjudication — archive#3227; a deep import of
 * one small module, not the contracts barrel). `sessionDisplay.ts`
 * remains the home of the other shared session derivations and is where the
 * rendering surfaces already import from; they import `sessionStatusWord`
 * from here alongside.
 */

/**
 * Human copy for a session's RAW `lifecycleState`, and nothing more.
 *
 * NOT THE ROW'S STATUS WORD — `sessionStatusWord` is (archive#3227 A1).
 * `lifecycleState` is one input to what a session's state actually is: a
 * `running` session with no turn in flight is not running, a `running`
 * session the board has closed has finished, and a `running` session with a
 * review pending is waiting on you. `orchestrationLifecycleLabel` folds all
 * of those; this function knows none of them, so rendering it directly is
 * how a row under "Recently finished" came to say *Running*. Four render
 * sites did exactly that, and `sessionStatusWordCallers.test.ts` now fails
 * the build if a fifth appears.
 *
 * It survives as the VOCABULARY layer: the one place a wire identifier is
 * turned into a word, consumed by `sessionStatusWord`'s refinement step.
 *
 * Exhaustive over `SessionBoardLifecycleState` on purpose, with no
 * `default`: adding a state must fail typecheck here rather than silently
 * leaking a raw token to the UI. That is the same discipline
 * `attentionKindLabel` uses, and the absence of it is how `needs_input`
 * reached a screenshot.
 *
 * Note the union is declared twice — `SESSION_LIFECYCLE_STATES` in
 * contracts and `SessionBoardLifecycleState` in the SDK — with identical
 * members today. The UI consumes the SDK, so this switches on that one; if
 * the two ever drift, this function only guarantees coverage of the SDK's.
 */
export function sessionLifecycleLabel(
  state: SessionBoardLifecycleState,
): string {
  switch (state) {
    case 'queued':
      return 'Queued';
    case 'running':
      return 'Running';
    case 'needs_input':
      return 'Waiting on you';
    case 'review_pending':
      return 'Review pending';
    case 'blocked':
      return 'Blocked';
    case 'completed':
      return 'Completed';
    case 'failed':
      return 'Failed';
    case 'canceled':
      return 'Stopped';
  }
}

/**
 * The canonical states a session can be in, as this product words them —
 * exactly what `orchestrationLifecycleLabel` can return, and a strict subset
 * of `HomeLifecycleLabel` (`Current`/`Recent` belong to chat and durable-task
 * items, which are not sessions).
 *
 * Narrower than `HomeLifecycleLabel` on purpose: it makes
 * `SESSION_STATE_REFINEMENTS` below exhaustive over the fold's real outputs,
 * so adding a canonical state is a typecheck failure at the refinement table
 * rather than a state whose row word silently falls through to the coarse
 * label.
 */
export type SessionStateLabel =
  | 'Needs attention'
  | 'Failed'
  | 'Stopped'
  | 'Running'
  | 'Ready'
  | 'Unanswerable'
  | 'Completed';

/**
 * WHAT STATE A SESSION IS IN — the one derivation, and the only one.
 *
 * Moved here from `home-view-model.ts` (archive#3227 A1). It was private to
 * that file while feeding the Home lanes, the Sessions list's lanes
 * (`partitionSessionLanes`), the project badge and the project page — so
 * every surface that renders a session's state as its own WORD reached for
 * `sessionLifecycleLabel(session.lifecycleState)` instead and disagreed with
 * the heading it sat under. It takes only an `OrchestrationSessionSummary`,
 * which is what every one of those surfaces already holds.
 *
 * It deliberately OVERRIDES `lifecycleState` in four places; each override is
 * a fixed defect, and each is a divergence the row label used to reintroduce:
 *
 * | shape | `lifecycleState` says | this says |
 * |---|---|---|
 * | `running`, `hasActiveTurn: false` | Running | **Ready** (archive#1069) |
 * | `pendingReview`, `running` | Running | **Needs attention** |
 * | `status: 'closed'`, `running` | Running | **Completed** (archive#1296) |
 * | `needs_input`, `answerable: false` | Waiting on you | **Unanswerable** (archive#1783) |
 */
/**
 * archive#4052: the ONE applicability gate for the
 * watchdog observation. A summary can carry stale `turnProgress` after the
 * turn ends; only an active turn's observation is a live fact. Both the
 * member rows and the run board consume THIS — a second inline gate is how
 * the board came to contradict its own rows.
 */
export function activeTurnProgress(
  session: Pick<OrchestrationSessionSummary, 'hasActiveTurn' | 'turnProgress'>,
): OrchestrationSessionSummary['turnProgress'] {
  return session.hasActiveTurn ? session.turnProgress : undefined;
}

export function orchestrationLifecycleLabel(
  session: OrchestrationSessionSummary,
): SessionStateLabel {
  // `canceled` is a recorded stopped outcome, not a completed run. The shared
  // attention fold intentionally files both under its coarse `finished`
  // bucket; this client vocabulary refinement is what keeps that bucket from
  // claiming success for an interrupted session.
  if (session.lifecycleState === 'canceled') return 'Stopped';
  // The ordered failed → finished → awaiting → active adjudication is the
  // SHARED fold (archive#3227): `sessionAttentionDisposition` in
  // `@kontourai/station-contracts/session-attention`, the same derivation the
  // server's attention projection counts the bell from. Its docblock carries
  // the rationale each arm used to carry here (archive#1296's failed-outranks-closed,
  // the stale-sticky-flag guard, the awaiting-state list). What stays HERE is
  // exactly what the two surfaces deliberately render differently:
  //
  // - `answerability` (archive#1783, ADR 0012 residual, narrowed after
  //   review): consulted only INSIDE the awaiting arm — the field answers a
  //   question about an OPEN REQUEST, and a detached `completed` session
  //   takes the `past_resume` arm, so an ungated check would relabel the
  //   whole finished inventory after any restart. Read off the summary's
  //   decoration, never recomputed (the predicate is process-local and this
  //   is a browser). The row is DE-PRIORITIZED, never dropped, and carries
  //   the observation that demoted it (`unanswerableNotice`, bound to this
  //   label in `buildSessionWorkItem`). The server projects NO item for the
  //   same shape (the bell counts actionable items only) — a documented
  //   rendering difference, not drift.
  //
  // - `hasActiveTurn` (archive#1069): "Running" is a claim that work is in flight,
  //   so it is gated on the turn-level fold rather than on `lifecycleState`
  //   alone. `session.configured` — published when a runtime merely attaches,
  //   including for every session resumed at startup — moves lifecycleState
  //   to 'running', and only `turn.completed` moves it off; a session that
  //   attaches and never runs a turn therefore reported "Running" forever.
  //   Observed live: 13 of 24 sessions labelled Running with
  //   `hasActiveTurn: false` on every one.
  const disposition = sessionAttentionDisposition(session);
  switch (disposition.state) {
    case 'failed':
      return 'Failed';
    case 'finished':
      return 'Completed';
    case 'awaiting':
      return session.answerability.answerable
        ? 'Needs attention'
        : 'Unanswerable';
    case 'active':
      return session.hasActiveTurn ? 'Running' : 'Ready';
  }
}

/**
 * THE RULE THAT MAKES A ROW WORD SAFE (archive#3227 A1).
 *
 * A lane heading is coarser than a row word, and that refinement is worth
 * keeping: "Recently finished" does not say Completed from Failed, and
 * "Needs you" does not say whether you owe a reply or a review. So the row
 * may say something finer than its lane — but only from within what the fold
 * already decided. This table is that permission, stated once.
 *
 * Read it as: *given the session is canonically in state K, these are the
 * only words a row is allowed to print instead of K.* Anything else is a
 * contradiction and the canonical word wins. The four historical divergences
 * are all rejected by absence, not by a special case:
 * - `Ready` does not permit "Running" (archive#1069);
 * - `Needs attention` does not permit "Running";
 * - `Completed` does not permit "Running" (archive#1296);
 * - `Unanswerable` permits nothing at all (archive#1783) — a session nothing can
 *   answer must never print "Waiting on you", and the canonical word is
 *   itself translated by `lifecycleLabelText`.
 *
 * It is structural rather than remembered in three ways: it is keyed by
 * `SessionStateLabel`, so a new canonical state fails typecheck here; the
 * only way to a row word is `sessionStatusWord`, which consults it; and
 * `sessionStatusWordCallers.test.ts` fails the build if any component
 * reaches past it to `sessionLifecycleLabel`.
 */
const SESSION_STATE_REFINEMENTS: Record<
  SessionStateLabel,
  ReadonlySet<string>
> = {
  // The lane says finished; the row may say WHICH ending. `Failed` has no
  // finer word than itself — `lifecycleState: 'failed'` is the only route to
  // it and it already means one thing.
  Failed: new Set(['Failed']),
  Stopped: new Set(['Stopped']),
  Completed: new Set(['Completed']),
  // The lane says you owe something; the row may say WHAT you owe.
  'Needs attention': new Set(['Waiting on you', 'Review pending', 'Blocked']),
  // Nothing refines "nothing can answer this". Any `lifecycleState`-derived
  // word here would describe a request the serving Station cannot act on.
  Unanswerable: new Set(),
  Running: new Set(['Running']),
  // The lane says idle; the row may say it has never started.
  Ready: new Set(['Queued']),
};

/**
 * The word a session's row prints for its own state — the ONE function a
 * rendering surface calls (archive#3227 A1).
 *
 * Canonical state from `orchestrationLifecycleLabel`, refined by the raw
 * `lifecycleState`'s own word only where `SESSION_STATE_REFINEMENTS` allows
 * it. A row can therefore be more specific than its lane heading and can
 * never contradict it.
 *
 * A session with NO `lifecycleState` gets the canonical word too, rather than
 * the old `session.status` fallback: `status` is a transport identifier
 * (`'closed'`, `'dead'`, `'connecting'`), and printing it was the raw-token
 * leak `sessionLifecycleLabel`'s docblock exists to prevent — an undecorated
 * closed session literally rendered the word "closed" under a "Recently
 * finished" heading.
 */
export function sessionStatusWord(
  session: OrchestrationSessionSummary,
): string {
  const canonical = orchestrationLifecycleLabel(session);
  const refined = session.lifecycleState
    ? sessionLifecycleLabel(session.lifecycleState)
    : null;
  if (refined !== null && SESSION_STATE_REFINEMENTS[canonical].has(refined)) {
    return refined;
  }
  // `lifecycleLabelText`, not the bare label: `'Unanswerable'` is this
  // system's term, not the user's, and archive#1783 already translates it to
  // "Can't answer here" everywhere else it is rendered as text.
  return lifecycleLabelText(canonical);
}
