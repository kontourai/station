/**
 * archive#1223 (offline) — cache-first reads.
 *
 * Persists the react-query cache to IndexedDB so the app shell and the
 * last-loaded read data (agents, conversations, projects, runs, config,
 * system status) render instantly on reload while offline or against a
 * briefly-unreachable server, instead of a blank shell. Fresh data still
 * wins the moment the server is reachable — see `useQueryCacheReconnectSync`.
 *
 * Production wiring lives in `main.tsx`: the app renders inside
* `<PersistQueryClientProvider persistOptions={buildPersistOptions}>`
 * rather than a plain `<QueryClientProvider>` — see `buildPersistOptions`'s
* doc comment for why a bare `persistQueryClient` call isn't enough.
 *
 * SAFETY (non-negotiable, archive#1223):
*  - Default-deny whitelist by queryKey prefix (`PERSISTED_QUERY_KEY_PREFIXES`).
*    Nothing persists unless it is explicitly listed here.
* - Never persists mutations (`shouldDehydrateMutation: => false`) — the
*    outbound queue is a separate, not-yet-built slice (archive#1224).
*  - Never persists errored or pending queries (only `status === 'success'`).
*  - IndexedDB (async) rather than localStorage (sync): the whitelisted cache
*    can exceed localStorage's ~5MB quota, and synchronous writes on every
*    cache update would jank the main thread. `idb-keyval` keeps this to a
*    handful of lines instead of hand-rolling IndexedDB boilerplate.
*  - A restore that throws (e.g. IndexedDB unavailable in Safari private
*    mode) degrades gracefully rather than crashing or hanging first paint —
*    see `buildPersistOptions`/`setupQueryPersistence`'s handling below.
 */
import { PERSISTED_QUERY_GC_TIME_MS } from '@kontourai/station-sdk';
import { createAsyncStoragePersister } from '@tanstack/query-async-storage-persister';
import type {
  DehydrateOptions,
  Query,
  QueryClient,
} from '@tanstack/react-query';
import {
  type AsyncStorage,
  type PersistQueryClientOptions,
  persistQueryClient,
} from '@tanstack/react-query-persist-client';
import { createStore, del, get, set } from 'idb-keyval';
import { buildInfo } from '../build-info';

/**
 * Default-deny whitelist: only queries whose queryKey's first segment is one
 * of these prefixes are ever written to disk. Everything else — including
 * anything not explicitly listed — is excluded by default.
 *
 * Included (safe, useful, and asked for by archive#1223):
*  - 'agents', 'agent', 'agent-tools' — agent list/detail/tools
*  - 'conversations' — conversation summaries (NOT `messages`, which holds
*    full message bodies; kept out of scope for this slice, see report)
*  - 'projects' — project list/detail, including the nested layouts/
*    icon-candidate queries under the same prefix (still shell metadata,
*    not file contents)
*  - 'runs' — scheduled run list/detail
*  - 'system-status' — server/system status (build info, capabilities).
*    Contains one deliberately-accepted inconsistency: `SystemStatus.acp`
*    (connection id + status strings, no secrets) is the same kind of
*    point-in-time connection state the `acp-connections`/`connections` keys
*    are excluded for elsewhere. It stays in because splitting it out of
*    `system-status` would need a per-query dehydrate transform (react-query's
*    `serializeData` is global, not per-key) for a field that already carries
*    no sensitive data — the reconnect-invalidation below and the 24h maxAge
*    both bound how stale it can be shown, same as the rest of this
*    whitelist. Revisit if `acp` ever grows a sensitive field.
*  - 'config' — app config (`/config/app`; UI-level settings, not secrets)
*  - 'model-catalog', 'model-picker-catalog' — model metadata and the deliberately
*    credential-free connection projection used by offline model pickers
 *
 * Deliberately excluded (sensitive or volatile — never persist):
*  - 'auth-status', 'connections' — auth/credential state
*  - 'orchestration-*', 'flow-run-console', 'flow-runs', 'flow-definitions',
*    'attention', 'scheduler', 'monitoring-*', 'core-update-check',
*    'acp-connections' — live/volatile, SSE-refreshed, or point-in-time
*    operational state that would be actively misleading if shown stale
*  - 'messages' — full conversation message bodies (large, can carry
*    pasted secrets/sensitive content; out of scope for this slice)
*  - 'knowledge', 'mcp-tool-ui*', 'git-*', 'ssh-environments',
*    'coding-repos', 'host-compatibility' — large blobs / file contents or
*    connection-specific probes, not "last-loaded shell data"
*  - 'plugins', 'plugin-updates', 'plugin-providers' — plugin registry
*    state; re-derives cheaply and can reflect only-just-installed,
*    machine-local state that shouldn't be replayed from an older cache
 */
