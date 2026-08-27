import type {
  ActionOperationPage,
  ActionOperationWatchSnapshot,
} from '@kontourai/station-contracts/action-operation';
import { _getApiBase } from '../api';
import {
  cancelActionOperation,
  fetchActionOperations,
  watchActionOperations,
} from '../client/action-operations.js';
import { useApiMutation, useApiQuery } from '../query-core';

/** Reconnect-safe snapshots are polled; no client invents a local operation row. */
export function useActionOperationsQuery() {
  return useApiQuery<ActionOperationPage>(
    ['action-operations'],
    async () => fetchActionOperations(await _getApiBase()),
    { staleTime: 5_000, refetchInterval: 5_000 },
  );
}

export function useActionOperationsWatchQuery(cursor?: string) {
  return useApiQuery<ActionOperationWatchSnapshot>(
    ['action-operations', 'watch', cursor ?? 'snapshot'],
    async () => watchActionOperations(await _getApiBase(), cursor),
    { staleTime: 5_000, refetchInterval: 5_000 },
  );
}

export function useCancelActionOperationMutation() {
  return useApiMutation(
    async (id: string) => cancelActionOperation(await _getApiBase(), id),
    { invalidateKeys: [['action-operations']] },
  );
}
