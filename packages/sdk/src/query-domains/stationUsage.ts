import { type ClientRequestOptions, StationHttpError } from '../client/http';
import {
  fetchStationUsage,
  type StationUsageOverview,
} from '../client/station-usage';
import { type QueryConfig, useApiQuery } from '../query-core';

export function useStationUsageQuery(
  scope: ClientRequestOptions['requestScope'],
  config?: QueryConfig<StationUsageOverview>,
) {
  return useApiQuery(
    [
      'analytics',
      'station-usage',
      scope?.apiBase ?? 'scope-unavailable',
      scope?.authorityKey ?? 'scope-unavailable',
    ],
    (signal) => {
      if (!scope) throw new Error('Station request authority unavailable');
      return fetchStationUsage(scope.apiBase, {
        requestScope: scope,
        signal,
      });
    },
    {
      staleTime: 30_000,
      refetchInterval: 30_000,
      refetchOnMount: true,
      refetchOnWindowFocus: true,
      refetchIntervalForError: (error) =>
        error instanceof StationHttpError && [401, 403].includes(error.status)
          ? false
          : undefined,
      retry: false,
      ...config,
      enabled: !!scope && (config?.enabled ?? true),
      keepPreviousData: false,
    },
  );
}