export const PERSISTED_QUERY_KEY_PREFIXES = [
  'agents',
  'agent',
  'agent-tools',
  'conversations',
  'projects',
  'runs',
  'system-status',
  'config',
  'model-catalog',
  'model-picker-catalog',
] as const;

const PERSISTED_QUERY_KEY_PREFIX_SET: ReadonlySet<string> = new Set(
  PERSISTED_QUERY_KEY_PREFIXES,
);

/**
 * gcTime floor AND persister maxAge, intentionally the *same* imported
 * constant (`@kontourai/station-sdk`'s `PERSISTED_QUERY_GC_TIME_MS`) so the
 * two can never drift out of the relationship react-query's own docs
 * require: a persisted query's `gcTime` must be >= the persister's `maxAge`,
 * or the query can be garbage-collected from the live cache before a
 * save/reload ever restores it — the persister re-dehydrates the whole
 * *live* cache on every cache event (including `removed`), so anything
 * already GC'd silently drops out of the next persisted snapshot even
 * though it's well within `maxAge`. Station's app-wide default `gcTime` is a
 * much shorter 10 minutes (`main.tsx`) — see `applyPersistedQueryGcTimeDefaults`.
 */
export const QUERY_PERSISTENCE_MAX_AGE_MS = PERSISTED_QUERY_GC_TIME_MS;

const IDB_DATABASE_NAME = 'station-query-cache';
const IDB_STORE_NAME = 'cache';

/** Exported so tests can write/inspect the exact persisted blob (buster,
 * maxAge expiry) without depending on internal storage-key knowledge. */
export const QUERY_PERSISTENCE_STORAGE_KEY = 'station-query-cache-v1';

/**
 * Cache buster keyed to the running build (version + commit, from the same
 * index metadata identity Settings → Deployed Build shows). Any code
 * change — including a persisted-query shape change — ships as a new commit,
 * so this guarantees a persisted cache is never restored across an
 * incompatible build.
 */
export function queryPersistenceBuster(): string {
  return `${buildInfo.version}+${buildInfo.commit}`;
}

/**
 * Only a query whose first queryKey segment is explicitly whitelisted, and
 * which resolved successfully, is ever written to the persisted cache.
 * Exported for direct unit testing of the whitelist/exclusion behavior.
 */
export function shouldPersistQuery(
  query: Pick<Query, 'queryKey' | 'state'>,
): boolean {
  if (query.state.status !== 'success') return false;
  if (query.state.error != null) return false;
  const [prefix] = query.queryKey;
  return (
    typeof prefix === 'string' && PERSISTED_QUERY_KEY_PREFIX_SET.has(prefix)
  );
}

/**
 * Raises the effective `gcTime` for every whitelisted query key to
 * `QUERY_PERSISTENCE_MAX_AGE_MS`, regardless of Station's much shorter
 * app-wide default (10 minutes, `main.tsx`).
 *
 * This is NOT the same as raising the QueryClient's global default: several
 * of the SDK's own query hooks (`useApiQuery`, and a few raw `useQuery`
 * calls — grep `PERSISTED_QUERY_GC_TIME_MS` in `packages/sdk`) pass an
 * explicit `gcTime` value on every call (even a caller-omitted one resolves
 * to a concrete fallback), and react-query's option-merge order
* (`{...clientDefaults,...queryKeyDefaults,...explicitOptions}`) lets that
 * explicit value always outrank both the client's global default AND
 * `setQueryDefaults`. The SDK hooks that back this whitelist already read
 * `queryClient.getQueryDefaults(queryKey)` (via `useApiQuery`) or hardcode
 * this same constant directly, specifically so that registering it here
 * actually takes effect. Call this once, right after creating the
 * `QueryClient` and before anything renders — matches `main.tsx`.
 */
export function applyPersistedQueryGcTimeDefaults(
  queryClient: QueryClient,
): void {
  for (const prefix of PERSISTED_QUERY_KEY_PREFIXES) {
    queryClient.setQueryDefaults([prefix], {
      gcTime: QUERY_PERSISTENCE_MAX_AGE_MS,
    });
  }
}

/**
 * IndexedDB-backed storage for the persist-client package's `AsyncStorage`
 * contract. Falls back to a no-op storage when IndexedDB isn't available
 * (very old WebViews, some SSR/test contexts) so app boot never depends on
 * it — persistence is a progressive enhancement, not a requirement.
 */
export function createIdbQueryStorage(): AsyncStorage<string> {
  if (typeof indexedDB === 'undefined') {
    return {
      getItem: async () => undefined,
      setItem: async () => undefined,
      removeItem: async () => undefined,
    };
  }
  const store = createStore(IDB_DATABASE_NAME, IDB_STORE_NAME);
  return {
    getItem: (key) => get<string>(key, store),
    setItem: (key, value) => set(key, value, store),
    removeItem: (key) => del(key, store),
  };
}

