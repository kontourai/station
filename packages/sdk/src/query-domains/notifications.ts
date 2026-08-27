import type {
  Notification,
  NotificationStatus,
} from '@kontourai/station-contracts/notification';
import { useQueryClient } from '@tanstack/react-query';
import { _getApiBase } from '../api';
import { type QueryConfig, useApiMutation, useApiQuery } from '../query-core';

/**
 * Statuses a user still has to deal with. The other three — `dismissed`,
 * `expired`, `actioned` — are terminal: the user handled them somewhere, and
 * resurfacing them would be noise. `delivered` is live, not done; it only means
 * the server handed the notification to a client.
 *
 * Typed against the contract so adding a status to `NotificationStatus` without
 * classifying it here is a type error rather than a silent omission.
 */
export const LIVE_NOTIFICATION_STATUSES: NotificationStatus[] = [
  'pending',
  'delivered',
];

/**
 * The one place the notifications list URL is built. The native shell polls the
 * same endpoint from outside the webview, so this must not be a literal that
 * exists in two languages.
 */
export function notificationsUrl(
  apiBase: string,
  input?: { category?: string[]; status?: string[] },
): string {
  const params = new URLSearchParams();
  input?.status?.forEach((status) => params.append('status', status));
  input?.category?.forEach((category) => params.append('category', category));
  const query = params.toString();
  return `${apiBase}/notifications${query ? `?${query}` : ''}`;
}

export async function fetchNotifications(input?: {
  category?: string[];
  status?: string[];
}): Promise<Notification[]> {
  const apiBase = await _getApiBase();
  const response = await authenticatedFetch(notificationsUrl(apiBase, input));
  const result = (await response.json()) as {
    success: boolean;
    data?: Notification[];
    error?: string;
  };
  if (!result.success) {
    throw new Error(apiErrorMessage(result, 'Failed to fetch notifications'));
  }
  return result.data ?? [];
}

export async function dismissNotification(id: string): Promise<void> {
  const apiBase = await _getApiBase();
  const response = await authenticatedFetch(`${apiBase}/notifications/${id}`, {
    method: 'DELETE',
  });
  const result = (await response.json()) as {
    success: boolean;
    error?: string;
  };
  if (!result.success) {
    throw new Error(apiErrorMessage(result, 'Failed to dismiss notification'));
  }
}

export async function clearNotifications(): Promise<void> {
  const apiBase = await _getApiBase();
  const response = await authenticatedFetch(`${apiBase}/notifications`, {
    method: 'DELETE',
  });
  const result = (await response.json()) as {
    success: boolean;
    error?: string;
  };
  if (!result.success) {
    throw new Error(apiErrorMessage(result, 'Failed to clear notifications'));
  }
}

export async function clearNotificationActivity(): Promise<void> {
  const apiBase = await _getApiBase();
  const response = await authenticatedFetch(
    `${apiBase}/notifications/activity`,
    {
      method: 'DELETE',
    },
  );
  const result = (await response.json()) as {
    success: boolean;
    error?: string;
  };
  if (!result.success) {
    throw new Error(
      apiErrorMessage(result, 'Failed to clear notification activity'),
    );
  }
}

export async function actOnNotification(input: {
  actionId: string;
  id: string;
}): Promise<void> {
  const apiBase = await _getApiBase();
  const response = await authenticatedFetch(
    `${apiBase}/notifications/${encodeURIComponent(input.id)}/action/${encodeURIComponent(input.actionId)}`,
    {
      method: 'POST',
    },
  );
  const result = (await response.json()) as {
    success: boolean;
    error?: string;
  };
  if (!result.success) {
    throw new Error(apiErrorMessage(result, 'Failed to act on notification'));
  }
}

export function useNotificationsQuery(
  input?: { category?: string[]; status?: string[] },
  config?: QueryConfig<Notification[]>,
) {
  return useApiQuery(
    ['notifications', input ?? {}],
    () => fetchNotifications(input),
    config,
  );
}

export function useDismissNotificationMutation() {
  return useApiMutation(dismissNotification, {
    invalidateKeys: [['notifications'], ['attention']],
  });
}

export function useNotificationActionMutation() {
  return useApiMutation(actOnNotification, {
    invalidateKeys: [['notifications'], ['attention']],
  });
}

export function useClearNotificationsMutation() {
  return useApiMutation(clearNotifications, {
    invalidateKeys: [['notifications'], ['attention']],
  });
}

export function useClearNotificationActivityMutation() {
  return useApiMutation(clearNotificationActivity, {
    invalidateKeys: [['notifications'], ['attention']],
  });
}

export function useInvalidateNotifications() {
  const queryClient = useQueryClient();
  return () => queryClient.invalidateQueries({ queryKey: ['notifications'] });
}

import { apiErrorMessage } from '../api-core';
import { authenticatedFetch } from '../client/http';
