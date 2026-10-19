import { OPENED_NOTIFICATION_QUERY_PARAM } from '@kontourai/station-contracts/notification';
import { navigationStore } from '../../contexts/NavigationContext';

/**
 * Opening an OS alert reads its record. A Web Push tap loads the alert's
 * link (the service worker navigates or opens a tab), and a desktop alert
 * click navigates the app to it (`notificationOpen.ts`); both links name
 * the record in `OPENED_NOTIFICATION_QUERY_PARAM` (the server adds it,
 * `withOpenedNotification`). Whenever the URL carries it — on load or after
 * a navigation — the record is marked read as opened and the parameter is
 * dropped from the URL, so a reload or a shared link does not repeat it.
 * Plain window focus never reads anything: only this explicit open does.
 *
 * Native Android/iOS alert taps route by session (`session_id`), not by
 * this link, so they do not carry the record and do not mark it here.
 */
export function startOpenedNotificationReads(
  markRead: (id: string) => Promise<unknown>,
): () => void {
  const consume = () => {
    if (typeof window === 'undefined') return;
    const id = new URLSearchParams(window.location.search).get(
      OPENED_NOTIFICATION_QUERY_PARAM,
    );
    if (!id) return;
    navigationStore.updateParams({ [OPENED_NOTIFICATION_QUERY_PARAM]: null });
    // A failed mark leaves the record unread; its escalation proceeds.
    void markRead(id).catch(() => undefined);
  };
  consume();
  return navigationStore.subscribe(consume);
}