export type QueryPersistOptions = Omit<
  PersistQueryClientOptions,
  'queryClient'
>;

/**
 * Builds the `persistOptions` prop for `<PersistQueryClientProvider>` (the
 * production path, wired in `main.tsx`) — persister, maxAge, buster, and the
 * whitelist/mutation-exclusion dehydrate rules, all in one place so the
 * provider and any lower-level/test use (`setupQueryPersistence` below)
 * can't drift apart.
 *
* `<PersistQueryClientProvider>` over a bare `persistQueryClient` call is
 * the fix for a real race: restoring from IndexedDB is async, so a query
* mounted on first render (e.g. `useQuery(['agents'],...)`) would otherwise
 * see an empty in-memory cache and fire its network fetch immediately,
 * racing the restore — `refetchOnMount: false` (station's global default)
 * only suppresses refetching data that's *already* in the cache, it does
 * nothing for a query that hasn't been hydrated yet. The provider tracks
 * `isRestoring` in context and every `useQuery` observer checks it
 * (`useBaseQuery`) to skip subscribing/fetching until restore settles, so a
 * component mounted mid-restore waits for the cache instead of firing a
 * fetch that's doomed to be redundant (or, offline, doomed to fail) the
 * instant the persisted data lands.
 */
export function buildPersistOptions(options?: {
  storage?: AsyncStorage<string>;
  throttleTime?: number;
}): QueryPersistOptions {
  const persister = createAsyncStoragePersister({
    storage: options?.storage ?? createIdbQueryStorage(),
    key: QUERY_PERSISTENCE_STORAGE_KEY,
// Coalesces bursts of cache writes into at most one disk write per
// second in production. Tests inject a near-zero value so simulated
// save/restore round trips don't have to wait on real wall-clock time.
    throttleTime: options?.throttleTime ?? 1000,
  });

  const dehydrateOptions: DehydrateOptions = {
    shouldDehydrateQuery: shouldPersistQuery,
// Never persist mutations in this slice — the outbound queue is
// archive#1224. Explicit rather than relying on the (isPaused-only)
// default, so a future paused-mutation-while-offline path elsewhere in
// the client can never leak into this persister by accident.
    shouldDehydrateMutation: () => false,
  };

  return {
    persister,
    maxAge: QUERY_PERSISTENCE_MAX_AGE_MS,
    buster: queryPersistenceBuster(),
    dehydrateOptions,
  };
}

export interface QueryPersistenceHandle {
/** Stops persisting further cache changes. Does not clear already-written data. */
  unsubscribe: () => void;
/** Resolves once the initial restore attempt (hydrated, discarded, or errored) settles. */
  restored: Promise<void>;
}

/**
 * Lower-level, non-React imperative equivalent of wrapping the app in
* `<PersistQueryClientProvider persistOptions={buildPersistOptions}>`.
 * Production uses the provider (it also gates fetches during restore — see
 * `buildPersistOptions`'s doc comment); this remains for direct unit tests
 * of the dehydrate/hydrate mechanics (whitelist, buster, maxAge) without
 * needing to render a component tree, and for any future non-React caller.
 *
 * A storage that throws on restore (e.g. IndexedDB unavailable in Safari
 * private mode) rejects `persistQueryClientRestore` internally; that
* rejection is deliberately given a no-op `.catch` here so a caller who
 * never awaits `restored` doesn't produce an unhandled promise rejection —
 * the app continues without a persisted cache rather than crashing. The
 * *same* underlying promise is still returned, so a caller that does want
* to observe failure can still `await`/`.catch` it themselves.
 */
export function setupQueryPersistence(
  queryClient: QueryClient,
  options?: { storage?: AsyncStorage<string>; throttleTime?: number },
): QueryPersistenceHandle {
  const persistOptions = buildPersistOptions(options);
  const [unsubscribe, restored] = persistQueryClient({
    queryClient,
    ...persistOptions,
  });
  restored.catch(() => {
// See doc comment above: prevents an unhandled-rejection warning only;
// does not consume the rejection for any other `.catch`/`await`.
  });
  return { unsubscribe, restored };
}

/**
 * Reconnect invalidation: persisted/cached data is shown instantly but must
 * be treated as stale, so every whitelisted query is invalidated the moment
 * the connection (re)confirms reachable — see `useQueryCacheReconnectSync`,
 * which calls this on every transition into `'connected'`. Scoped to the
 * same whitelist that gets persisted; nothing outside it needs this nudge
 * since it isn't cache-first in the first place.
 */
export async function invalidatePersistedQueries(
  queryClient: QueryClient,
): Promise<void> {
  await Promise.all(
    PERSISTED_QUERY_KEY_PREFIXES.map((prefix) =>
      queryClient.invalidateQueries({ queryKey: [prefix] }),
    ),
  );
}
