import type {
  SessionInventoryScope,
  SessionInventoryV2GroupId,
} from '@kontourai/station-contracts/session-inventory';
import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useMemo, useRef } from 'react';
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
 * the authentication layer. A 503, a network failure (status 0) or a
 * projection the contract refuses (the response's own status, usually 200) is
 * an ordinary failed read: what was already
 * authorized stays, and the surface reports the failure.
 *
 * This deliberately differs from `useAnswerBasisQuery`, which revokes on any
 * `AnswerBasisRequestError`. The inventory route keeps 503 for a read it could
 * not perform, so treating 503 as revocation would erase authorized content
 * over an outage, and (before tombstoning) made the read loop. Aligning
 * answer-basis with this rule is a separate change.
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
      // Not the caller's choice: data is released only after a read made
      // during this mount succeeds (below), so a mount that skipped its read
      // because the cache was fresh would load forever.
      refetchOnMount: 'always',
      retry: false,
      cancelWhenInactive: config?.cancelWhenInactive ?? true,
    },
  );
  // Nothing cached before this mount is shown until a read made during this
  // mount SUCCEEDS. `isFetchedAfterMount` alone is not enough: it is also true
  // after a failed read, which would release data an earlier mount was
  // authorized to see. So the first render that observes a success after
  // mount (for this key) latches it, and only a latched key releases data.
  // The latch is by observation, not by time: a success that lands at the same
  // `dataUpdatedAt` as the entry cached before the mount (a frozen or coarse
  // clock) still counts. After it, a background refetch keeps what is on
  // screen: lost authority tombstones it (`null`, above), and a merely failed
  // refresh leaves it beside `error`, for the surface to mark as not refreshed.
  const queryHash = JSON.stringify(queryKey);
  // A key switch, and becoming enabled, are each a new mount for this rule,
  // but TanStack fetches on either only when the cached entry is stale. So the
  // hook remembers which key it has read while enabled, and reads whenever it
  // is enabled on a key it has not (unless that already started a fetch). The
  // first enabled render's read is TanStack's own `refetchOnMount`.
  const enabled = config?.enabled ?? true;
  const readKey = useRef<string | null>(enabled ? queryHash : null);
  useEffect(() => {
    if (!enabled) {
      readKey.current = null;
      return;
    }
    if (readKey.current === queryHash) return;
    readKey.current = queryHash;
    const cached = client.getQueryCache().find({ queryKey, exact: true });
    if (cached?.state.fetchStatus !== 'fetching') void query.refetch();
  }, [client, enabled, query, queryHash, queryKey]);
  const succeededFor = useRef<string | null>(null);
  if (
    succeededFor.current !== queryHash &&
    query.isFetchedAfterMount &&
    query.status === 'success' &&
    query.data != null
  )
    succeededFor.current = queryHash;
  const data =
    succeededFor.current === queryHash && query.data != null
      ? query.data
      : undefined;
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
