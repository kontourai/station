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
  useInvalidateQuery,
} from '../query-core';

export type { NotificationPreferencesPatch, NotificationPreferencesV1 };

const QUERY_KEY = 'notification-preferences';

/**
 * A refused preferences request. `code` is the server's error code:
 * `preferences_unreadable` (the saved file cannot be read — only a full
 * save replaces it), `preferences_changed` (412: someone else wrote since
 * this client read; the query is refetched), `invalid_preferences`, …
 */
export class NotificationPreferencesRequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
  ) {
    super(message);
    this.name = 'NotificationPreferencesRequestError';
  }
}

/**
 * The ETag of the last document read or written, per API base. A PUT sends
 * it as If-Match, so a whole-document write based on a stale read is
 * refused (412) instead of overwriting someone else's change. A PATCH does
 * not: it is the server-side merge of only the named fields, so a change
 * made elsewhere to another field is not a conflict and must not refuse it.
 */
const lastRevision = new Map<string, string>();

async function request(
  apiBase: string | undefined,
  init?: RequestInit & { compareAndSwap?: boolean },
): Promise<NotificationPreferencesV1> {
  const base = await resolveApiBase(apiBase);
  const revision = init?.compareAndSwap ? lastRevision.get(base) : undefined;
  const response = await authenticatedFetch(
    `${base}${NOTIFICATION_PREFERENCES_PATH}`,
    init && {
      method: init.method,
      body: init.body,
      headers: {
        'Content-Type': 'application/json',
        ...(revision ? { 'If-Match': revision } : {}),
      },
    },
  );
  const etag = response.headers.get('etag');
  if (etag) lastRevision.set(base, etag);
  else if (response.status === 412) lastRevision.delete(base);
  // Status first: an older Station answers this path with a plain-text
  // 404, which must surface as a typed error, not a JSON parse failure.
  let result:
    | {
        success?: boolean;
        data?: NotificationPreferencesV1;
        error?: string;
        message?: string;
      }
    | undefined;
  try {
    result = (await response.json()) as typeof result;
  } catch {
    result = undefined;
  }
  if (!response.ok || !result?.success || !result.data) {
    throw new NotificationPreferencesRequestError(
      result?.message ??
        (result
          ? apiErrorMessage(result, `HTTP ${response.status}`)
          : `HTTP ${response.status}`),
      response.status,
      result?.error,
    );
  }
  return result.data;
}

/** How far notifications may interrupt (#2586). */
export function fetchNotificationPreferences(
  apiBase?: string,
): Promise<NotificationPreferencesV1> {
  return request(apiBase);
}

/**
 * Replaces the whole document; the server refuses anything but a complete,
 * valid one, and (with the last read's ETag) a document changed since.
 */
export function updateNotificationPreferences(
  preferences: NotificationPreferencesV1,
  apiBase?: string,
): Promise<NotificationPreferencesV1> {
  return request(apiBase, {
    method: 'PUT',
    body: JSON.stringify(preferences),
    compareAndSwap: true,
  });
}

/**
 * Changes only the fields in the patch, server-side in one step. A map
 * entry of `null` removes it; `quietHours: null` turns quiet hours off.
 */
export function patchNotificationPreferences(
  patch: NotificationPreferencesPatch,
  apiBase?: string,
): Promise<NotificationPreferencesV1> {
  return request(apiBase, { method: 'PATCH', body: JSON.stringify(patch) });
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

/** A 412 means this client's copy is stale: read the current one. */
function useRefetchWhenStale() {
  const invalidate = useInvalidateQuery();
  return (error: Error) => {
    if (
      error instanceof NotificationPreferencesRequestError &&
      error.code === 'preferences_changed'
    )
      void invalidate([QUERY_KEY]);
  };
}

export function useUpdateNotificationPreferencesMutation(apiBase?: string) {
  const onError = useRefetchWhenStale();
  return useApiMutation(
    (preferences: NotificationPreferencesV1) =>
      updateNotificationPreferences(preferences, apiBase),
    { invalidateKeys: [[QUERY_KEY]], onError },
  );
}

export function usePatchNotificationPreferencesMutation(apiBase?: string) {
  const onError = useRefetchWhenStale();
  return useApiMutation(
    (patch: NotificationPreferencesPatch) =>
      patchNotificationPreferences(patch, apiBase),
    { invalidateKeys: [[QUERY_KEY]], onError },
  );
}
