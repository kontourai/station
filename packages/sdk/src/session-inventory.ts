import type {
  SessionInventoryScope,
  SessionInventoryV2GroupId,
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
    groupId: SessionInventoryV2GroupId,
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
/**
 * Tombstones (sets to `null`) every cached projection and page for `scope`
 * under `requestScope`'s authority. It never removes an entry: removing a
 * query a mounted observer still holds makes that observer re-create and
 * refetch it, and a read that keeps being refused then loops forever.
 */
export function clearSessionInventoryCache(
  client: ReturnType<typeof useQueryClient>,
  scope: SessionInventoryScope,
  requestScope?: ApiRequestScope,
) {
  const matching = client.getQueryCache().findAll({
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
  for (const query of matching) query.setState({ data: null });
}
/**
 * Only a refusal that means this principal may not (or may no longer) read the
 * Session revokes what it already holds. The route answers a denied, missing
 * or stale-principal read alike (404, non-disclosing); 401 and 403 come from
 * the authentication layer. A 503, a network failure or a projection the
 * contract refuses (status 0) is an ordinary failed read: what was already
 * authorized stays, and the surface reports the failure.
 */
function lostAuthority(error: unknown): boolean {
  return (
    error instanceof SessionInventoryRequestError &&
    (error.status === 401 || error.status === 403 || error.status === 404)
  );
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
        if (!signal?.aborted && lostAuthority(error)) (onRevoke ?? revoke)();
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
  // Nothing cached before this mount is shown until this mount's own read
  // settles. After that, a background refetch keeps what is on screen: a
  // refused one tombstones it (`null`, above), and a merely failed one leaves
  // it beside `error`, for the surface to mark as not refreshed.
  const data =
    query.isFetchedAfterMount && query.data != null ? query.data : undefined;
  return {
    ...query,
    data,
    isLoading:
      !query.isFetchedAfterMount ||
      ((query.isLoading || query.isFetching) && data === undefined),
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
  groupId: SessionInventoryV2GroupId,
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
