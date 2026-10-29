/**
 * @vitest-environment jsdom
 *
 * archive#1290 — every server-scoped React Query cache must be marked
 * stale and refetched exactly once per genuine active-connection switch,
 * WITHOUT evicting cached data or disturbing the persisted (IndexedDB)
 * whitelist snapshot the way `queryClient.clear` would ( 1
 * finding — see the hook's own doc comment for the full mechanism). Two
 * false-positive sources must also be closed: the native two-stage boot
 * transition (no active connection -> one), and any change observed while
 * the persisted cache is still restoring.
 */

import {
  ConnectionStore,
  ConnectionsProvider,
} from '@kontourai/station-connect';
import {
  QueryClient,
  QueryClientProvider,
  useQuery,
} from '@tanstack/react-query';
import {
  type PersistedClient,
  PersistQueryClientProvider,
} from '@tanstack/react-query-persist-client';
import {
  act,
  render,
  renderHook,
  screen,
  waitFor,
} from '@testing-library/react';
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import {
  useConnectionSwitchScope,
  useInvalidateCachesOnConnectionSwitch,
} from '../hooks/useInvalidateCachesOnConnectionSwitch';
import {
  QUERY_PERSISTENCE_STORAGE_KEY,
  setupQueryPersistence,
  shouldPersistQuery,
} from '../lib/queryPersistence';

/** In-memory stand-in for the `AsyncStorage<string>` contract — mirrors
 * `queryPersistence.test.tsx`'s own helper so this exercises the real
 * dehydrate/persist wiring, not a mock of it. */
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

function plainWrapper(queryClient: QueryClient) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    );
  };
}

interface Props {
  apiBase: string;
  hasActiveConnection: boolean;
}

function renderSwitchHook(queryClient: QueryClient, initialProps: Props) {
  return renderHook(
    ({ apiBase, hasActiveConnection }: Props) =>
      useInvalidateCachesOnConnectionSwitch(apiBase, hasActiveConnection),
    { wrapper: plainWrapper(queryClient), initialProps },
  );
}

