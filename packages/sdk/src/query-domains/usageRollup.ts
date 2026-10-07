import { _getApiBase } from '../api';
import {
  fetchUsageRollup as fetchUsageRollupAt,
  type UsageRollupQuery,
  type UsageRollupResponse,
} from '../client/analytics';
import { type ClientRequestOptions, StationHttpError } from '../client/http';
import { type QueryConfig, useApiQuery } from '../query-core';

export type {
  UsageRollupQuery,
  UsageRollupResponse,
} from '../client/analytics';

export async function fetchUsageRollup(
  query: UsageRollupQuery,
  options?: ClientRequestOptions,
): Promise<NonNullable<UsageRollupResponse['data']>> {
  const apiBase = options?.requestScope?.apiBase ?? (await _getApiBase());
  const result = await fetchUsageRollupAt(apiBase, query, options);
  if (!result.success) {
    throw new Error('Failed to fetch usage rollup');
  }
  if (!result.data) throw new Error('Usage rollup returned no data');
  return result.data;
}

export function useUsageRollupQuery(
  query: UsageRollupQuery,
  config?: QueryConfig<NonNullable<UsageRollupResponse['data']>> & {
    requestScope?: ClientRequestOptions['requestScope'];
    requireRequestScope?: boolean;
  },
) {
  const scope = config?.requestScope;
  return useApiQuery(
    [
      'analytics',
      'usage-rollup',
      scope?.apiBase ??
        (config?.requireRequestScope ? 'scope-unavailable' : 'default'),
      scope?.authorityKey ??
        (config?.requireRequestScope ? 'scope-unavailable' : 'default'),
      query.days,
      query.provider ?? '',
      JSON.stringify(
        query.credentialProfileRef === undefined
          ? ['all']
          : ['profile', query.credentialProfileRef],
      ),
      query.localOnly ? 1 : 0,
      query.groupBy ?? 'provider',
      query.cursor ?? '',
      query.pageSize ?? 50,
    ],
    (signal) => fetchUsageRollup(query, { requestScope: scope, signal }),
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
      enabled:
        (config?.enabled ?? true) && (!config?.requireRequestScope || !!scope),
      keepPreviousData: false,
    },
  );
}
