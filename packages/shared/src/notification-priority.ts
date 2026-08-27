/**
 * Attention/notification content ranking, per-state TTLs, and outcome-first
 * framing — station#1100 (attention-ranked, outcome-first push with
 * per-state TTLs).
 *
 * Distinct from (not literally shared with) the Home work list's own
 * status-priority ranking (`src-ui/src/utils/lifecycle-priority.ts`,
 * station#1100 AC4): that ranking operates over `HomeWorkItem`'s six
 * lifecycle labels, which fold a failed run into "Needs attention" — a
 * taxonomy simplification `LifecycleStatusChip.tsx` documents and
 * explicitly defers splitting out as its own slice. This module needs a
 * distinct `failed` tier the Home taxonomy doesn't expose, and push
 * composition happens server-side, so it lives in
 * `@kontourai/station-shared` (importable from both `src-server` and
 * `src-ui`) rather than `src-ui/src/utils`.
 *
 * Review-adjudicated (station#1100): this split is legitimately forced
 * today (taxonomy gap + runtime boundary), not an accident — the ordering
 * *concept* (needs attention/input outranks a failure outranks in-progress
 * outranks done) is shared with `src-ui/src/utils/lifecycle-priority.ts`
 * even though the code isn't. Unify (fold that module into, or re-derive it
 * from, this one) once Home grows its own dedicated `Failed` lifecycle
 * label.
 */

export type NotificationOutcome = 'needs-input' | 'failed' | 'running' | 'done';

/** Higher number = more important — leads a composed push or summary. */
export const NOTIFICATION_OUTCOME_PRIORITY: Record<
  NotificationOutcome,
  number
> = {
  'needs-input': 3,
  failed: 2,
  running: 1,
  done: 0,
};

export function compareNotificationOutcome(
  left: NotificationOutcome,
  right: NotificationOutcome,
): number {
  return (
    NOTIFICATION_OUTCOME_PRIORITY[right] - NOTIFICATION_OUTCOME_PRIORITY[left]
  );
}

export interface RankableNotificationContent {
  outcome: NotificationOutcome;
  updatedAt: string | number;
}

/**
 * Orders content for a composed push/notification payload or batched
 * summary: highest outcome priority first (approval/input > failed >
 * running > done), ties broken by most-recently-updated. Stable for equal
 * (outcome, updatedAt) pairs — Array.prototype.sort is stable per spec.
 */
export function rankNotificationContent<T extends RankableNotificationContent>(
  items: readonly T[],
): T[] {
  return [...items].sort(
    (left, right) =>
      compareNotificationOutcome(left.outcome, right.outcome) ||
      toTimestamp(right.updatedAt) - toTimestamp(left.updatedAt),
  );
}

function toTimestamp(value: string | number): number {
  if (typeof value === 'number') return value;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * Per-state TTLs (station#1100 AC2): a waiting-for-input/approval row
 * survives long enough that a user can legitimately ignore it overnight; a
 * stale "running" row goes stale within a couple hours; a "done" row has
 * served its purpose within about 15 minutes. That 15-minute figure already
 * governs the Home list's own terminal-linger window
 * (`src-ui/src/views/home/home-lane-model.ts`'s `TERMINAL_LINGER_MS`,
 * landed independently the day before this issue in station#1115) —
 * corroborating evidence for the design's number, not a shared constant
 * (that window decides how long a *finished item lingers in a list*, a
 * different mechanism from a notification/push TTL).
 *
 * `failed` has no dedicated figure in the issue's scope (which names only
 * waiting/running/done); bucketed with `WAITING_TTL_MS` here on the
 * rationale that a failure is exactly as actionable as a pending approval —
 * both need a human to look at them, so neither should expire faster than
 * the other. Disclosed, not silently assumed.
 */
export const WAITING_TTL_MS = 24 * 60 * 60 * 1000;
export const RUNNING_TTL_MS = 2 * 60 * 60 * 1000;
export const DONE_TTL_MS = 15 * 60 * 1000;

export const NOTIFICATION_TTL_MS: Record<NotificationOutcome, number> = {
  'needs-input': WAITING_TTL_MS,
  failed: WAITING_TTL_MS,
  running: RUNNING_TTL_MS,
  done: DONE_TTL_MS,
};

/**
 * Maps a `Notification.category` string to the outcome tier it belongs to,
 * or `undefined` when the category isn't part of this ranking (e.g.
 * scheduler housekeeping categories like `job-missed`/`scheduler-unhealthy`
 * — operational notices, not an "agent work" outcome). Single source of
 * truth for which categories participate in ranking, TTL defaulting
 * (`NotificationService.schedule`), and web-push delivery
 * (`wireWebPushDelivery`).
 */
const CATEGORY_OUTCOME: Record<string, NotificationOutcome> = {
  'approval-request': 'needs-input',
  'job-failure': 'failed',
  // station#1225 (offline slice 3): a turn that finishes/fails while its
  // owning user isn't connected to watch it render — see
  // `turn-completion-notifications.ts`. These are the first categories to
  // exercise the 'done'/'running' tiers this ranking already reserved TTLs
  // for (see `NOTIFICATION_TTL_MS` above) but that nothing previously
  // scheduled.
  'turn-completed': 'done',
  // A requested stop is quiet like a completed turn, but its own category
  // keeps sound/settings filters from presenting it as completion.
  'turn-stopped': 'done',
  'turn-failed': 'failed',
  // station#872: pairing requests and scheduler housekeeping join the ranking
  'pairing-request': 'needs-input',
  'job-missed': 'failed',
  'scheduler-unhealthy': 'failed',
};

export function classifyNotificationCategory(
  category: string,
): NotificationOutcome | undefined {
  return CATEGORY_OUTCOME[category];
}

/**
 * Outcome-first framing for an "all quiet" summary/badge (station#1100):
 * leads with what happened, never a bare zero count like "0 active agents".
 * No live summary/badge surface reads this today (no such surface exists in
 * the codebase yet — disclosed in the PR); it's a tested, reusable composer
 * ready for the push payload path and whatever summary surface follows.
 */
export function outcomeFirstAllQuietHeadline(
  outcome: 'done' | 'failed',
): string {
  return outcome === 'failed' ? 'Agent work failed' : 'Agent work completed';
}
