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
 * The fold, its label type and the awaiting-kind read moved to the contracts
 * leaf (`@kontourai/station-contracts/session-attention`) so the server's
 * station-control `list_project_activity` words a session with the same
 * derivation (station#3413). They are re-exported here for every UI importer;
 * the fold's rationale (the five deliberate overrides of `lifecycleState`) is
 * documented there.
 */
export {
  orchestrationLifecycleLabel,
  type SessionStateLabel,
  sessionAttentionKind,
} from '@kontourai/station-contracts/session-attention';

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
