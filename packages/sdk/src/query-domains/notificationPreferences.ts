import {
  NOTIFICATION_PREFERENCES_PATH,
  type NotificationPreferencesPatch,
  type NotificationPreferencesV1,
} from '@kontourai/station-contracts/notification-preferences';
import { apiErrorMessage } from '../api-core';
import { authenticatedFetch } from '../client/http';
import {
  type QueryConfig,
  resolveApiBase,
  useApiMutation,
  useApiQuery,
} from '../query-core';

export type { NotificationPreferencesPatch, NotificationPreferencesV1 };

const QUERY_KEY = 'notification-preferences';

/** How far notifications may interrupt (#2586). */
export async function fetchNotificationPreferences(
  apiBase?: string,
): Promise<NotificationPreferencesV1> {
  const base = await resolveApiBase(apiBase);
  const response = await authenticatedFetch(
    `${base}${NOTIFICATION_PREFERENCES_PATH}`,
  );
  const result = (await response.json()) as {
    success: boolean;
    data?: NotificationPreferencesV1;
    error?: string;
    message?: string;
  };
  if (!response.ok || !result.success || !result.data) {
    throw new Error(
      result.message ?? apiErrorMessage(result, `HTTP ${response.status}`),
    );
  }
  return result.data;
}

/** Replaces the whole document; the server refuses anything but a complete, valid one. */
export async function updateNotificationPreferences(
  preferences: NotificationPreferencesV1,
  apiBase?: string,
): Promise<NotificationPreferencesV1> {
  const base = await resolveApiBase(apiBase);
  const response = await authenticatedFetch(
    `${base}${NOTIFICATION_PREFERENCES_PATH}`,
    {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(preferences),
    },
  );
  const result = (await response.json()) as {
    success: boolean;
    data?: NotificationPreferencesV1;
    error?: string;
    message?: string;
  };
  if (!response.ok || !result.success || !result.data) {
    throw new Error(
      result.message ?? apiErrorMessage(result, `HTTP ${response.status}`),
    );
  }
  return result.data;
}

/**
 * Changes only the fields in the patch, server-side in one step, so a
 * concurrent change to another field is never lost. A map entry of `null`
 * removes it; `quietHours: null` turns quiet hours off.
 */
export async function patchNotificationPreferences(
  patch: NotificationPreferencesPatch,
  apiBase?: string,
): Promise<NotificationPreferencesV1> {
  const base = await resolveApiBase(apiBase);
  const response = await authenticatedFetch(
    `${base}${NOTIFICATION_PREFERENCES_PATH}`,
    {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    },
  );
  const result = (await response.json()) as {
    success: boolean;
    data?: NotificationPreferencesV1;
    error?: string;
    message?: string;
  };
  if (!response.ok || !result.success || !result.data) {
    throw new Error(
      result.message ?? apiErrorMessage(result, `HTTP ${response.status}`),
    );
  }
  return result.data;
}

export function useNotificationPreferencesQuery(
  apiBase?: string,
  config?: QueryConfig<NotificationPreferencesV1>,
) {
  return useApiQuery(
    [QUERY_KEY, apiBase ?? 'default'],
    () => fetchNotificationPreferences(apiBase),
    { retry: false, ...config },
  );
}

export function useUpdateNotificationPreferencesMutation(apiBase?: string) {
  return useApiMutation(
    (preferences: NotificationPreferencesV1) =>
      updateNotificationPreferences(preferences, apiBase),
    { invalidateKeys: [[QUERY_KEY]] },
  );
}

export function usePatchNotificationPreferencesMutation(apiBase?: string) {
  return useApiMutation(
    (patch: NotificationPreferencesPatch) =>
      patchNotificationPreferences(patch, apiBase),
    { invalidateKeys: [[QUERY_KEY]] },
  );
}
