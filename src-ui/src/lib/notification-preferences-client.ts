import type {
  NotificationPreferencesPatch,
  NotificationPreferencesV1,
} from '@kontourai/station-contracts/notification-preferences';
import {
  fetchNotificationPreferences,
  NotificationPreferencesRequestError,
  patchNotificationPreferences,
} from '@kontourai/station-sdk';

/**
 * The inbox's Mute action against the notification preferences (#2586).
 *
 * The client never evaluates the preferences: the server's delivery router
 * applies them, and the desktop OS channel reads its decisions from the
 * delivery feed. This only feature-detects the route and writes a mute
 * through the SDK.
 *
 * `read()` separates two non-answers:
 * - `unavailable` — no route (404/405): an older Station with nothing to
 *   mute; the action is not offered.
 * - `failed` — the route could not answer (409 `preferences_unreadable`,
 *   5xx, network, a non-JSON body): the action is not offered either,
 *   rather than offering one that is likely to fail.
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

export interface NotificationPreferencesTransport {
  fetch(apiBase: string): Promise<NotificationPreferencesV1>;
  patch(
    patch: NotificationPreferencesPatch,
    apiBase: string,
  ): Promise<NotificationPreferencesV1>;
}

const sdkTransport: NotificationPreferencesTransport = {
  fetch: (apiBase) => fetchNotificationPreferences(apiBase),
  patch: (patch, apiBase) => patchNotificationPreferences(patch, apiBase),
};

export function createNotificationPreferencesClient(input: {
  apiBase: string;
  transport?: NotificationPreferencesTransport;
}): NotificationPreferencesClient {
  const transport = input.transport ?? sdkTransport;
  const { apiBase } = input;
  return {
    async read() {
      try {
        await transport.fetch(apiBase);
        return 'ok';
      } catch (error) {
        return isAbsentRoute(error) ? 'unavailable' : 'failed';
      }
    },

    async mute(target) {
      // A server-side PATCH of the one key: the server merges it, so a
      // concurrent change to any other field is never lost and no If-Match
      // round-trip is needed.
      const patch: NotificationPreferencesPatch =
        target.kind === 'agent'
          ? { perAgent: { [target.agent]: 'off' } }
          : { perProject: { [target.projectId]: 'off' } };
      try {
        await transport.patch(patch, apiBase);
        return 'muted';
      } catch (error) {
        return isAbsentRoute(error) ? 'unavailable' : 'failed';
      }
    },
  };
}

function isAbsentRoute(error: unknown): boolean {
  return (
    error instanceof NotificationPreferencesRequestError &&
    (error.status === 404 || error.status === 405)
  );
}
