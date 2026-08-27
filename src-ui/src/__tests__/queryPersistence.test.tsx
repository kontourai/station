/**
 * @vitest-environment jsdom
 *
 * station#1223 (offline slice 1) — cache-first persistence.
 *
 * Drives the real save/restore round trip through `setupQueryPersistence`
 * against an in-memory mock of the `AsyncStorage` contract, so these pin the
 * actual whitelist/buster/maxAge wiring rather than just the predicate in
 * isolation. No real IndexedDB needed — the persister is storage-agnostic.
 */
import { createAsyncStoragePersister } from '@tanstack/query-async-storage-persister';
import { QueryClient, useQuery } from '@tanstack/react-query';
import {
  type PersistedClient,
  PersistQueryClientProvider,
  persistQueryClientSave,
} from '@tanstack/react-query-persist-client';
import { render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  applyPersistedQueryGcTimeDefaults,
  PERSISTED_QUERY_KEY_PREFIXES,
  QUERY_PERSISTENCE_MAX_AGE_MS,
  QUERY_PERSISTENCE_STORAGE_KEY,
  queryPersistenceBuster,
  setupQueryPersistence,
  shouldPersistQuery,
} from '../lib/queryPersistence';

/** In-memory stand-in for the `AsyncStorage<string>` contract the real
 * IndexedDB-backed storage implements — this is what "simulates a reload"
 * across two independent `QueryClient` instances below. */
function createMemoryStorage() {
  const data = new Map<string, string>();
  return {
    data,
    storage: {
      getItem: async (key: string) => data.get(key),
      setItem: async (key: string, value: string) => {
        data.set(key, value);
      },
      removeItem: async (key: string) => {
        data.delete(key);
      },
    },
  };
}

describe('shouldPersistQuery — default-deny whitelist', () => {
  it('persists a whitelisted, successful query', () => {
    for (const prefix of PERSISTED_QUERY_KEY_PREFIXES) {
      expect(
        shouldPersistQuery({
          queryKey: [prefix, 'x'],
          state: { status: 'success', error: null } as never,
        }),
      ).toBe(true);
    }
  });

  it('never persists a query outside the whitelist (e.g. auth-status, orchestration streams)', () => {
    for (const queryKey of [
      ['auth-status'],
      ['connections'],
      ['orchestration-sessions'],
      ['orchestration-session-board', 'proj'],
      ['flow-run-console', 'proj', 'run'],
      ['attention'],
      ['messages', 'agent', 'conv'],
      ['scheduler'],
    ]) {
      expect(
        shouldPersistQuery({
          queryKey,
          state: { status: 'success', error: null } as never,
        }),
      ).toBe(false);
    }
  });

  it('persists model catalogs but never the credential-shaped raw connections query', () => {
    expect(PERSISTED_QUERY_KEY_PREFIXES).toContain('model-catalog');
    expect(PERSISTED_QUERY_KEY_PREFIXES).toContain('model-picker-catalog');
    expect(
      shouldPersistQuery({
        queryKey: ['model-picker-catalog'],
        state: { status: 'success', error: null } as never,
      }),
    ).toBe(true);
    expect(
      shouldPersistQuery({
        queryKey: ['connections', 'models'],
        state: { status: 'success', error: null } as never,
      }),
    ).toBe(false);
    expect(
      shouldPersistQuery({
        queryKey: ['models', 'aws-profiles'],
        state: { status: 'success', error: null } as never,
      }),
    ).toBe(false);
  });

  it('never persists an errored or still-pending query, even if whitelisted', () => {
    expect(
      shouldPersistQuery({
        queryKey: ['agents'],
        state: { status: 'error', error: new Error('boom') } as never,
      }),
    ).toBe(false);
    expect(
      shouldPersistQuery({
        queryKey: ['agents'],
        state: { status: 'pending', error: null } as never,
      }),
    ).toBe(false);
  });
});

