import type {
  Notification,
  NotificationEnvelopeV1,
} from '@kontourai/station-contracts/notification';
import { BLOCKING_NOTIFICATION_CATEGORIES } from '@kontourai/station-contracts/notification';
import { readNotificationEnvelope } from '@kontourai/station-shared/notification-envelope';
import {
  agentAlertAllowed,
  type ClientNotificationPreferences,
  createNotificationPreferencesClient,
  isWithinQuietHours,
} from '../../lib/notification-preferences-client';
import { notifyNatively } from './notify';

/**
 * Desktop OS channel for enveloped notifications (#2587, design §3).
 *
 * The companion of `blockingAlert.ts`, which is unchanged and still owns the
 * blocking categories with their fixed copy. This handles records carrying a
 * `metadata.envelope` (agent `notify_user` and later producers):
 *
 * - **Only while this window is not in use.** A notification that arrives
 *   while the operator is looking at Station is theirs in-app (toast, bell);
 *   raising an OS alert on top is the double-surfacing that teaches people to
 *   switch alerts off. Focus is sampled when the record is first observed, so
 *   looking away later does not replay it.
 * - **Addressed to this client.** The list endpoint already filters by read
 *   authority, so every record it returns is one this client may see.
 * - **Seeded on first observation**, exactly like the blocking path: the
 *   backlog present when a connection is first observed is never announced.
 * - **Delivered only.** A `pending` (scheduled) record is neither announced
 *   nor seeded; it alerts once it is delivered.
 * - **Preferences** (quiet hours, mutes) come through the preferences
 *   client. A Station without the route gets the defaults; one whose
 *   preferences could not be read gets content-free copy, because its
 *   wishes are unknown. Per-surface `hideContent` for this desktop surface
 *   is not honoured yet — it needs the stable surface id #2586 defines.
 *
 * Clicking the OS notification cannot open its target here:
 * `tauri-plugin-notification` 2.4.0 on desktop posts through a
 * `window.Notification` shim with no click events, and its Rust side drops
 * the notify-rust handle. Opening + marking read happens from the in-app
 * surfaces (`activateNotification`) until a native click seam exists.
 */
export interface NotificationAlertDeps {
  isWindowFocused(): boolean;
  readPreferences(): Promise<ClientNotificationPreferences>;
  notify(input: { title: string; body?: string }): Promise<boolean>;
  now(): Date;
}

/** Ids observed per connection; module state for the same reason as blockingAlert. */
let observed: { scopeKey: string; ids: Set<string> } | null = null;

/** Test seam: a fresh module per case without reaching into module state. */
export function resetNotificationAlertState(): void {
  observed = null;
}

function defaultDeps(apiBase: string): NotificationAlertDeps {
  return {
    isWindowFocused: () =>
      document.visibilityState === 'visible' && document.hasFocus(),
    readPreferences: async () =>
      (await createNotificationPreferencesClient({ apiBase }).read())
        .preferences,
    notify: notifyNatively,
    now: () => new Date(),
  };
}

const BLOCKING = new Set<string>(
  Object.values(BLOCKING_NOTIFICATION_CATEGORIES),
);

/**
 * Returns how many OS alerts were posted. `scopeKey` identifies the
 * connection the list was read from (defaults to `apiBase`); two saved
 * Stations sharing one endpoint must pass distinct keys, or one's backlog
 * reads as new on the other.
 */
export async function reconcileNotificationAlerts(
  notifications: readonly Notification[],
  apiBase: string,
  deps: NotificationAlertDeps = defaultDeps(apiBase),
  scopeKey: string = apiBase,
): Promise<number> {
  const enveloped = notifications.flatMap((notification) => {
    if (BLOCKING.has(notification.category)) return [];
    if (notification.status !== 'delivered') return [];
    const envelope = readNotificationEnvelope(notification);
    return envelope ? [{ notification, envelope }] : [];
  });
  const ids = new Set(enveloped.map(({ notification }) => notification.id));
  if (observed?.scopeKey !== scopeKey) {
    observed = { scopeKey, ids };
    return 0;
  }
  const seen = observed.ids;
  const fresh = enveloped.filter(
    ({ notification }) => !seen.has(notification.id),
  );
  for (const { notification } of fresh) seen.add(notification.id);
  // Forget what left the live set so the seen-set stays bounded.
  for (const id of seen) if (!ids.has(id)) seen.delete(id);
  // Everything above is synchronous, so an overlapping reconcile can never
  // pick the same record up twice.
  if (fresh.length === 0 || deps.isWindowFocused()) return 0;

  const preferences = await deps.readPreferences();
  const now = deps.now();
  let posted = 0;
  for (const { notification, envelope } of fresh) {
    if (!shouldRaiseOsAlert(envelope, preferences, now)) continue;
    await deps.notify(
      notificationAlertCopy(notification, envelope, preferences.hideContent),
    );
    posted += 1;
  }
  return posted;
}

export function shouldRaiseOsAlert(
  envelope: NotificationEnvelopeV1,
  preferences: ClientNotificationPreferences,
  now: Date,
): boolean {
  if (envelope.interrupt === 'silent') return false;
  if (envelope.readAt || envelope.dismissedAt) return false;
  if (!agentAlertAllowed(preferences, envelope.source, envelope.urgency))
    return false;
  if (
    preferences.quietHours &&
    isWithinQuietHours(preferences.quietHours, now)
  ) {
    return (
      envelope.urgency === 'attention' && preferences.quietHours.allowAttention
    );
  }
  return true;
}

/**
 * `hideContent` (today: only when the preferences could not be read) replaces
 * the text with fixed, content-free copy: an OS
 * notification renders on a lock screen and in a notification centre with
 * nothing authenticating the reader.
 */
export function notificationAlertCopy(
  notification: Pick<Notification, 'title' | 'body'>,
  envelope: NotificationEnvelopeV1,
  hideContent: boolean,
): { title: string; body?: string } {
  if (!hideContent) {
    return notification.body
      ? { title: notification.title, body: notification.body }
      : { title: notification.title };
  }
  if (envelope.source.kind !== 'agent') {
    return { title: 'Station', body: 'You have a new notification.' };
  }
  return {
    title: 'Station',
    body:
      envelope.urgency === 'attention'
        ? 'An agent needs your attention.'
        : 'An agent sent you a notification.',
  };
}
