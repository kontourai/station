/**
 * What an iOS registration's Live Activity needs next, as a pure function of
 * the activity the Station last started on it, the card that phone should
 * now show, and what it was last sent. The publisher turns the steps into
 * gateway requests (docs/design/notification-delivery.md, "iOS").
 *
 * | stored activity | card                              | steps                          |
 * | --------------- | --------------------------------- | ------------------------------ |
 * | none            | active and not yet sent           | start                          |
 * | none            | inactive, empty, or already sent  | nothing                        |
 * | present         | active, started ≥ 7 h 30 m ago    | end (dismiss now), then start  |
 * | present         | active, changed or refresh due    | update                         |
 * | present         | active, unchanged                 | nothing                        |
 * | present         | inactive with rows                | end with it, dismiss ≤ 4 h     |
 * | present         | empty, or read access lost        | end, dismiss now               |
 *
 * `alert` is set on the step that carries alerts the phone has not had: the
 * start or update of an active card, or the end of a finished one. A
 * rollover's end never alerts; its start does.
 *
 * Channels are not planned here: a start makes its own (the gateway creates
 * it inside the start), and the publisher deletes an ended activity's
 * channel once `dismissAtMs` has passed — at once for an immediate end, so a
 * rollover is end, delete, and a start on a new channel.
 */

/** Apple ends a Live Activity after 8 h; roll over before that. */
export const LIVE_ACTIVITY_ROLLOVER_AFTER_MS = 7.5 * 60 * 60 * 1000;
/** The latest dismissal the gateway accepts, relative to now. */
export const LIVE_ACTIVITY_MAX_DISMISS_MS = 4 * 60 * 60 * 1000;
/** Re-send a live card this long before it goes stale on the phone. */
export const LIVE_ACTIVITY_REFRESH_BEFORE_STALE_MS = 30 * 60 * 1000;

export type LiveActivityStep =
  | { event: 'start'; alert: boolean; staleAtMs: number }
  | { event: 'update'; alert: boolean; staleAtMs: number }
  | { event: 'end'; alert: boolean; dismissAtMs: number };

export interface LiveActivityPlanInput {
  now: number;
  /** The activity last started on this registration, if any. */
  activity?: { startedAt: number };
  card: {
    active: boolean;
    rows: readonly string[];
    expiresAt: number;
    contentKey: string;
  };
  /** False when the phone's device may no longer read sessions. */
  readable: boolean;
  /** What this registration was last sent (and accepted or refused). */
  lastSent?: { contentKey: string; expiresAt: number };
  /** The card carries alerts this phone has not been sent. */
  pendingAlert: boolean;
}

export function planLiveActivity(
  input: LiveActivityPlanInput,
): LiveActivityStep[] {
  const { now, activity, card, lastSent, pendingAlert } = input;
  const changed = lastSent?.contentKey !== card.contentKey || pendingAlert;
  const start = (): LiveActivityStep => ({
    event: 'start',
    alert: pendingAlert,
    staleAtMs: card.expiresAt,
  });

  if (!activity) {
    return input.readable && card.active && changed ? [start()] : [];
  }
  if (!input.readable || card.rows.length === 0)
    return [{ event: 'end', alert: false, dismissAtMs: now }];
  if (!card.active)
    return [
      {
        event: 'end',
        alert: pendingAlert,
        dismissAtMs: Math.max(
          now,
          Math.min(card.expiresAt, now + LIVE_ACTIVITY_MAX_DISMISS_MS),
        ),
      },
    ];
  if (now - activity.startedAt >= LIVE_ACTIVITY_ROLLOVER_AFTER_MS)
    return [{ event: 'end', alert: false, dismissAtMs: now }, start()];
  const refreshDue =
    lastSent !== undefined &&
    lastSent.expiresAt - now <= LIVE_ACTIVITY_REFRESH_BEFORE_STALE_MS;
  if (changed || refreshDue)
    return [
      { event: 'update', alert: pendingAlert, staleAtMs: card.expiresAt },
    ];
  return [];
}

/** When the activity started at `startedAt` must be rolled over. */
export function liveActivityRolloverAt(startedAt: number): number {
  return startedAt + LIVE_ACTIVITY_ROLLOVER_AFTER_MS;
}
