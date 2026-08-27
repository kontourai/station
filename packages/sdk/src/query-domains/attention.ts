import type { AttentionProjection } from '@kontourai/station-contracts/attention';
import { apiErrorMessage } from '../api-core';
import { authenticatedFetch } from '../client/http';
import {
  type QueryConfig,
  resolveApiBase,
  useApiMutation,
  useApiQuery,
} from '../query-core';
export async function fetchAttention(
  apiBase?: string,
): Promise<AttentionProjection> {
  const resolvedApiBase = await resolveApiBase(apiBase);
  const response = await authenticatedFetch(`${resolvedApiBase}/api/attention`);
  const result = (await response.json()) as {
    success: boolean;
    data?: AttentionProjection;
    error?: string;
  };
  if (!response.ok || !result.success || !result.data) {
    throw new Error(apiErrorMessage(result, `HTTP ${response.status}`));
  }
  return result.data;
}

export function useAttentionQuery(
  apiBase?: string,
  config?: QueryConfig<AttentionProjection>,
) {
  return useApiQuery(
    ['attention', apiBase ?? 'default'],
    () => fetchAttention(apiBase),
    { refetchInterval: 10_000, ...config },
  );
}

/**
 * station#1914: acknowledge a `session-failed` attention item — the one kind
 * with no stored notification a `DELETE /notifications/:id` could reach.
 * 404s (item already resolved, or never acknowledgeable) are swallowed here
 * the same way the read-only projection already treats a vanished item: the
 * caller's next `useAttentionQuery` refetch is the source of truth.
 */
export async function acknowledgeAttentionItem(
  itemId: string,
  apiBase?: string,
): Promise<void> {
  const resolvedApiBase = await resolveApiBase(apiBase);
  const response = await authenticatedFetch(
    `${resolvedApiBase}/api/attention/${encodeURIComponent(itemId)}/ack`,
    { method: 'POST' },
  );
  if (response.status === 404) return;
  const result = (await response.json()) as {
    success: boolean;
    error?: string;
  };
  if (!response.ok || !result.success) {
    throw new Error(apiErrorMessage(result, `HTTP ${response.status}`));
  }
}

export function useAcknowledgeAttentionItemMutation(apiBase?: string) {
  const mutationFn = (itemId: string) =>
    acknowledgeAttentionItem(itemId, apiBase);
  // Prefix key, matching every other attention/notification mutation in
  // this file (e.g. `useDismissNotificationMutation`) — React Query's
  // `invalidateQueries` matches by key PREFIX, so `['attention']` reaches
  // `useAttentionQuery`'s `['attention', apiBase]` regardless of which
  // apiBase that read used, without this mutation needing to know it too.
  return useApiMutation(mutationFn, {
    invalidateKeys: [['attention']],
  });
}
