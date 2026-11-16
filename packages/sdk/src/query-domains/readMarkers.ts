import {
  type ReadMarkerState,
  type ReadMarkerSummary,
  type ReadMarkerTarget,
  readMarkerTargetKey,
} from '@kontourai/station-contracts/read-markers';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { _getApiBase } from '../api';
import { fetchReadMarkerSummary, markRead } from '../client/read-markers';
import {
  type InventorySnapshot,
  markInventoryRead,
  restoreInventory,
} from '../inventory-read-state';
import type { MutationOptions } from '../query-core';
import { conversationQueries } from '../queryFactories';

export { fetchReadMarkerSummary, markRead } from '../client/read-markers';

/**
 * Query keys for server-kept read state (#3075). A summary is keyed by the
 * exact targets it names, so two surfaces asking about the same set share one
 * request.
 */
export const readMarkerQueries = {
  all: () => ['read-markers'] as const,
  summary: (targets: readonly ReadMarkerTarget[]) => ({
    queryKey: [
      'read-markers',
      'summary',
      targets.map(readMarkerTargetKey),
    ] as const,
    staleTime: 10_000,
  }),
};

/**
 * Unread state for many conversations (agent conversations, Project rooms,
 * Task rooms) in one request. At most `READ_MARKER_SUMMARY_MAX_TARGETS`
 * targets; the server refuses more. Disabled for an empty list.
 */
export function useReadMarkerSummaryQuery(
  targets: readonly ReadMarkerTarget[],
  config?: { enabled?: boolean; refetchInterval?: number | false },
) {
  const { queryKey, staleTime } = readMarkerQueries.summary(targets);
  return useQuery<ReadMarkerSummary>({
    queryKey,
    queryFn: async ({ signal }) =>
      fetchReadMarkerSummary(await _getApiBase(), targets, { signal }),
    staleTime,
    enabled: (config?.enabled ?? true) && targets.length > 0,
    refetchInterval: config?.refetchInterval,
  });
}

/**
 * Mark a conversation read through the version the person was shown.
 * Monotonic and idempotent on the server. For an agent conversation the
 * cached inventory updates immediately (see {@link markInventoryRead}) and
 * is restored if the server refuses; every read-state query refetches after.
 */
export function useMarkReadMutation(
  options?: MutationOptions<
    ReadMarkerState,
    { target: ReadMarkerTarget; version: number }
  >,
) {
  const client = useQueryClient();
  const inventoryKey = conversationQueries.inventory().queryKey;
  return useMutation<
    ReadMarkerState,
    Error,
    { target: ReadMarkerTarget; version: number },
    InventorySnapshot | undefined
  >({
    mutationFn: async ({ target, version }) =>
      markRead(await _getApiBase(), target, version),
    onMutate: ({ target, version }) =>
      target.kind === 'agent-conversation'
        ? markInventoryRead(client, target.conversationId, version)
        : undefined,
    onError: (error, variables, snapshot) => {
      restoreInventory(client, snapshot);
      options?.onError?.(error, variables);
    },
    onSuccess: (data, variables) => {
      options?.onSuccess?.(data, variables);
    },
    onSettled: () => {
      void client.invalidateQueries({ queryKey: inventoryKey });
      void client.invalidateQueries({ queryKey: readMarkerQueries.all() });
    },
  });
}
