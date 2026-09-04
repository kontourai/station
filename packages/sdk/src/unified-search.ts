import type {
  UnifiedSearchRequest,
  UnifiedSearchResponse,
} from '@kontourai/station-contracts/unified-search';
import { useQueryClient } from '@tanstack/react-query';
import { searchStation } from './client/unified-search';
import {
  type ApiRequestScope,
  isApiRequestScope,
  type QueryConfig,
  useApiQuery,
} from './query-core';

export {
  resolveSearchOpen,
  searchStation,
  UnifiedSearchRequestError,
} from './client/unified-search';

export const unifiedSearchQueries = {
  search(request: UnifiedSearchRequest, scope: ApiRequestScope) {
    return {
      queryKey: ['unified-search', scope.apiBase, scope.authorityKey, request],
      staleTime: 0,
    };
  },
};
/** No ambient destination/cache. A scope-less caller gets a disabled, empty projection. */
export function useUnifiedSearchQuery(
  request: UnifiedSearchRequest,
  config?: QueryConfig<UnifiedSearchResponse> & {
    requestScope?: ApiRequestScope;
  },
) {
  const scope = config?.requestScope;
  const valid = isApiRequestScope(scope);
  const client = useQueryClient();
  const queryKey = valid
    ? unifiedSearchQueries.search(request, scope).queryKey
    : ['unified-search-unbound'];
  const query = useApiQuery<UnifiedSearchResponse>(
    queryKey,
    async (signal) => {
      if (!isApiRequestScope(scope))
        throw new Error('Search authority unavailable');
      try {
        return await searchStation(scope.apiBase, request, {
          requestScope: scope,
          signal,
        });
      } catch (error) {
        client
          .getQueryCache()
          .find({ queryKey, exact: true })
          ?.setState({ data: undefined });
        throw error;
      }
    },
    {
      ...config,
      enabled: valid && (config?.enabled ?? true),
      staleTime: 0,
      retry: false,
      refetchOnMount: 'always',
      cancelWhenInactive: true,
      keepPreviousData: false,
    },
  );
  return {
    ...query,
    data:
      valid &&
      query.isFetchedAfterMount &&
      query.status === 'success' &&
      !query.isFetching
        ? query.data
        : undefined,
  };
}
