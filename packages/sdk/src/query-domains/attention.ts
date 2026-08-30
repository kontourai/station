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
 * Acknowledge the current version of an attention item without resolving its
 * source. The server supports every projected kind, including pending device
 * pairing requests whose source must remain pending after acknowledgement.
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