describe('setupQueryPersistence — save/restore round trip (simulated reload)', () => {
  it('persists whitelisted queries and a fresh client restores them', async () => {
    const { storage, data } = createMemoryStorage();

    const clientA = new QueryClient();
    const handleA = setupQueryPersistence(clientA, {
      storage,
      throttleTime: 0,
    });
    await handleA.restored;

    clientA.setQueryData(['agents'], [{ slug: 'writer' }]);
    await waitFor(() => expect(data.size).toBeGreaterThan(0));
    handleA.unsubscribe();

    const clientB = new QueryClient();
    const handleB = setupQueryPersistence(clientB, {
      storage,
      throttleTime: 0,
    });
    await handleB.restored;

    expect(clientB.getQueryData(['agents'])).toEqual([{ slug: 'writer' }]);
  });

  it('does not restore a non-whitelisted/sensitive query (auth-status) even though it shared the cache', async () => {
    const { storage, data } = createMemoryStorage();

    const clientA = new QueryClient();
    const handleA = setupQueryPersistence(clientA, {
      storage,
      throttleTime: 0,
    });
    await handleA.restored;

    clientA.setQueryData(['agents'], [{ slug: 'writer' }]);
    clientA.setQueryData(['auth-status'], { token: 'super-secret' });
    await waitFor(() => expect(data.size).toBeGreaterThan(0));
    handleA.unsubscribe();

    const clientB = new QueryClient();
    const handleB = setupQueryPersistence(clientB, {
      storage,
      throttleTime: 0,
    });
    await handleB.restored;

    expect(clientB.getQueryData(['agents'])).toEqual([{ slug: 'writer' }]);
    expect(clientB.getQueryData(['auth-status'])).toBeUndefined();
  });

  it('never persists mutations, even a paused one the default policy would keep', async () => {
    const { storage, data } = createMemoryStorage();

    const clientA = new QueryClient();
    const handleA = setupQueryPersistence(clientA, {
      storage,
      throttleTime: 0,
    });
    await handleA.restored;

    clientA.setQueryData(['agents'], [{ slug: 'writer' }]);
    // A paused mutation is the ONE case react-query's *default*
    // shouldDehydrateMutation persists (`mutation.state.isPaused`) — this
    // proves our explicit `() => false` override actually wins over that
    // default rather than merely happening to not exercise it.
    clientA
      .getMutationCache()
      .build(clientA, { mutationKey: ['rename-agent'] }, {
        isPaused: true,
        status: 'pending',
      } as never);
    await waitFor(() => expect(data.size).toBeGreaterThan(0));
    handleA.unsubscribe();

    const clientB = new QueryClient();
    const handleB = setupQueryPersistence(clientB, {
      storage,
      throttleTime: 0,
    });
    await handleB.restored;

    expect(clientB.getQueryData(['agents'])).toEqual([{ slug: 'writer' }]);
    expect(clientB.getMutationCache().getAll()).toHaveLength(0);
  });

  it('discards the persisted cache when the buster does not match the running build', async () => {
    const { storage, data } = createMemoryStorage();

    // Seed storage as if a *different* build had persisted this cache.
    const seedClient = new QueryClient();
    seedClient.setQueryData(['agents'], [{ slug: 'stale-build' }]);
    const seedPersister = createAsyncStoragePersister({
      storage,
      key: QUERY_PERSISTENCE_STORAGE_KEY,
    });
    await persistQueryClientSave({
      queryClient: seedClient,
      persister: seedPersister,
      buster: 'some-other-build-buster',
      dehydrateOptions: { shouldDehydrateQuery: shouldPersistQuery },
    });
    expect(data.size).toBeGreaterThan(0);

    const clientB = new QueryClient();
    const handleB = setupQueryPersistence(clientB, {
      storage,
      throttleTime: 0,
    });
    await handleB.restored;

    expect(clientB.getQueryData(['agents'])).toBeUndefined();
    // The mismatched cache is discarded from storage entirely, not just
    // ignored in memory (persistQueryClientRestore's busted-cache path).
    expect(data.size).toBe(0);
  });

  it('discards a persisted cache older than the max age even with a matching buster', async () => {
    const { storage, data } = createMemoryStorage();

    const persistedClient = {
      timestamp: Date.now() - (QUERY_PERSISTENCE_MAX_AGE_MS + 60_000),
      buster: queryPersistenceBuster(),
      clientState: {
        queries: [
          {
            queryKey: ['agents'],
            queryHash: JSON.stringify(['agents']),
            state: {
              data: [{ slug: 'too-old' }],
              status: 'success',
              error: null,
              dataUpdatedAt:
                Date.now() - (QUERY_PERSISTENCE_MAX_AGE_MS + 60_000),
            },
          },
        ],
        mutations: [],
      },
    };
    data.set(QUERY_PERSISTENCE_STORAGE_KEY, JSON.stringify(persistedClient));

    const clientB = new QueryClient();
    const handleB = setupQueryPersistence(clientB, {
      storage,
      throttleTime: 0,
    });
    await handleB.restored;

    expect(clientB.getQueryData(['agents'])).toBeUndefined();
    expect(data.size).toBe(0);
  });
});

