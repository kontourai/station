/**
 * Canonical status-priority ranking for `HomeWorkItem.lifecycleLabel`
 * (archive#1100) — the source of truth for the Home list's merge layer
 * (`home-view-model.ts`'s `mergeHomeWorkItems`, which resolves a winning
 * label when a chat/orchestration pair carries two different ones).
 * Extracted verbatim
 * from `home-view-model.ts`'s former private `moreImportantLifecycle` —
 * this file changes no ranking behavior, only where it lives.
 *
 * Distinct from (not literally shared with) the notification/push ranking
 * in `@kontourai/station-shared/notification-priority`. Both now represent
 * failure separately from actionable attention, but Home additionally ranks
 * its local Current/Ready/Recent labels and this UI-only module cannot be
 * imported by `src-server`.
 *
 * Review-adjudicated (archive#1100): the split is legitimately forced today
 * by the different label sets plus the src-ui/src-server runtime boundary,
 * not an accident of two people not talking — the ordering *concept* (needs
 * attention/input outranks a failure outranks in-progress outranks done) is
 * shared with `@kontourai/station-shared/notification-priority` even though
 * the code isn't. A future shared semantic-tier mapping could derive both
 * rankings without making either layer depend on the other's display labels.
 */

export const HOME_LIFECYCLE_LABELS = [
  'Needs attention',
  'Failed',
  'Stopped',
  'Running',
  'Current',
  'Ready',
  'Recent',
  'Draft',
  'Unanswerable',
  'Completed',
] as const;

export type HomeLifecycleLabel = (typeof HOME_LIFECYCLE_LABELS)[number];

/**
 * Higher number = more important. Read the scope literally: this ranking has
 * ONE consumer, `moreImportantLifecycle`, which picks the winning LABEL when
 * a chat item and an orchestration item merge into a single row. It is not a
 * sort key. Home's order is `compareTaskRecency`, and the lane model never
 * re-sorts on `lifecycleLabel`, so changing a number here cannot move a row
 * on Home.
 *
 * `Unanswerable` is archive#1783's addition (ADR 0012 residual), placed just
 * above `Completed`: it has not finished, and nothing here can act on it. An
 * earlier version of this comment claimed the renumbering was what stopped a
 * dead session "pinning the top of Home" — review caught that as a claim
 * about a mechanism this file does not have. (The top-slot fix was a
 * separate rank for the delegated-work card, removed with that card.) What
 * the ranking here buys is that a merged chat+orchestration row cannot show
 * "Needs attention" for a request nothing can answer.
 *
 * Nothing is removed from any list by it, so the row and its basis stay
 * readable (annotate, never filter).
 */
export const LIFECYCLE_PRIORITY: Record<HomeLifecycleLabel, number> = {
  'Needs attention': 7,
  Failed: 6,
  Stopped: 5.5,
  Running: 5,
  Current: 4,
  Ready: 3,
  Recent: 2,
  // #2310: a session no turn has ever started in. Below every label that
  // records activity, so a local send (`Running`) or an offline-queued first
  // message (`Needs attention`) always wins a merge against the server's
  // Draft answer for the same conversation.
  Draft: 1.5,
  Unanswerable: 1,
  Completed: 0,
};

export function moreImportantLifecycle(
  left: HomeLifecycleLabel,
  right: HomeLifecycleLabel,
): HomeLifecycleLabel {
  return LIFECYCLE_PRIORITY[right] > LIFECYCLE_PRIORITY[left] ? right : left;
}
