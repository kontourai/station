import type {
  UnifiedSearchRequest,
  UnifiedSearchResponse,
} from '@kontourai/station-contracts/unified-search';
import { useQueryClient } from '@tanstack/react-query';
import {
  type ApiRequestScope,
  isApiRequestScope,
  type QueryConfig,
  useApiQuery,
} from './query-core';

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
      // Query identity alone is insufficient: cancellation can start another
      // fetch on the same Query. Its public promise identifies this retryer.
      const ownedQuery = client.getQueryCache().find({ queryKey, exact: true });
      const ownedRequest = ownedQuery?.promise;
      try {
        // Root hooks share the existing lazy client entry instead of making
        // the search client a second shared chunk on the cold-load graph.
        // Capture caller intent/authority before that import can yield.
        const requestScope = {
          apiBase: scope.apiBase,
          authorityKey: scope.authorityKey,
        };
        const capturedRequest: UnifiedSearchRequest = structuredClone(request);
        const { searchStation } = await import('./client/index');
        if (signal?.aborted) throw new Error('Search request cancelled');
        return await searchStation(requestScope.apiBase, capturedRequest, {
          requestScope,
          signal,
        });
      } catch (error) {
        if (
          ownedRequest &&
          ownedQuery?.promise === ownedRequest &&
          client.getQueryCache().find({ queryKey, exact: true }) === ownedQuery
        ) {
          ownedQuery.setState({ data: undefined });
        }
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
