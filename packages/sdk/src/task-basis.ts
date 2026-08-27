import { hashKey, useQueryClient } from '@tanstack/react-query';
import { useCallback, useMemo } from 'react';
import {
  getTaskBasis,
  parseStationTaskBasisCollection,
  parseTaskBasisProjection,
  parseTaskBasisResult,
  type StationBasisResult,
  type StationTaskBasisCollection,
  TaskBasisRequestError,
} from './client/task-basis';
import {
  type ApiRequestScope,
  isApiRequestScope,
  type QueryConfig,
  resolveApiBase,
  useApiQuery,
} from './query-core';

export type { StationBasisProjection as BasisProjection } from '@kontourai/station-contracts/task-basis';
export type { StationBasisResult, StationTaskBasisCollection };
export {
  getTaskBasis,
  parseStationTaskBasisCollection,
  parseTaskBasisProjection,
  parseTaskBasisResult,
  TaskBasisRequestError,
};

export const taskBasisQueries = {
  task: (
    taskId: string,
    answerReferenceId?: string,
    requestScope?: ApiRequestScope,
  ) =>
    requestScope
      ? [
          'task-basis',
          taskId,
          requestScope.apiBase,
          requestScope.authorityKey,
          answerReferenceId ?? 'whole-task',
        ]
      : ['task-basis', taskId, answerReferenceId ?? 'whole-task'],
  scope: (taskId: string, requestScope?: ApiRequestScope) =>
    requestScope
      ? ['task-basis', taskId, requestScope.apiBase, requestScope.authorityKey]
      : ['task-basis', taskId],
};

export type BasisQueryConfig<T> = QueryConfig<T> & {
  /** Captured host authority; new native Basis callers must provide it. */
  requestScope?: ApiRequestScope;
};

function lostAuthority(error: unknown): error is TaskBasisRequestError {
  return error instanceof TaskBasisRequestError;
}

/** Task-scoped cache keys never share a selected-answer result with Whole Task. */
export function useTaskBasisQuery(
  taskId: string,
  options: {
    answerReferenceId?: string;
    config?: BasisQueryConfig<StationBasisResult>;
  } = {},
) {
  const client = useQueryClient();
  const key = useMemo(
    () =>
      taskBasisQueries.task(
        taskId,
        options.answerReferenceId,
        options.config?.requestScope,
      ),
    [taskId, options.answerReferenceId, options.config?.requestScope],
  );
  const revoke = useCallback(() => {
    const family = taskBasisQueries.scope(taskId, options.config?.requestScope);
    // Publish a non-sensitive tombstone synchronously to every scoped sibling.
    // Do not cancel/remove the currently settling query: doing so resets its
    // observer to pending forever and turns a completed 403 into an infinite
    // loading surface. Its terminal error is safe and gives the pane a bounded
    // unavailable/retry state; the tombstone still prevents any old payload.
    const siblings = {
      queryKey: family,
      predicate: (candidate: { queryHash: string }) =>
        candidate.queryHash !== hashKey(key),
    };
    void client.cancelQueries(siblings, { revert: false });
    client.setQueriesData({ queryKey: family }, null);
  }, [client, key, options.config?.requestScope, taskId]);
  const query = useApiQuery(
    key,
    async (signal) => {
      try {
        const apiBase = isApiRequestScope(options.config?.requestScope)
          ? options.config.requestScope.apiBase
          : await resolveApiBase();
        const result = await getTaskBasis(apiBase, taskId, {
          answerReferenceId: options.answerReferenceId,
          request: { signal, requestScope: options.config?.requestScope },
        });
        return result;
      } catch (error) {
        if (signal?.aborted) throw error;
        if (lostAuthority(error)) {
          revoke();
        }
        throw error;
      }
    },
    {
      staleTime: options.config?.staleTime ?? 10_000,
      gcTime: options.config?.gcTime,
      enabled: options.config?.enabled ?? taskId.length > 0,
      refetchOnMount: options.config?.refetchOnMount ?? 'always',
      retry: false,
      cancelWhenInactive: options.config?.cancelWhenInactive ?? true,
    },
  );
  return {
    ...query,
    data:
      query.isFetchedAfterMount &&
      query.status === 'success' &&
      !query.isFetching &&
      query.data
        ? query.data
        : undefined,
  };
}
