import type { Notification } from '@kontourai/station-contracts/notification';
import {
  BLOCKING_NOTIFICATION_CATEGORIES,
  type BlockingNotificationCategory,
} from '@kontourai/station-contracts/notification';
import { notifyNatively } from './notify';

/**
 * Fixed copy per category, deliberately NOT the notification's own title or
 * body.
 *
 * An OS notification renders on a lock screen, in a shade, and in a
 * notification centre that outlives the app — surfaces with no authentication
 * between them and anyone holding the machine. The projected text is not safe
 * to put there: approval titles are adapter-supplied and can carry the
 * command being approved (bearer tokens included), and the projection only
 * truncates them, it does not redact. So the alert says that something is
 * waiting and where to answer it; the content stays behind the app.
 */
const ALERT_COPY: Record<
  BlockingNotificationCategory,
  { title: string; body: string }
> = {
  [BLOCKING_NOTIFICATION_CATEGORIES.devicePairing]: {
    title: 'A device is asking to pair',
    body: 'Open Station to approve or deny it.',
  },
  [BLOCKING_NOTIFICATION_CATEGORIES.approvalRequest]: {
    title: 'A run is waiting for your approval',
    body: 'Open Station to review it.',
  },
};

function isBlocking(
  category: string,
): category is BlockingNotificationCategory {
  return category in ALERT_COPY;
}

/**
 * Ids already announced, bound to the connection they were seen on. Module
 * state rather than a hook ref: the whole mechanism lives in this lazily
 * imported chunk, so the entry bundle carries only the query and the platform
 * gate (`scripts/ui-bundle-budget.json` is tight, and this is a feature most
 * sessions never trigger).
 */
let announced: { apiBase: string; ids: Set<string> } | null = null;

/** Test seam: a fresh module per case without reaching into module state. */
export function resetBlockingAlertState(): void {
  announced = null;
}

/**
 * Announce anything newly blocking on this connection, and return how many
 * alerts were posted so a caller can assert on it.
 */
export async function reconcileBlockingAlerts(
  notifications: readonly Notification[],
  apiBase: string,
): Promise<number> {
  const blocking = notifications.filter((notification) =>
    isBlocking(notification.category),
  );
  /**
   * The backlog present when this connection is first observed is seeded,
   * not announced — the user is looking at Station right now, and a burst of
   * OS notifications for things already waiting is how people learn to switch
   * them off.
   *
   * Disclosed consequence: a request that arrives in the same tick
   * as the first observation of a connection is indistinguishable from one
   * that has been waiting an hour, so it is seeded and never announced. The
   * alternative is comparing a server timestamp against the client clock and
   * announcing anything "recent", which trades a bounded miss for
   * skew-dependent double-announcing. It stays visible in-app, and the next
   * request on that connection announces normally.
   */
  if (announced?.apiBase !== apiBase) {
    announced = {
      apiBase,
      ids: new Set(blocking.map((notification) => notification.id)),
    };
    return 0;
  }
  const seen = announced.ids;
  const fresh = blocking.filter((notification) => !seen.has(notification.id));
  for (const notification of fresh) seen.add(notification.id);
  // Resolved requests are forgotten, so a genuinely new request that reuses
  // an id (a re-request after a denial) still announces.
  const live = new Set(blocking.map((notification) => notification.id));
  for (const id of seen) if (!live.has(id)) seen.delete(id);
  let posted = 0;
  for (const notification of fresh) {
    if (!isBlocking(notification.category)) continue;
    await notifyNatively(ALERT_COPY[notification.category]);
    posted += 1;
  }
  return posted;
}
