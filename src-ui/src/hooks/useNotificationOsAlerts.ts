import {
  LIVE_NOTIFICATION_STATUSES,
  useNotificationsQuery,
} from '@kontourai/station-sdk';
import { useEffect } from 'react';
import { useApiBase } from '../contexts/ApiBaseContext';
import { usePlatformProfile } from '../platform/PlatformProfileContext';

/**
 * Raise OS notifications on a desktop native host (#2587 generalises the
 * archive#1912 blocking alert).
 *
 * Two channels read the same live list:
 * - **Blocking categories** (`blockingAlert.ts`) — unchanged: fixed copy,
 *   announced whatever the window's focus, minus local pairing requests the
 *   tray already owns.
 * - **Enveloped notifications** (`deliveryFeed.ts`) — agent and other
 *   producers' records with `metadata.envelope`, read from the server's
 *   delivery feed for this app's own surface (`local:desktop-<installationId>`
 *   on this computer's Station, `device:<id>` on a remote one). The
 *   server's router decides them (focus, quiet hours, mutes, minUrgency,
 *   hideContent); the client only skips posting while its window is focused.
 *   Polled every {@link DELIVERY_FEED_POLL_MS}, inside the server's 90 s
 *   host lease.
 *
 * The original account of the blocking alert follows.
 *
 * archive#1912, from live use: a device pairing request expires in five
 * minutes, and the only surfaces carrying it were a popover the operator had
 * to open and a list they had to be watching. The operator was sitting in
 * front of Station and still ended up polling the API from a shell.
 *
 * Reads the notification stream directly rather than the attention
 * projection: that projection derives `kind: 'approval'` from the
 * `approval-request` category ALONE, so a pairing request — the case this
 * exists for — never appears in it.
 *
 * Scope, deliberately narrow:
 * - **Desktop native hosts only.** On Android the webview is frozen when
 *   backgrounded, so a foreground post is silence exactly when it matters;
 * that case needs the host-side watch (archive#917), which stays dormant.
 * - **Blocking categories and enveloped records only** — the channels above;
 *   other legacy categories stay in-app.
 * - **Not while hidden in the tray.** The poll below does not run then: React
 *   Query pauses `refetchInterval` while `document.visibilityState` is
 *   `hidden` (no `refetchIntervalInBackground`), and WKWebView's default
 *   inactive scheduling policy suspends a hidden window's page (Station sets
 *   no `backgroundThrottling`). Covering that needs a host-side watch; the
 *   dormant `notification_watch.rs` is not it — it posts raw titles.
 * - **Additive.** The in-app surfaces are unchanged and remain where
 *   decisions are made; a refused or unavailable notifier changes nothing.
 *
 * Only the query and this platform gate live in the entry chunk: category
 * matching, copy, dedupe, and the notifier load on first alert.
 */
/** Well inside the desktop host channel's 90 s lease. */
export const DELIVERY_FEED_POLL_MS = 20_000;

export function useNotificationOsAlerts(): void {
  const { apiBase, connectionId } = useApiBase();
  const profile = usePlatformProfile();
  const enabled = profile.isTauri && profile.isDesktop && !profile.isMobile;
  const { data, dataUpdatedAt } = useNotificationsQuery(
    { status: LIVE_NOTIFICATION_STATUSES },
    { refetchInterval: 10_000, enabled },
  );
  useEffect(() => {
    if (!enabled || !data) return;
    // Connection scoping, the local-pairing filter and the blocking channel live in
    // the lazily loaded `osAlerts` chunk (entry-bundle budget).
    void import('../platform/native/osAlerts').then((module) =>
      module.reconcileOsAlerts({
        notifications: data,
        apiBase,
        scopeKey: `${apiBase}\n${connectionId ?? ''}`,
        dataUpdatedAt,
      }),
    );
  }, [apiBase, connectionId, data, dataUpdatedAt, enabled]);

  useEffect(() => {
    if (!enabled) return;
    const scopeKey = `${apiBase}\n${connectionId ?? ''}`;
    const poll = () =>
      void import('../platform/native/deliveryFeed').then((module) =>
        module.pollDeliveryFeed(apiBase, scopeKey),
      );
    poll();
    const timer = setInterval(poll, DELIVERY_FEED_POLL_MS);
    return () => clearInterval(timer);
  }, [apiBase, connectionId, enabled]);
}
