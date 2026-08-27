import type {
  SessionOutputInspection,
  SessionOutputsPage,
} from '@kontourai/station-contracts/session-outputs';
import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useMemo } from 'react';
import {
  inspectSessionOutput,
  listSessionOutputs,
  SessionOutputsRequestError,
} from './client/session-outputs';
import {
  type ApiRequestScope,
  isApiRequestScope,
  type QueryConfig,
  resolveApiBase,
  useApiQuery,
} from './query-core';

export { inspectSessionOutput, listSessionOutputs, SessionOutputsRequestError };
export const sessionOutputsQueries = {
  list: (sessionId: string, requestScope?: ApiRequestScope) => ({
    queryKey: requestScope
      ? [
          'session-outputs',
          sessionId,
          requestScope.apiBase,
          requestScope.authorityKey,
        ]
      : ['session-outputs', sessionId],
    staleTime: 10_000,
  }),
};
export function useSessionOutputsQuery(
  sessionId: string,
  config?: QueryConfig<SessionOutputsPage> & { requestScope?: ApiRequestScope },
) {
  const client = useQueryClient(),
    entry = useMemo(
      () => sessionOutputsQueries.list(sessionId, config?.requestScope),
      [sessionId, config?.requestScope],
    );
  const revoke = useCallback(
    () =>
      client
        .getQueryCache()
        .find({ queryKey: entry.queryKey, exact: true })
        ?.setState({ data: null }),
    [client, entry.queryKey],
  );
  const query = useApiQuery(
    entry.queryKey,
    async (signal) => {
      try {
        return await listSessionOutputs(
          isApiRequestScope(config?.requestScope)
            ? config.requestScope.apiBase
            : await resolveApiBase(),
          sessionId,
          { signal, requestScope: config?.requestScope },
        );
      } catch (error) {
        if (!signal?.aborted && error instanceof SessionOutputsRequestError)
          revoke();
        throw error;
      }
    },
    {
      staleTime: config?.staleTime ?? entry.staleTime,
      enabled: config?.enabled ?? sessionId.length > 0,
      refetchOnMount: config?.refetchOnMount ?? 'always',
      retry: false,
      cancelWhenInactive: config?.cancelWhenInactive ?? true,
    },
  );
  return {
    ...query,
    data:
      query.isFetchedAfterMount &&
      query.status === 'success' &&
      !query.isFetching
        ? query.data
        : undefined,
  };
}
/** Inspection is deliberately a point query and never shares its body with list/inventory caches. */
export function useSessionOutputInspection(
  sessionId: string,
  eventId: string,
  config?: QueryConfig<SessionOutputInspection> & {
    requestScope?: ApiRequestScope;
  },
) {
  const client = useQueryClient();
  const queryKey = useMemo(
    () => [
      'session-output-inspection',
      sessionId,
      eventId,
      config?.requestScope?.apiBase ?? '',
      config?.requestScope?.authorityKey ?? '',
    ],
    [sessionId, eventId, config?.requestScope],
  );
  const revoke = useCallback(
    () => client.removeQueries({ queryKey, exact: true }),
    [client, queryKey],
  );
  useEffect(() => revoke, [revoke]);
  const query = useApiQuery(
    queryKey,
    async (signal) => {
      try {
        return await inspectSessionOutput(
          isApiRequestScope(config?.requestScope)
            ? config.requestScope.apiBase
            : await resolveApiBase(),
          sessionId,
          eventId,
          { signal, requestScope: config?.requestScope },
        );
      } catch (error) {
        if (!signal?.aborted) revoke();
        throw error;
      }
    },
    {
      enabled: config?.enabled ?? false,
      retry: false,
      cancelWhenInactive: true,
    },
  );
  return {
    ...query,
    data:
      query.isFetchedAfterMount &&
      query.status === 'success' &&
      !query.isFetching
        ? query.data
        : undefined,
  };
}