describe('applyPersistedQueryGcTimeDefaults — gcTime >= persister maxAge', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("keeps a whitelisted query resident well past the app's ordinary 10-minute gcTime", () => {
    // Mirrors main.tsx's real global default — the bug this guards against
    // is exactly this default silently winning for whitelisted keys too.
    const queryClient = new QueryClient({
      defaultOptions: { queries: { gcTime: 10 * 60 * 1000 } },
    });
    applyPersistedQueryGcTimeDefaults(queryClient);

    const removed = vi.fn();
    queryClient.getQueryCache().subscribe((event) => {
      if (event.type === 'removed') removed(event.query.queryKey);
    });

    // No observer ever mounts for this key — matches the real scenario: a
    // view that loaded agents, then navigated away, with nobody watching.
    queryClient.setQueryData(['agents'], [{ slug: 'writer' }]);

    vi.advanceTimersByTime(11 * 60 * 1000); // past the ordinary 10-minute gcTime
    expect(removed).not.toHaveBeenCalled();
    expect(queryClient.getQueryData(['agents'])).toEqual([{ slug: 'writer' }]);

    vi.advanceTimersByTime(25 * 60 * 60 * 1000); // now past the 24h floor too
    expect(removed).toHaveBeenCalledWith(['agents']);
    expect(queryClient.getQueryData(['agents'])).toBeUndefined();
  });

  it('does not extend gcTime for a non-whitelisted query (e.g. auth-status) — it still collects at the ordinary default', () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { gcTime: 10 * 60 * 1000 } },
    });
    applyPersistedQueryGcTimeDefaults(queryClient);

    queryClient.setQueryData(['auth-status'], { token: 'super-secret' });
    vi.advanceTimersByTime(11 * 60 * 1000);

    expect(queryClient.getQueryData(['auth-status'])).toBeUndefined();
  });
});

