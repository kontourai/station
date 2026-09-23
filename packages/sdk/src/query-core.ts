import {
  hashKey,
  keepPreviousData,
  type Query,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
import { useCallback, useEffect } from 'react';
import { _getApiBase } from './api';

/**
 * gcTime floor for query keys that station-ui persists to IndexedDB for
 * cache-first offline reads (station#1223 — see src-ui/src/lib/queryPersistence.ts,
 * which imports this same constant and registers it via
 * `queryClient.setQueryDefaults(prefix, { gcTime: PERSISTED_QUERY_GC_TIME_MS })`
 * for every whitelisted queryKey prefix).
 *
 * React Query only ever restores a query that is STILL resident in the live
 * QueryCache at save time — the persister re-dehydrates the whole cache on
 * every cache event, including the `removed` event a query fires once its
 * own `gcTime` elapses with no observers. A query garbage-collected before a
 * save/reload silently drops out of the persisted snapshot even though it's
 * well within the persister's `maxAge`. React Query's own guidance: a
 * persisted query's `gcTime` must be >= the persister's `maxAge`, or it can
 * be collected before it would ever be restored.
 *
 * `useApiQuery` below reads `queryClient.getQueryDefaults(queryKey)` before
 * using its own 10-minute default specifically so that per-key
 * default can win — react-query's own option merge (`{...clientDefaults,
 * ...queryKeyDefaults, ...explicitOptions}`) otherwise lets ANY explicit
 * `gcTime` an individual hook passes (including a hardcoded default like
 * this file's own) silently outrank `setQueryDefaults`. A handful of other
 * whitelisted hooks (`useConversationsQuery`, `useSystemStatusQuery`,
 * `useSystemStatusForApiBaseQuery`) don't go through `useApiQuery` and set
 * this constant directly for the same reason — grep this constant's name to
 * find all of them.
 */
export const PERSISTED_QUERY_GC_TIME_MS = 24 * 60 * 60 * 1000;

/**
 * `refetchOnMount` policy for catalog reads whose contents change OUTSIDE this
 * client — a plugin installed from the CLI, another tab or device, an agent.
 *
 * Station's client default is `refetchOnMount: false`, and TanStack applies it
 * even to an invalidated query. So `invalidateQueries` reaches only a query
 * observed at that moment: a plugin lifecycle event, an in-tab install, or the
 * reconnect sync that lands while the catalog is unmounted marks it
 * invalidated, and the next mount then serves the old answer anyway, with
 * nothing left to refetch it.
 *
 * Returning `true` for an invalidated query means "refetch if stale", and an
 * invalidated query is always stale. An untouched cached answer keeps the
 * cache-first default, so remounts do not refetch and an offline reload still
 * paints from the persisted snapshot without an error.
 */
export function refetchOnMountWhenInvalidated(
  query: Query<any, any, any, any>,
): boolean {
  return query.state.isInvalidated;
}

export interface QueryConfig<_T> {
  staleTime?: number;
  gcTime?: number;
  enabled?: boolean;
  /**
   * Explicitly reauthorize a protected read when its observer remounts.
   * Most Station reads may use the app's cache-first default; capability-like
   * answer references may not survive an authority change in that cache.
   */
  refetchOnMount?:
    | boolean
    | 'always'
    | ((query: Query<any, any, any, any>) => boolean | 'always');
  /** Polling interval in ms. Station globally disables refetch-on-focus and
   * refetch-on-mount, so for data that can change outside this client's own
   * mutations, polling is the only refresh path — pass this explicitly. */
  refetchInterval?: number;
  retry?: boolean | number | ((failureCount: number, error: Error) => boolean);
  retryDelay?: number | ((attemptIndex: number, error: Error) => number);
  /** Cancel an in-flight request or scheduled retry when the final enabled
   * observer becomes inactive. Intended for modal and popover data. */
  cancelWhenInactive?: boolean;
  /**
   * Hold the previous key's successful result (as `placeholderData`) while a
   * key change is refetching, instead of dropping straight to the no-data
   * loading state (station#3092). This is opt-in per query/hook, never a
   * client-wide default: TanStack's `isPlaceholderData` flips to `true` for
   * exactly the held render, so a consumer that turns this on MUST branch on
   * `isPlaceholderData` to visibly mark the render as refreshing (dim it,
   * add an `aria-busy`/"Updating…" affordance) — holding data honestly means
   * the reader can never mistake it for a fresh answer to the new key. A
   * hook that sets this without the consuming component marking
   * `isPlaceholderData` is a defect, not a valid use.
   */
  keepPreviousData?: boolean;
}

/**
 * Opaque caller authority partition for protected query caches. Hosts derive
 * `authorityKey` from public connection state only; credentials never become
 * part of a React Query key.
 */
export {
  type ApiRequestScope,
  isApiRequestScope,
} from './client/http';

const activeCancelableQueries = new WeakMap<
  ReturnType<typeof useQueryClient>,
  Map<string, number>
>();

export function useCancelWhenInactive(
  queryKey: (string | number | object | null)[],
  enabled: boolean,
  cancelWhenInactive: boolean | undefined,
): void {
  const queryClient = useQueryClient();
  const queryHash = hashKey(queryKey);
  useEffect(() => {
    if (!cancelWhenInactive || !enabled) return;
    const counts = activeCancelableQueries.get(queryClient) ?? new Map();
    activeCancelableQueries.set(queryClient, counts);
    counts.set(queryHash, (counts.get(queryHash) ?? 0) + 1);
    return () => {
      const remaining = Math.max(0, (counts.get(queryHash) ?? 1) - 1);
      if (remaining > 0) {
        counts.set(queryHash, remaining);
        return;
      }
      counts.delete(queryHash);
      void queryClient.cancelQueries({
        predicate: (candidate) => candidate.queryHash === queryHash,
      });
    };
  }, [cancelWhenInactive, enabled, queryClient, queryHash]);
}

export interface MutationOptions<TData, TVariables = unknown> {
  onSuccess?: (data: TData, variables: TVariables) => void;
  onError?: (error: Error, variables: TVariables) => void;
}

export async function resolveApiBase(apiBase?: string): Promise<string> {
  return apiBase || (await _getApiBase());
}

export function useApiQuery<T = any>(
  // `null` is a member because an OPTIONAL key segment has to have a spelling
  // that is distinct from "no segment": `['config','provenance', slug ?? null]`
  // and `['config','provenance']` would otherwise be the same cache entry, and
  // the scoped read's answer would be served for the unscoped one. React Query
  // serializes `null` in a key like any other JSON value, and the raw
  // `useQuery` callers in this package (`developerRuntime.ts`) already do this.
  queryKey: (string | number | object | null)[],
  queryFn: (signal?: AbortSignal) => Promise<T>,
  config?: QueryConfig<T>,
) {
  const queryClient = useQueryClient();
  const enabled = config?.enabled ?? true;
  const query = useQuery({
    queryKey,
    queryFn: ({ signal }) => queryFn(signal),
    staleTime: config?.staleTime ?? 5 * 60 * 1000,
    gcTime:
      config?.gcTime ??
      queryClient.getQueryDefaults(queryKey)?.gcTime ??
      10 * 60 * 1000,
    enabled,
    ...(config?.refetchOnMount === undefined
      ? {}
      : { refetchOnMount: config.refetchOnMount }),
    refetchInterval: config?.refetchInterval,
    retry: config?.retry,
    retryDelay: config?.retryDelay,
    placeholderData: config?.keepPreviousData ? keepPreviousData : undefined,
  });

  useCancelWhenInactive(queryKey, enabled, config?.cancelWhenInactive);

  return query;
}

export function useApiMutation<TData = any, TVariables = any>(
  mutationFn: (variables: TVariables) => Promise<TData>,
  options?: {
    onSuccess?: (data: TData, variables: TVariables) => void;
    onError?: (error: Error, variables: TVariables) => void;
    invalidateKeys?: (string | number)[][];
    /**
     * Set for mutations whose variables can carry write-only credentials.
     * Zero retention makes TanStack evict a settled unobserved mutation even
     * when its component unmounted before observer callbacks could scrub it.
     * Opt-in rather than the default: this helper backs ~38 call sites, and a
     * global retention change to solve one surface's secret problem is a
     * blast radius nobody asked for.
     */
    evictSettledVariables?: boolean;
  },
) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn,
    ...(options?.evictSettledVariables ? { gcTime: 0 } : {}),
    onSuccess: (data, variables) => {
      try {
        options?.onSuccess?.(data, variables);
      } finally {
        options?.invalidateKeys?.forEach((key) => {
          queryClient.invalidateQueries({ queryKey: key });
        });
      }
    },
    onError: (error, variables) => {
      options?.onError?.(error as Error, variables);
    },
  });
}

export function useInvalidateQuery() {
  const queryClient = useQueryClient();
  // station#3796: this is a dependency of consumers' `useCallback`s (and,
  // through them, of context values), so a fresh arrow per render made every
  // memo downstream inert. The client is context-stable, so the identity is.
  // Returns the invalidation's own promise rather than discarding it, so a
  // caller that must not act until the refetch has settled can await it
  // (#2144 slice 3: clearing an override draft before its project record is
  // re-read flashes the pre-save value). Every existing caller ignores the
  // result and is unaffected.
  return useCallback(
    (queryKey: (string | number | object)[]): Promise<void> =>
      queryClient.invalidateQueries({ queryKey }),
    [queryClient],
  );
}
