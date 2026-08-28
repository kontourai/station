import {
  LIVE_NOTIFICATION_STATUSES,
  useNotificationsQuery,
} from '@kontourai/station-sdk';
import { useEffect } from 'react';
import { useApiBase } from '../contexts/ApiBaseContext';
import { usePlatformProfile } from '../platform/PlatformProfileContext';

/**
 * Raise an OS notification when something starts blocking the operator.
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
 * - **Blocking categories only** — the ones that expire and hold up a person.
 * - **Additive.** The in-app surfaces are unchanged and remain where
*   decisions are made; a refused or unavailable notifier changes nothing.
 *
 * Only the query and this platform gate live in the entry chunk: category
 * matching, copy, dedupe, and the notifier load on first alert.
 */
export function useApprovalOsAlerts(): void {
  const { apiBase } = useApiBase();
  const profile = usePlatformProfile();
  const enabled = profile.isTauri && profile.isDesktop && !profile.isMobile;
  const { data } = useNotificationsQuery(
    { status: LIVE_NOTIFICATION_STATUSES },
    { refetchInterval: 10_000, enabled },
  );

  useEffect(() => {
    if (!enabled || !data) return;
    void import('../platform/native/blockingAlert').then((module) =>
      module.reconcileBlockingAlerts(data, apiBase),
    );
  }, [apiBase, data, enabled]);
}