describe('useInvalidateCachesOnConnectionSwitch', () => {
  it('does not invalidate on mount', () => {
    const queryClient = new QueryClient();
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');

    renderSwitchHook(queryClient, {
      apiBase: 'http://a:3141',
      hasActiveConnection: true,
    });

    expect(invalidateSpy).not.toHaveBeenCalled();
  });

  it('does NOT invalidate on the native two-stage boot transition (no active connection -> one), even though apiBase changes in the same transition', () => {
    const queryClient = new QueryClient();
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');

    // Mirrors ApiBaseContext.tsx's desktop boot sequence: first render has
    // no active connection yet (apiBase is the DEFAULT_API_BASE placeholder);
    // once the native connection store resolves the paired profile
    // post-mount, that connection becomes active and apiBase flips to the
    // real URL — all in one settling transition, never a user-initiated
    // switch. (Prior to archive#1800, a supervising desktop's synthetic
    // `managed-loopback` row was one way this transition happened; removing
    // that injection did not change this hook's contract, which only cares
    // about hasActiveConnection flipping alongside apiBase.)
    const { rerender } = renderSwitchHook(queryClient, {
      apiBase: 'http://localhost:3242', // DEFAULT_API_BASE-style placeholder
      hasActiveConnection: false,
    });

    rerender({
      apiBase: 'http://127.0.0.1:54213', // real bundled-loopback URL
      hasActiveConnection: true,
    });

    expect(invalidateSpy).not.toHaveBeenCalled();
  });

  it('invalidates a query that completed before saved-profile establishment', () => {
    const queryClient = new QueryClient();
    queryClient.setQueryData(['config'], {
      pluginFrameOrigin: 'http://127.0.0.1:41000',
    });
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');
    const { rerender } = renderSwitchHook(queryClient, {
      apiBase: 'http://127.0.0.1:41000',
      hasActiveConnection: false,
    });

    rerender({
      apiBase: 'http://127.0.0.1:42000',
      hasActiveConnection: true,
    });

    expect(invalidateSpy).toHaveBeenCalledOnce();
  });

  it('invalidates (never clears) exactly once when an ALREADY-established connection switches to a different apiBase', () => {
    const queryClient = new QueryClient();
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');
    const clearSpy = vi.spyOn(queryClient, 'clear');

    const { rerender } = renderSwitchHook(queryClient, {
      apiBase: 'http://server-a:3141',
      hasActiveConnection: true,
    });
    expect(invalidateSpy).not.toHaveBeenCalled();

    rerender({ apiBase: 'http://server-b:3141', hasActiveConnection: true });
    expect(invalidateSpy).toHaveBeenCalledOnce();
    expect(clearSpy).not.toHaveBeenCalled();

    // A re-render with the same apiBase must not invalidate again.
    rerender({ apiBase: 'http://server-b:3141', hasActiveConnection: true });
    expect(invalidateSpy).toHaveBeenCalledOnce();

    // A second, distinct switch invalidates again.
    rerender({ apiBase: 'http://server-c:3141', hasActiveConnection: true });
    expect(invalidateSpy).toHaveBeenCalledTimes(2);
    expect(clearSpy).not.toHaveBeenCalled();
  });

  it('invalidates when a distinct saved Station with the same origin becomes active', () => {
    const queryClient = new QueryClient();
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');
    const apiBase = 'http://127.0.0.1:28141';
    const { rerender } = renderHook(
      ({ scope }: { scope: string }) =>
        useInvalidateCachesOnConnectionSwitch(apiBase, true, scope),
      {
        wrapper: plainWrapper(queryClient),
        initialProps: { scope: 'station-profile:stale-local:connection:old' },
      },
    );

    rerender({ scope: 'managed-loopback:connection:bundled' });

    expect(invalidateSpy).toHaveBeenCalledOnce();
  });

  it('invalidates when the active Station recovers native authority at the same origin', () => {
    const queryClient = new QueryClient();
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');
    const apiBase = 'http://127.0.0.1:38141';
    const { rerender } = renderHook(
      ({ scope }: { scope: string }) =>
        useInvalidateCachesOnConnectionSwitch(apiBase, true, scope),
      {
        wrapper: plainWrapper(queryClient),
        initialProps: {
          scope:
            'station-profile:local:environment:local-grant:nightly:required:authentication-failed',
        },
      },
    );

    // A native re-provision retains the selected profile and loopback origin,
    // but clears its auth failure and restores usable authority. Projects,
    // workspace panes, and Agents must refetch rather than retain that failed
    // profile's cache until an unrelated navigation happens.
    rerender({
      scope: 'station-profile:local:environment:local-grant:nightly:saved:',
    });

    expect(invalidateSpy).toHaveBeenCalledOnce();
  });

  it('marks previously-cached data stale and refetches an active query on a switch, WITHOUT evicting it first', async () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { staleTime: Number.POSITIVE_INFINITY } },
    });
    const queryFn = vi
      .fn()
      .mockResolvedValueOnce([{ id: 'server-a-connection' }])
      .mockResolvedValueOnce([{ id: 'server-b-connection' }]);

    function Probe({ apiBase, hasActiveConnection }: Props) {
      useInvalidateCachesOnConnectionSwitch(apiBase, hasActiveConnection);
      const { data } = useQuery({ queryKey: ['connections'], queryFn });
      return <div data-testid="probe">{JSON.stringify(data)}</div>;
    }

    const { rerender } = render(
      <QueryClientProvider client={queryClient}>
        <Probe apiBase="http://server-a:3141" hasActiveConnection />
      </QueryClientProvider>,
    );

    await waitFor(() =>
      expect(screen.getByTestId('probe').textContent).toContain(
        'server-a-connection',
      ),
    );
    // Never evicted at any point up to here: getQueryData had to have stayed
    // populated for the query observer to ever render this data at all.
    expect(queryClient.getQueryData(['connections'])).toBeDefined();

    rerender(
      <QueryClientProvider client={queryClient}>
        <Probe apiBase="http://server-b:3141" hasActiveConnection />
      </QueryClientProvider>,
    );

    // The switch marks it invalidated and triggers exactly the refetch that
    // replaces stale server-A data with server-B data — it is never
    // undefined/evicted in between (a real eviction would flash an empty/
    // loading state here instead of a same-tick invalidate+refetch).
    await waitFor(() =>
      expect(screen.getByTestId('probe').textContent).toContain(
        'server-b-connection',
      ),
    );
    expect(queryFn).toHaveBeenCalledTimes(2);
  });

  it('defers entirely while the persisted cache is still restoring, then evaluates the pending switch once restore completes', async () => {
    let resolveRestore!: (value: PersistedClient | undefined) => void;
    const restorePromise = new Promise<PersistedClient | undefined>(
      (resolve) => {
        resolveRestore = resolve;
      },
    );
    const controllablePersister = {
      persistClient: async () => undefined,
      restoreClient: () => restorePromise,
      removeClient: async () => undefined,
    };
    const queryClient = new QueryClient();
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');

    function Probe({ apiBase, hasActiveConnection }: Props) {
      useInvalidateCachesOnConnectionSwitch(apiBase, hasActiveConnection);
      return null;
    }

    const { rerender } = render(
      <PersistQueryClientProvider
        client={queryClient}
        persistOptions={{
          persister: controllablePersister,
          dehydrateOptions: { shouldDehydrateQuery: shouldPersistQuery },
        }}
      >
        <Probe apiBase="http://server-a:3141" hasActiveConnection />
      </PersistQueryClientProvider>,
    );

    // A switch that happens mid-restore must not fire immediately.
    rerender(
      <PersistQueryClientProvider
        client={queryClient}
        persistOptions={{
          persister: controllablePersister,
          dehydrateOptions: { shouldDehydrateQuery: shouldPersistQuery },
        }}
      >
        <Probe apiBase="http://server-b:3141" hasActiveConnection />
      </PersistQueryClientProvider>,
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(invalidateSpy).not.toHaveBeenCalled();

    // Restore completes — the pending switch (a -> b) is now evaluated.
    resolveRestore(undefined);
    await waitFor(() => expect(invalidateSpy).toHaveBeenCalledOnce());
  });

  it('preserves the persisted IndexedDB whitelist snapshot across a switch — does not wipe it the way queryClient.clear() would (review round 1)', async () => {
    const { storage, data } = createMemoryStorage();
    const queryClient = new QueryClient();
    const handle = setupQueryPersistence(queryClient, {
      storage,
      throttleTime: 0,
    });
    await handle.restored;

    // Whitelisted key (archive#1223's PERSISTED_QUERY_KEY_PREFIXES) — this is
    // exactly the durable snapshot a `clear` here would have overwritten
    // with an empty one, per the finding.
    queryClient.setQueryData(['agents'], [{ slug: 'writer' }]);
    await waitFor(() => expect(data.size).toBeGreaterThan(0));

    const readPersisted = () => {
      const raw = data.get(QUERY_PERSISTENCE_STORAGE_KEY);
      expect(raw).toBeDefined();
      const parsed = JSON.parse(raw as string) as {
        clientState: { queries: Array<{ queryKey: unknown[] }> };
      };
      return parsed.clientState.queries;
    };
    expect(
      readPersisted().some(
        (q) => JSON.stringify(q.queryKey) === JSON.stringify(['agents']),
      ),
    ).toBe(true);

    const { rerender } = renderSwitchHook(queryClient, {
      apiBase: 'http://server-a:3141',
      hasActiveConnection: true,
    });
    rerender({ apiBase: 'http://server-b:3141', hasActiveConnection: true });

    // invalidateQueries emits an 'updated' event (never 'removed'), so the
    // persister's next throttled re-dehydrate still finds — and re-persists
    // this query. Poll briefly for that re-dehydrate to actually run.
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(queryClient.getQueryData(['agents'])).toEqual([{ slug: 'writer' }]);
    expect(
      readPersisted().some(
        (q) => JSON.stringify(q.queryKey) === JSON.stringify(['agents']),
      ),
    ).toBe(true);

    handle.unsubscribe();
  });

  describe('the live connection scope (useConnectionSwitchScope over a real ConnectionStore)', () => {
    function renderLiveScope() {
      const values = new Map<string, string>();
      const store = new ConnectionStore({
        storage: {
          get: (key) => values.get(key) ?? null,
          set: (key, value) => values.set(key, value),
          remove: (key) => values.delete(key),
        },
      });
      const seeded = store.add('Remote Station', 'https://station.tail.test');
      store.setActive(seeded.id);
      const queryClient = new QueryClient({
        defaultOptions: { queries: { retry: false } },
      });
      const fetches = { count: 0 };
      function Harness() {
        const { apiBase, hasActiveConnection, connectionScope } =
          useConnectionSwitchScope();
        useInvalidateCachesOnConnectionSwitch(
          apiBase,
          hasActiveConnection,
          connectionScope,
        );
        const observed = useQuery({
          queryKey: ['agents'],
          queryFn: async () => {
            fetches.count += 1;
            return fetches.count;
          },
          staleTime: Number.POSITIVE_INFINITY,
        });
        return <div data-testid="live-scope" data-fetches={observed.data} />;
      }
      render(
        <QueryClientProvider client={queryClient}>
          <ConnectionsProvider store={store}>
            <Harness />
          </ConnectionsProvider>
        </QueryClientProvider>,
      );
      const active = store.getActive();
      if (!active) throw new Error('the seeded store has no active Station');
      return { store, active, fetches };
    }

    it('does not refetch every query when the health probe flaps between timeout and success', async () => {
      const { store, active, fetches } = renderLiveScope();
      await waitFor(() => expect(fetches.count).toBe(1));

      // The shape a slow remote Station produces: the probe misses its
      // deadline, then the next accepted request retires the error.
      for (let flap = 0; flap < 3; flap += 1) {
        act(() => store.recordEndpointFailure(active.id, 'timeout'));
        act(() => store.recordEndpointSuccess(active.id, active.url));
        act(() => store.recordEndpointFailure(active.id, 'unreachable'));
        act(() => store.recordEndpointSuccess(active.id, active.url));
      }
      await new Promise((resolve) => setTimeout(resolve, 20));

      expect(store.getActive()?.lastError).toBeUndefined();
      expect(fetches.count).toBe(1);
    });

    it('still refetches when the active Station loses or regains its credential', async () => {
      const { store, active, fetches } = renderLiveScope();
      await waitFor(() => expect(fetches.count).toBe(1));

      act(() =>
        store.recordEndpointFailure(active.id, 'authentication-failed'),
      );
      await waitFor(() => expect(fetches.count).toBe(2));

      act(() => store.recordEndpointSuccess(active.id, active.url));
      await waitFor(() => expect(fetches.count).toBe(3));
    });
  });
});
