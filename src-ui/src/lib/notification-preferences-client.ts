import {
  NOTIFICATION_PREFERENCES_PATH,
  type NotificationPreferencesPatch,
} from '@kontourai/station-contracts/notification-preferences';
import { authenticatedFetch } from '@kontourai/station-sdk';

/**
 * The inbox's Mute action against the notification preferences (#2586).
 *
 * The client never evaluates the preferences: the server's delivery router
 * applies them, and the desktop OS channel reads its decisions from the
 * delivery feed. This only feature-detects the route and writes a mute.
 *
 * `read()` separates two non-answers, because only one of them says anything
 * about the Station:
 * - `unavailable` — no route (404/405): an older Station with nothing to
 *   mute; the action is not offered.
 * - `failed` — the route exists but could not answer (409
 *   `preferences_unreadable`, 5xx, network): the action is not offered
 *   either, rather than offering one that is likely to fail.
 */
export type NotificationPreferencesReadStatus = 'ok' | 'unavailable' | 'failed';

export type NotificationMuteTarget =
  | { kind: 'agent'; agent: string }
  | { kind: 'project'; projectId: string };

export type NotificationMuteResult = 'muted' | 'unavailable' | 'failed';

export interface NotificationPreferencesClient {
  /** Never throws. */
  read(): Promise<NotificationPreferencesReadStatus>;
  mute(target: NotificationMuteTarget): Promise<NotificationMuteResult>;
}

type FetchLike = (
  input: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string },
) => Promise<Pick<Response, 'ok' | 'status' | 'json'>>;

export function createNotificationPreferencesClient(input: {
  apiBase: string;
  fetch?: FetchLike;
}): NotificationPreferencesClient {
  const request: FetchLike = input.fetch ?? authenticatedFetch;
  const url = `${input.apiBase}${NOTIFICATION_PREFERENCES_PATH}`;
  return {
    async read() {
      try {
        const response = await request(url);
        if (response.status === 404 || response.status === 405)
          return 'unavailable';
        if (!response.ok) return 'failed';
        const body = (await response.json()) as { success?: unknown };
        return body.success === true ? 'ok' : 'failed';
      } catch {
        return 'failed';
      }
    },

    async mute(target) {
      // A server-side PATCH: one step, so a concurrent settings edit is
      // never lost to a read-modify-write here.
      const patch: NotificationPreferencesPatch =
        target.kind === 'agent'
          ? { perAgent: { [target.agent]: 'off' } }
          : { perProject: { [target.projectId]: 'off' } };
      try {
        const response = await request(url, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(patch),
        });
        if (response.status === 404 || response.status === 405)
          return 'unavailable';
        return response.ok ? 'muted' : 'failed';
      } catch {
        return 'failed';
      }
    },
  };
}
