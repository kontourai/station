import type {
  SessionInventoryGroupId,
  SessionInventoryScope,
} from '@kontourai/station-contracts/session-inventory';
import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useMemo } from 'react';
import {
  getSessionInventory,
  getSessionInventoryGroupPage,
  SessionInventoryRequestError,
} from './client/session-inventory';
import {
  type ApiRequestScope,
  isApiRequestScope,
  type QueryConfig,
  resolveApiBase,
  useApiQuery,
} from './query-core';

export {
  getSessionInventory,
  getSessionInventoryGroupPage,
  SessionInventoryRequestError,
};
export const sessionInventoryQueries = {
  projection: (
    scope: SessionInventoryScope,
    requestScope?: ApiRequestScope,
  ) => ({
    queryKey: requestScope
      ? [
          'session-inventory',
          scope,
          requestScope.apiBase,
          requestScope.authorityKey,
        ]
      : ['session-inventory', scope],
    staleTime: 10_000,
  }),
  page: (
    scope: SessionInventoryScope,
    groupId: SessionInventoryGroupId,
    continuation: string | undefined,
    requestScope?: ApiRequestScope,
  ) => ({
    queryKey: requestScope
      ? [
          'session-inventory-page',
          scope,
          groupId,
          continuation ?? '',
          requestScope.apiBase,
          requestScope.authorityKey,
        ]
      : ['session-inventory-page', scope, groupId, continuation ?? ''],
    staleTime: 10_000,
  }),
};
type ProtectedConfig<T> = QueryConfig<T> & { requestScope?: ApiRequestScope };
function sameScope(left: SessionInventoryScope, right: SessionInventoryScope) {
  return JSON.stringify(left) === JSON.stringify(right);
}
export function clearSessionInventoryCache(
  client: ReturnType<typeof useQueryClient>,
  scope: SessionInventoryScope,
  requestScope?: ApiRequestScope,
) {
  client.removeQueries({
    predicate: (query) => {
      const key = query.queryKey;
      if (!Array.isArray(key)) return false;
      if (key[0] !== 'session-inventory' && key[0] !== 'session-inventory-page')
        return false;
      if (!sameScope(key[1] as SessionInventoryScope, scope)) return false;
      if (!requestScope) return true;
      const offset = key[0] === 'session-inventory' ? 2 : 4;
      return (
        key[offset] === requestScope.apiBase &&
        key[offset + 1] === requestScope.authorityKey
      );
    },
  });
}
function useProtected<T>(
  queryKey: (string | number | object)[],
  fetcher: (signal?: AbortSignal) => Promise<T>,
  config?: ProtectedConfig<T>,
  onRevoke?: () => void,
) {
  const client = useQueryClient();
  const revoke = useCallback(() => {
    client
      .getQueryCache()
      .find({ queryKey, exact: true })
      ?.setState({ data: null });
  }, [client, queryKey]);
  const query = useApiQuery(
    queryKey,
    async (signal) => {
      try {
        return await fetcher(signal);
      } catch (error) {
        if (!signal?.aborted && error instanceof SessionInventoryRequestError)
          (onRevoke ?? revoke)();
        throw error;
      }
    },
    {
      staleTime: config?.staleTime ?? 10_000,
      gcTime: config?.gcTime,
      enabled: config?.enabled ?? true,
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
        ? (query.data ?? undefined)
        : undefined,
    isLoading:
      !query.isFetchedAfterMount || query.isLoading || query.isFetching,
  };
}
export function useSessionInventoryQuery(
  scope: SessionInventoryScope,
  config?: ProtectedConfig<Awaited<ReturnType<typeof getSessionInventory>>>,
) {
  const client = useQueryClient();
  const entry = useMemo(
    () => sessionInventoryQueries.projection(scope, config?.requestScope),
    [scope, config?.requestScope],
  );
  return useProtected(
    entry.queryKey,
    async (signal) =>
      getSessionInventory(
        isApiRequestScope(config?.requestScope)
          ? config.requestScope.apiBase
          : await resolveApiBase(),
        scope,
        { signal, requestScope: config?.requestScope },
      ),
    { ...config, enabled: config?.enabled ?? scope.sessionId.length > 0 },
    () => clearSessionInventoryCache(client, scope, config?.requestScope),
  );
}
export function useSessionInventoryGroupPage(
  scope: SessionInventoryScope,
  groupId: SessionInventoryGroupId,
  continuation?: string,
  config?: ProtectedConfig<
    Awaited<ReturnType<typeof getSessionInventoryGroupPage>>
  >,
) {
  const entry = useMemo(
    () =>
      sessionInventoryQueries.page(
        scope,
        groupId,
        continuation,
        config?.requestScope,
      ),
    [scope, groupId, continuation, config?.requestScope],
  );
  const client = useQueryClient();
  return useProtected(
    entry.queryKey,
    async (signal) =>
      getSessionInventoryGroupPage(
        isApiRequestScope(config?.requestScope)
          ? config.requestScope.apiBase
          : await resolveApiBase(),
        scope,
        groupId,
        { signal, continuation, requestScope: config?.requestScope },
      ),
    { ...config, enabled: config?.enabled ?? scope.sessionId.length > 0 },
    () => clearSessionInventoryCache(client, scope, config?.requestScope),
  );
}
export function useInvalidateSessionInventory() {
  const client = useQueryClient();
  return useCallback(
    (sessionId?: string) =>
      client.invalidateQueries({
        predicate: (query) =>
          Array.isArray(query.queryKey) &&
          (query.queryKey[0] === 'session-inventory' ||
            query.queryKey[0] === 'session-inventory-page') &&
          (!sessionId || JSON.stringify(query.queryKey).includes(sessionId)),
      }),
    [client],
  );
}
