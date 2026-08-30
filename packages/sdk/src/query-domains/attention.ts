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
 * The one message `POST /api/attention/:id/ack` sends with a 404. The route
 * has a single 404 site (`src-server/routes/orchestration/attention.ts`) and
 * its own route test pins this exact string, so matching it here is a
 * two-sided contract rather than a guess about the wire. Matching the MESSAGE
 * and not the bare status is what keeps the no-op below narrow: a 404 that a
 * later change introduces for some other reason carries a different message
 * and therefore still propagates to the caller.
 */
const NOT_ACKNOWLEDGEABLE = 'Attention item is not acknowledgeable';

/**
 * Acknowledge the current version of an attention item without resolving its
 * source. The server supports every projected kind, including pending device
 * pairing requests whose source must remain pending after acknowledgement.
 *
 * archive#1914: a `NOT_ACKNOWLEDGEABLE` 404 is a NO-OP, not a failure. The
 * server returns it when the item is not in the current projection — already
 * resolved, or resolved by someone else inside the 10s `useAttentionQuery`
 * poll window. That is the ordinary outcome of dismissing a row that has just
 * gone stale on screen, and the caller's next refetch is the source of truth
 * for whether it is gone. Surfacing it would report a failure for an item the
 * user has already got their way about.
 *
 * Every other outcome — any non-404, any 404 carrying a different message, a
 * transport error, or a `success: false` body — throws, so a dismissal that
 * genuinely did not happen still reaches the caller's error surface.
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
  if (response.status === 404 && result.error === NOT_ACKNOWLEDGEABLE) return;
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
