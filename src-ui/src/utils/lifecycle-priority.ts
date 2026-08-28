/**
 * Canonical status-priority ranking for `HomeWorkItem.lifecycleLabel`
 * (archive#1100) — single source of truth shared by the Home list's
 * merge layer (`home-view-model.ts`'s `mergeHomeWorkItems`, which resolves a
 * winning label when a chat/orchestration pair carries two different ones)
 * and `LifecycleStatusChip`'s chip-rendering decision. Extracted verbatim
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
 * about a mechanism this file does not have. The genuine top-slot fix is
 * `delegatedTaskPriority` (`utils/sessionDisplay.ts`), which IS an ordering
 * and does feed `prioritizedDelegatedTasks`. What the ranking here actually
 * buys is that a merged chat+orchestration row cannot show "Needs attention"
 * for a request nothing can answer.
 *
 * Nothing is removed from any list under either mechanism, so the row and
 * its basis stay readable (annotate, never filter).
 */
export const LIFECYCLE_PRIORITY: Record<HomeLifecycleLabel, number> = {
  'Needs attention': 7,
  Failed: 6,
  Stopped: 5.5,
  Running: 5,
  Current: 4,
  Ready: 3,
  Recent: 2,
  Unanswerable: 1,
  Completed: 0,
};

/**
 * The user's wording for a lifecycle label, for surfaces that render the
 * label as text rather than through `LifecycleStatusChip`.
 *
 * Every other member of this union is already the user's word — "Running",
 * "Needs attention", "Ready". `'Unanswerable'` is not: it is this system's
 * term for "no path exists in the serving process", and archive#1783 leaked
 * it verbatim to two surfaces (the chat-dock inbox chip, the mobile task
 * switcher's `Current · …` line) purely because the label set is shared.
 * The chip family has always translated (`Running` → "Active", `Completed`
 * → "Done"); this is the same translation for the surfaces that do not use
 * a chip, so one term cannot appear two ways.
 */
export function lifecycleLabelText(label: HomeLifecycleLabel): string {
  return label === 'Unanswerable' ? "Can't answer here" : label;
}

export function moreImportantLifecycle(
  left: HomeLifecycleLabel,
  right: HomeLifecycleLabel,
): HomeLifecycleLabel {
  return LIFECYCLE_PRIORITY[right] > LIFECYCLE_PRIORITY[left] ? right : left;
}

/**
 * Lifecycle labels `LifecycleStatusChip` renders a colored chip for (the
 * act-now/in-motion/neutral-done three-meaning color discipline documented
 * there). Not a numeric-priority threshold over `LIFECYCLE_PRIORITY` —
 * `Completed` is priority 0 (least important) but still renders the neutral
 * "Done" chip, while the higher-priority `Current`/`Ready`/`Recent` render
 * no chip at all.
 */
export const LIFECYCLE_CHIP_LABELS = new Set<HomeLifecycleLabel>([
  'Needs attention',
  'Failed',
  'Stopped',
  'Running',
  'Completed',
  // archive#1783: chipped so the row says WHY it dropped down the list —
  // silently demoting it and rendering nothing would be de-prioritization
  // without the fact, which is the filtering ADR 0012 forbids wearing a
  // different hat. The chip renders in the neutral treatment, not a fourth
  // colour meaning: nothing is broken and nothing needs acting on.
  'Unanswerable',
]);
