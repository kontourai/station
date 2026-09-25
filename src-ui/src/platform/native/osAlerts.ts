import type { Notification } from '@kontourai/station-contracts/notification';
import { BLOCKING_NOTIFICATION_CATEGORIES } from '@kontourai/station-contracts/notification';
import { reconcileBlockingAlerts } from './blockingAlert';
import { reconcileNotificationAlerts } from './notificationAlert';

/**
 * Hands one observed notification list to both OS-alert channels
 * (`useNotificationOsAlerts`). Lives in this lazily loaded chunk so the
 * entry bundle carries only the query and the platform gate.
 */

/**
 * The connection the channels last saw, and when it changed. The
 * notifications cache key carries no connection, and a Station switch
 * INVALIDATES rather than clears it — so the first list observed on the new
 * connection is still the previous Station's. Handing that over would seed
 * the channels with the wrong Station's ids, and the new Station's whole
 * backlog would then announce as new. Only a list fetched after the switch
 * is observed. Two saved Stations can share an endpoint, so the key carries
 * the connection id as well as the endpoint.
 */
let scope: { key: string; since: number } | null = null;

/** Test seam. */
export function resetOsAlertScope(): void {
  scope = null;
}

export function reconcileOsAlerts(input: {
  notifications: readonly Notification[];
  apiBase: string;
  scopeKey: string;
  /** React Query's `dataUpdatedAt` for this list; absent = unknown. */
  dataUpdatedAt?: number;
}): void {
  const { notifications, apiBase, scopeKey, dataUpdatedAt } = input;
  if (scope === null) {
    scope = { key: scopeKey, since: 0 };
  } else if (scope.key !== scopeKey) {
    scope = { key: scopeKey, since: Date.now() };
    return;
  }
  if (dataUpdatedAt !== undefined && dataUpdatedAt <= scope.since) return;

  let local = false;
  try {
    local = ['localhost', '127.0.0.1', '[::1]'].includes(
      new URL(apiBase).hostname,
    );
  } catch {
    /* Remote/unknown targets keep their existing delivery path. */
  }
  // Owned local pairing requests are announced by the tray, including while
  // this WebView is closed. Do not post the same request a second time here.
  const alerts = local
    ? notifications.filter(
        (item) =>
          item.category !== BLOCKING_NOTIFICATION_CATEGORIES.devicePairing,
      )
    : notifications;
  void reconcileBlockingAlerts(alerts, apiBase);
  // Always handed over, envelope or not: the channel seeds on its first
  // observation, so skipping lists without an envelope would seed — and so
  // silently swallow — the first agent notification of the session.
  void reconcileNotificationAlerts(notifications, apiBase, undefined, scopeKey);
}
