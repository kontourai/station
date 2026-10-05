import { sessionAttentionDisposition } from '@kontourai/station-contracts/session-attention';
import type { OrchestrationSessionSummary } from '@kontourai/station-sdk';

/**
 * WHAT STATE A SESSION IS IN — one derivation, one owner (archive#3227 A1).
 * The WORD for it is not here: every surface reads the status ladder
 * (`views/home/work-status.ts`, through `sessionWorkStatus` in
 * `views/sessions/sessions-lane-model.ts`), which takes this fold's label as
 * its input. A second word table ("Review pending", "Completed", "Ready")
 * used to live beside the fold and gave the Activity list its own vocabulary;
 * `session-state-word-consistency.test.ts` fails on its return.
 *
 * ITS OWN MODULE, not `sessionDisplay.ts`, for a measured reason. The fold
 * feeds `home-view-model.ts`, which is EAGER — it is in the entry chunk — so
 * importing it through `sessionDisplay` hoisted that whole module (project
 * attribution, engine names, icon resolution) and its `answerability` /
 * contracts dependencies into the entry bundle, +1246 gzip bytes over the
 * ceiling for four functions that need none of it. This module depends on
 * the dependency-free `@kontourai/station-contracts/session-attention` leaf
 * (the shared failed/finished/awaiting adjudication — archive#3227; a deep
 * import of one small module, not the contracts barrel). `sessionDisplay.ts`
 * remains the home of the other shared session derivations.
 */

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
  | 'Draft'
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
 * It deliberately OVERRIDES `lifecycleState` in five places; each override is
 * a fixed defect, and each is a divergence the row label used to reintroduce:
 *
 * | shape | `lifecycleState` says | this says |
 * |---|---|---|
 * | `running`, `hasActiveTurn: false` | Running | **Ready** (archive#1069) |
 * | `pendingReview`, `running` | Running | **Needs attention** |
 * | `status: 'closed'`, `running` | Running | **Completed** (archive#1296) |
 * | `needs_input`, `answerable: false` | Waiting on you | **Unanswerable** (archive#1783) |
 * | `queued`/`running`, `hasActiveTurn: false`, `draft: true` | Queued/Running | **Draft** (#2310) |
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
  const currentChildWork =
    session.conversationActivity?.currentThreadId === session.threadId &&
    session.conversationActivity.runningChildWork !== undefined;
  // A completed or stopped parent turn may leave reported children running.
  // Keep the attention fold unchanged: background work is not a request to
  // the user. A closed or failed session retains its terminal outcome.
  // `idle` is how an ordinary turn ends since #2540; without it a session
  // whose turn finished while its sub-agents kept running read Completed.
  if (
    (session.lifecycleState === 'idle' ||
      session.lifecycleState === 'completed' ||
      session.lifecycleState === 'canceled') &&
    session.status !== 'closed' &&
    currentChildWork &&
    disposition.state === 'finished'
  )
    return 'Running';
  // The shared attention fold files a canceled turn under `finished`. Refine
  // that recorded outcome to Stopped when no child work remains.
  if (session.lifecycleState === 'canceled') return 'Stopped';
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
      // #2310: `draft` is the SERVER's lineage-aware fold (no turn anywhere
      // in the conversation, no history from elsewhere) — read, never
      // re-derived from this summary's own events, which cannot see a
      // conversation's other Sessions. `=== true` because absent means the
      // reader did not consult the lineage, not "is a draft". Only the
      // active arm refines to it: a never-prompted session that failed,
      // finished or is waiting on the user keeps that more specific word.
      if (session.hasActiveTurn || currentChildWork) return 'Running';
      return session.draft === true ? 'Draft' : 'Ready';
  }
}

/**
 * WHAT an awaiting session is waiting on (#3042), read off the same shared
 * fold `orchestrationLifecycleLabel` uses plus the summary's own transition
 * facts. Meaningful only for a session that fold calls `Needs attention`.
 *
 * - `review_pending` is the server's fold of every open request that is not
 *   an `input` request (approval, permission, confirmation), and of the
 *   `pendingReview` flag: an approval.
 * - `needs_input` reached through `input_requested` is an open question.
 * - `needs_input` stamped by interrupted-turn recovery carries
 *   `transitionReason: 'runtime_exit'`: the turn was cut short.
 * - any other `needs_input` says only that the session waits on the user.
 *
 * A turn interrupted by a restart while an approval was open reads
 * Interrupted: recovery's abort settles the request the dead turn opened
 * (#3071), so the server no longer reports it `review_pending`.
 */
export function sessionAttentionKind(
  session: Pick<
    OrchestrationSessionSummary,
    | 'lifecycleState'
    | 'status'
    | 'pendingReview'
    | 'terminalAttribution'
    | 'transitionReason'
  >,
): 'approval' | 'answer' | 'interrupted' | 'blocked' | 'waiting' {
  const disposition = sessionAttentionDisposition(session);
  if (disposition.state !== 'awaiting') return 'waiting';
  if (disposition.via === 'review_pending') return 'approval';
  if (disposition.via === 'blocked') return 'blocked';
  if (session.transitionReason === 'input_requested') return 'answer';
  if (session.transitionReason === 'runtime_exit') return 'interrupted';
  return 'waiting';
}