describe('<PersistQueryClientProvider> — isRestoring gates fetches during async restore', () => {
  /** A persister whose restoreClient() resolves only when the test calls
   * `resolveRestore` — simulates the real IndexedDB gap between mount and
   * an async restore actually landing. */
  function createControllableRestorePersister() {
    let resolveRestore!: (value: PersistedClient | undefined) => void;
    const restorePromise = new Promise<PersistedClient | undefined>(
      (resolve) => {
        resolveRestore = resolve;
      },
    );
    return {
      persister: {
        persistClient: async () => undefined,
        restoreClient: () => restorePromise,
        removeClient: async () => undefined,
      },
      resolveRestore,
    };
  }

  it('does not fetch a mounted whitelisted query until restore completes', async () => {
    const { persister, resolveRestore } = createControllableRestorePersister();
    const queryClient = new QueryClient();
    const queryFn = vi.fn(async () => ['fetched-agents']);

    function Probe() {
      const { data, isFetching } = useQuery({
        queryKey: ['agents'],
        queryFn,
      });
      return (
        <div data-testid="probe">
          {isFetching ? 'fetching' : (data?.join(',') ?? 'idle')}
        </div>
      );
    }

    render(
      <PersistQueryClientProvider
        client={queryClient}
        persistOptions={{
          persister,
          dehydrateOptions: { shouldDehydrateQuery: shouldPersistQuery },
        }}
      >
        <Probe />
      </PersistQueryClientProvider>,
    );

    // Mid-restore: the observer must not have subscribed/fetched yet.
    expect(screen.getByTestId('probe').textContent).toBe('idle');
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(queryFn).not.toHaveBeenCalled();

    // Restore completes (empty cache, nothing to hydrate) — only now should
    // the observer subscribe and the query actually fetch.
    resolveRestore(undefined);
    await waitFor(() => expect(queryFn).toHaveBeenCalledTimes(1));
    await waitFor(() =>
      expect(screen.getByTestId('probe').textContent).toBe('fetched-agents'),
    );
  });

  it('shows restored data instantly once restore completes, without ever fetching', async () => {
    const { persister, resolveRestore } = createControllableRestorePersister();
    const queryClient = new QueryClient();
    const queryFn = vi.fn(async () => ['should-not-be-called']);

    function Probe() {
      const { data, isFetching } = useQuery({
        queryKey: ['agents'],
        queryFn,
        staleTime: Number.POSITIVE_INFINITY,
      });
      return (
        <div data-testid="probe">
          {isFetching ? 'fetching' : (data?.join(',') ?? 'idle')}
        </div>
      );
    }

    render(
      <PersistQueryClientProvider
        client={queryClient}
        persistOptions={{
          persister,
          dehydrateOptions: { shouldDehydrateQuery: shouldPersistQuery },
        }}
      >
        <Probe />
      </PersistQueryClientProvider>,
    );

    resolveRestore({
      timestamp: Date.now(),
      buster: '',
      clientState: {
        queries: [
          {
            queryKey: ['agents'],
            queryHash: JSON.stringify(['agents']),
            state: {
              data: ['restored-agents'],
              status: 'success',
              error: null,
              dataUpdatedAt: Date.now(),
            },
          },
        ],
        mutations: [],
      },
    } as never);

    await waitFor(() =>
      expect(screen.getByTestId('probe').textContent).toBe('restored-agents'),
    );
    expect(queryFn).not.toHaveBeenCalled();
  });
});

describe('restore failure degrades gracefully', () => {
  it('setupQueryPersistence never produces an unhandled rejection when storage throws', async () => {
    const throwingStorage = {
      getItem: async () => {
        throw new Error('IndexedDB unavailable (private mode)');
      },
      setItem: async () => undefined,
      removeItem: async () => undefined,
    };
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);

    try {
      const queryClient = new QueryClient();
      // Deliberately do NOT touch `handle.restored` here (no await/.then/
      // .catch) before checking for an unhandled rejection below — a caller
      // that never inspects it is exactly the real fire-and-forget shape
      // this guards against. Awaiting it first would attach our OWN
      // handler and mask a missing internal `.catch()`.
      setupQueryPersistence(queryClient, {
        storage: throwingStorage,
        throttleTime: 0,
      });

      // Give the rejection's microtask/macrotask turn a chance to fire so
      // Node can flag it as unhandled if nothing caught it internally.
      await new Promise((resolve) => setTimeout(resolve, 0));
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off('unhandledRejection', unhandled);
    }
  });

  it('<PersistQueryClientProvider> continues rendering (isRestoring resolves false) when the persister throws on restore', async () => {
    const throwingPersister = {
      persistClient: async () => undefined,
      restoreClient: async () => {
        throw new Error('IndexedDB unavailable (private mode)');
      },
      removeClient: async () => undefined,
    };
    const queryClient = new QueryClient();
    const queryFn = vi.fn(async () => ['fetched-agents']);
    const onError = vi.fn();

    function Probe() {
      const { data, isFetching } = useQuery({ queryKey: ['agents'], queryFn });
      return (
        <div data-testid="probe">
          {isFetching ? 'fetching' : (data?.join(',') ?? 'idle')}
        </div>
      );
    }

    render(
      <PersistQueryClientProvider
        client={queryClient}
        persistOptions={{
          persister: throwingPersister,
          dehydrateOptions: { shouldDehydrateQuery: shouldPersistQuery },
        }}
        onError={onError}
      >
        <Probe />
      </PersistQueryClientProvider>,
    );

    // Restore fails, but the app recovers: isRestoring flips false and the
    // query fetches normally instead of hanging forever mid-restore.
    await waitFor(() => expect(onError).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(queryFn).toHaveBeenCalledTimes(1));
    await waitFor(() =>
      expect(screen.getByTestId('probe').textContent).toBe('fetched-agents'),
    );
  });
});
