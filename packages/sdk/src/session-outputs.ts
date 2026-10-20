import type { SessionOutputInspection } from '@kontourai/station-contracts/session-outputs';
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
