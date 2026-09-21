/**
 * #481 client authority — integrated adversarial coverage over the REAL
 * provider tree, not helper-only.
 *
 * Mounts `ConnectionsProvider` (real `ConnectionStore`) +
 * `QueryClientProvider` (nonpersisted bootstrap) + `AuthorityQueryProvider`
 * with mocked WIRE data only: the observation endpoint (`fetchObservation`)
 * and the protected project read. Everything between — scope capture,
 * stale-observation rejection, namespace derivation, per-namespace clients,
 * namespaced persist/restore, retirement cancel — is production code.
 *
 * The best-effort boot-payload seed is held at `host-unavailable` so no test
 * depends on network; it is orthogonal to authority partition and covered
 * by its own suite.
 *
 * @vitest-environment jsdom
 */

import {
  ConnectionStore,
  ConnectionsProvider,
} from '@kontourai/station-connect';
import type { AuthorityObservation } from '@kontourai/station-contracts/authority-observation';
import {
  QueryClient,
  QueryClientProvider,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
import { act, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AuthorityQueryProvider,
  type FetchAuthorityObservation,
  useAuthorityPersistence,
} from '../contexts/AuthorityQueryContext';
import {
  AUTHORITY_CACHE_KEY_PREFIX,
  authorityPersistenceKey,
  buildAuthorityNamespace,
} from '../lib/authorityNamespace';
import {
  QUERY_PERSISTENCE_STORAGE_KEY,
  queryPersistenceBuster,
} from '../lib/queryPersistence';

vi.mock('../lib/local-ui-bootstrap', () => ({
  resolveLocalUiSession: async () => ({ kind: 'host-unavailable' }),
}));

const OBS_A: AuthorityObservation = {
  schemaVersion: 'station.authority-observation/v1',
  environmentId: 'env-home-a',
  principal: { kind: 'human', id: 'human:local:alice' },
  grant: { kind: 'operator' },
};
const OBS_B: AuthorityObservation = {
  schemaVersion: 'station.authority-observation/v1',
  environmentId: 'env-home-b',
  principal: { kind: 'human', id: 'human:local:bob' },
  grant: {
    kind: 'device',
    deviceId: 'device-bob-1',
    grantedScopes: ['orchestration:read', 'pairing:chat'],
  },
};
/** Same endpoint AND same ids as A, but a different principal/grant. */
const OBS_A2: AuthorityObservation = {
  schemaVersion: 'station.authority-observation/v1',
  environmentId: 'env-home-a',
  principal: { kind: 'human', id: 'human:local:carol' },
  grant: {
    kind: 'device',
    deviceId: 'device-carol-1',
    grantedScopes: ['pairing:chat'],
  },
};

const NS_A = buildAuthorityNamespace(OBS_A);
const NS_B = buildAuthorityNamespace(OBS_B);
const NS_A2 = buildAuthorityNamespace(OBS_A2);

function memoryAdapter() {
  const state: Record<string, string> = {};
  return {
    get: (key: string) => state[key] ?? null,
    set: (key: string, value: string) => {
      state[key] = value;
    },
    remove: (key: string) => {
      delete state[key];
    },
  };
}

function memoryAsyncStorage() {
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

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const UNAUTHORIZED = new Error(
  'This Station did not accept the presented credential.',
);

type ProjectList = { id: string; home: string }[];

interface Harness {
  store: ConnectionStore;
  connections: { id: string; url: string }[];
  observationCalls: { apiBase: string; authorityKey: string }[];
  projectFetches: (string | undefined)[];
  projectPlan: Map<string, () => Promise<ProjectList>>;
  asyncStorage: ReturnType<typeof memoryAsyncStorage>;
}

function createHarness(
  plan: Map<string, () => Promise<AuthorityObservation>>,
): Harness {
  const store = new ConnectionStore({
    storage: memoryAdapter(),
    credentialStorage: memoryAdapter(),
    storageKey: `authority-test-${Math.random().toString(36).slice(2)}`,
  });
  const connA = store.add('HomeA', 'http://home-a:3141');
  const connB = store.add('HomeB', 'http://home-b:3141');
  const harness: Harness = {
    store,
    connections: [
      { id: connA.id, url: connA.url },
      { id: connB.id, url: connB.url },
    ],
    observationCalls: [],
    projectFetches: [],
    projectPlan: new Map(),
    asyncStorage: memoryAsyncStorage(),
  };
  return harnessWithPlan(harness, plan);
}

function harnessWithPlan(
  harness: Harness,
  plan: Map<string, () => Promise<AuthorityObservation>>,
): Harness {
  const fetchObservation: FetchAuthorityObservation = async (request) => {
    harness.observationCalls.push({
      apiBase: request.apiBase,
      authorityKey: request.requestScope?.authorityKey ?? '',
    });
    const activeId = harness.store.getActive()?.id;
    const behavior = (activeId && plan.get(activeId)) ?? plan.get('default');
    if (!behavior) throw new Error(`no observation plan for ${activeId}`);
    return behavior();
  };
  (
    harness as Harness & { fetchObservation: FetchAuthorityObservation }
  ).fetchObservation = fetchObservation;
  return harness;
}

function projectListFor(
  activeId: string | undefined,
): { id: string; home: string }[] {
  // SAME project ids under every home — the collision the partition must close.
  return [{ id: 'p1', home: activeId ?? 'none' }];
}

function Probe() {
  const { status, namespace } = useAuthorityPersistence();
  const client = useQueryClient();
  const projects = useQuery({
    queryKey: ['projects'],
    queryFn: async () => {
      const harness = (Probe as unknown as { harness: Harness }).harness;
      const activeId = harness.store.getActive()?.id;
      harness.projectFetches.push(activeId);
      const behavior =
        (activeId && harness.projectPlan.get(activeId)) ??
        harness.projectPlan.get('default');
      if (behavior) return behavior();
      return projectListFor(activeId);
    },
    staleTime: Number.POSITIVE_INFINITY,
    retry: false,
  });
  return (
    <div
      data-testid="probe"
      data-status={status}
      data-namespace={namespace ?? ''}
      data-projects={
        projects.data ? JSON.stringify(projects.data) : projects.status
      }
      data-agents={JSON.stringify(client.getQueryData(['agents']) ?? null)}
      data-mutations={String(client.getMutationCache().getAll().length)}
    />
  );
}

function renderTree(harness: Harness) {
  (Probe as unknown as { harness: Harness }).harness = harness;
  const bootstrap = new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
        refetchOnMount: false,
        refetchOnWindowFocus: false,
      },
    },
  });
  const fetchObservation = (
    harness as Harness & { fetchObservation: FetchAuthorityObservation }
  ).fetchObservation;
  return render(
    <ConnectionsProvider
      store={harness.store}
      defaultUrl="http://localhost:3141"
    >
      <QueryClientProvider client={bootstrap}>
        <AuthorityQueryProvider
          fetchObservation={fetchObservation}
          storage={harness.asyncStorage.storage}
          localUiApiBase="http://127.0.0.1:9"
          persistThrottleTimeMs={0}
        >
          <Probe />
        </AuthorityQueryProvider>
      </QueryClientProvider>
    </ConnectionsProvider>,
  );
}

function probe(): HTMLElement {
  return screen.getByTestId('probe');
}

beforeEach(() => {
  localStorage.clear();
});

describe('authority query isolation (real provider tree, mocked wire)', () => {
  it('verifies the first authority with its captured scope and serves its data from a namespaced shelf', async () => {
    const harness = createHarness(new Map([['default', async () => OBS_A]]));
    const [connA] = harness.connections;
    renderTree(harness);

    await waitFor(() =>
      expect(probe().getAttribute('data-status')).toBe('verified'),
    );
    await waitFor(() =>
      expect(probe().getAttribute('data-projects')).toContain(connA.id),
    );
    // The observation read carried the captured, non-secret request scope.
    expect(harness.observationCalls.length).toBeGreaterThan(0);
    expect(harness.observationCalls[0]?.apiBase).toBe('http://home-a:3141');
    expect(harness.observationCalls[0]?.authorityKey.length).toBeGreaterThan(0);
    expect(probe().getAttribute('data-namespace')).toBe(NS_A);
    await waitFor(() =>
      expect(harness.asyncStorage.data.has(authorityPersistenceKey(NS_A))).toBe(
        true,
      ),
    );
  });

  it('two homes sharing project ids never collide; returning restores without refetch', async () => {
    const harness = createHarness(new Map());
    const [connA, connB] = harness.connections;
    const plan = new Map<string, () => Promise<AuthorityObservation>>([
      [connA.id, async () => OBS_A],
      [connB.id, async () => OBS_B],
    ]);
    harnessWithPlan(harness, plan);
    renderTree(harness);

    await waitFor(() =>
      expect(probe().getAttribute('data-projects')).toContain(connA.id),
    );
    const fetchesAfterA = harness.projectFetches.length;

    await act(async () => {
      harness.store.setActive(connB.id);
    });
    await waitFor(() =>
      expect(probe().getAttribute('data-projects')).toContain(connB.id),
    );
    expect(probe().getAttribute('data-namespace')).toBe(NS_B);
    // Disjoint shelves: A's blob survived while B is active.
    await waitFor(() =>
      expect(harness.asyncStorage.data.has(authorityPersistenceKey(NS_A))).toBe(
        true,
      ),
    );
    await waitFor(() =>
      expect(harness.asyncStorage.data.has(authorityPersistenceKey(NS_B))).toBe(
        true,
      ),
    );

    await act(async () => {
      harness.store.setActive(connA.id);
    });
    await waitFor(() =>
      expect(probe().getAttribute('data-projects')).toContain(connA.id),
    );
    // Restored from A's own blob — no refetch for the return trip.
    await waitFor(() =>
      expect(probe().getAttribute('data-status')).toBe('verified'),
    );
    expect(harness.projectFetches.length).toBe(fetchesAfterA + 1);
  });

  it('same endpoint, different principals/grants partition (origin is not identity)', async () => {
    const harness = createHarness(new Map());
    const [connA] = harness.connections;
    // NOTE: `ConnectionStore.add` dedupes by exact URL (it activates the
    // existing row), so the second identity uses the same ORIGIN with a
    // trivially different endpoint string — the point stands: the
    // observations, not the endpoint text, decide the namespace.
    const connA2 = harness.store.add(
      'HomeA-second-user',
      'http://home-a:3141/station',
    );
    harness.store.setActive(connA.id);
    const plan = new Map<string, () => Promise<AuthorityObservation>>([
      [connA.id, async () => OBS_A],
      [connA2.id, async () => OBS_A2],
    ]);
    harnessWithPlan(harness, plan);
    renderTree(harness);

    await waitFor(() =>
      expect(probe().getAttribute('data-namespace')).toBe(NS_A),
    );
    await act(async () => {
      harness.store.setActive(connA2.id);
    });
    await waitFor(() =>
      expect(probe().getAttribute('data-namespace')).toBe(NS_A2),
    );
    expect(NS_A2).not.toBe(NS_A);
    await waitFor(() =>
      expect(
        harness.asyncStorage.data.has(authorityPersistenceKey(NS_A2)),
      ).toBe(true),
    );
  });

  it('a late read from the retired authority never paints (delayed fetcher discrimination)', async () => {
    const harness = createHarness(new Map());
    const [connA, connB] = harness.connections;
    const projectsA = deferred<ProjectList>();
    // Hold A's FIRST project read open past the switch to B.
    harness.projectPlan.set(connA.id, () => projectsA.promise);
    const plan = new Map<string, () => Promise<AuthorityObservation>>([
      [connA.id, async () => OBS_A],
      [connB.id, async () => OBS_B],
    ]);
    harnessWithPlan(harness, plan);
    renderTree(harness);
    await waitFor(() =>
      expect(probe().getAttribute('data-status')).toBe('verified'),
    );
    expect(probe().getAttribute('data-projects')).toBe('pending');

    await act(async () => {
      harness.store.setActive(connB.id);
    });
    await waitFor(() =>
      expect(probe().getAttribute('data-projects')).toContain(connB.id),
    );
    // A's retired read resolves late into a retired, unmounted cache.
    await act(async () => {
      projectsA.resolve(projectListFor(connA.id));
    });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(probe().getAttribute('data-projects')).toContain(connB.id);
    expect(probe().getAttribute('data-namespace')).toBe(NS_B);
    // The retired client persisted nothing paintable: either it never
    // wrote, or its shelf holds no project data.
    const nsABlob = harness.asyncStorage.data.get(
      authorityPersistenceKey(NS_A),
    );
    if (nsABlob !== undefined) expect(nsABlob).not.toContain(connA.id);
  });

  it('fast A->B->A with a delayed B observation never activates B', async () => {
    const harness = createHarness(new Map());
    const [connA, connB] = harness.connections;
    const observationB = deferred<AuthorityObservation>();
    const plan = new Map<string, () => Promise<AuthorityObservation>>([
      [connA.id, async () => OBS_A],
      [connB.id, () => observationB.promise],
    ]);
    harnessWithPlan(harness, plan);
    renderTree(harness);

    await waitFor(() =>
      expect(probe().getAttribute('data-namespace')).toBe(NS_A),
    );
    await act(async () => {
      harness.store.setActive(connB.id);
    });
    // B's observation is still in flight — honest loading, not A's data.
    await waitFor(() =>
      expect(screen.queryByText(/Verifying Station authority/i)).not.toBeNull(),
    );
    await act(async () => {
      harness.store.setActive(connA.id);
    });
    // A's observation is cached under its key: instant re-verify.
    await waitFor(() =>
      expect(probe().getAttribute('data-namespace')).toBe(NS_A),
    );
    // B resolves late and must be refused: synchronous stale-observation
    // rejection, so B never becomes a client and never owns a shelf.
    await act(async () => {
      observationB.resolve(OBS_B);
    });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(probe().getAttribute('data-namespace')).toBe(NS_A);
    expect(probe().getAttribute('data-status')).toBe('verified');
    expect(harness.asyncStorage.data.has(authorityPersistenceKey(NS_B))).toBe(
      false,
    );
  });

  it('revocation re-observes, quarantines persistence, and retains the blob (no silent loss)', async () => {
    const harness = createHarness(new Map());
    const [connA] = harness.connections;
    let revoked = false;
    const plan = new Map<string, () => Promise<AuthorityObservation>>([
      [
        connA.id,
        async () => {
          if (revoked) throw UNAUTHORIZED;
          return OBS_A;
        },
      ],
      ['default', async () => OBS_A],
    ]);
    harnessWithPlan(harness, plan);
    renderTree(harness);

    await waitFor(() =>
      expect(probe().getAttribute('data-status')).toBe('verified'),
    );
    await waitFor(() =>
      expect(harness.asyncStorage.data.has(authorityPersistenceKey(NS_A))).toBe(
        true,
      ),
    );

    // A revocation is a transition on a SAVED credential: install one (which
    // itself re-observes under a new generation), then reject exactly it.
    await act(async () => {
      harness.store.setCredential(connA.id, 'cred-1');
    });
    await waitFor(() =>
      expect(probe().getAttribute('data-status')).toBe('verified'),
    );
    const observationCallsBefore = harness.observationCalls.length;
    expect(observationCallsBefore).toBeGreaterThan(1);

    revoked = true;
    await act(async () => {
      harness.store.markCredentialRequired(connA.id, 'cred-1');
    });
    // The credential transition re-drove observation, which failed closed.
    await waitFor(() =>
      expect(probe().getAttribute('data-status')).toBe('unavailable'),
    );
    expect(harness.observationCalls.length).toBeGreaterThan(
      observationCallsBefore,
    );
    expect(probe().getAttribute('data-namespace')).toBe('');
    // The authorized blob is retained verbatim — quarantine, not deletion.
    expect(harness.asyncStorage.data.has(authorityPersistenceKey(NS_A))).toBe(
      true,
    );
  });

  it('offline with no observation restores the remembered blob as unverified, never as current', async () => {
    const harness = createHarness(new Map());
    const [connA] = harness.connections;
    const online = new Map<string, () => Promise<AuthorityObservation>>([
      [connA.id, async () => OBS_A],
      ['default', async () => OBS_A],
    ]);
    harnessWithPlan(harness, online);
    const { unmount } = renderTree(harness);
    await waitFor(() =>
      expect(probe().getAttribute('data-status')).toBe('verified'),
    );
    await waitFor(() =>
      expect(harness.asyncStorage.data.has(authorityPersistenceKey(NS_A))).toBe(
        true,
      ),
    );
    unmount();

    // Cold boot with the wire down: the stored tuple is retained for
    // reading but explicitly NOT current authorization.
    const offline = new Map<string, () => Promise<AuthorityObservation>>([
      [
        connA.id,
        async () => {
          throw new TypeError('fetch failed');
        },
      ],
      [
        'default',
        async () => {
          throw new TypeError('fetch failed');
        },
      ],
    ]);
    harnessWithPlan(harness, offline);
    harness.projectFetches.length = 0;
    renderTree(harness);
    await waitFor(() =>
      expect(probe().getAttribute('data-status')).toBe('unverified'),
    );
    expect(probe().getAttribute('data-namespace')).toBe(NS_A);
    await waitFor(() =>
      expect(probe().getAttribute('data-projects')).toContain(connA.id),
    );
    // Restored, not fetched: no network read backed this render.
    expect(harness.projectFetches).toHaveLength(0);
  });

  it('the legacy singleton blob is quarantined: never adopted, never deleted', async () => {
    const harness = createHarness(new Map([['default', async () => OBS_A]]));
    const legacyBlob = JSON.stringify({
      timestamp: Date.now(),
      buster: queryPersistenceBuster(),
      clientState: {
        queries: [
          {
            queryKey: ['agents'],
            queryHash: JSON.stringify(['agents']),
            state: {
              data: [{ slug: 'legacy-ghost' }],
              status: 'success',
              error: null,
              dataUpdatedAt: Date.now(),
            },
          },
        ],
        mutations: [],
      },
    });
    harness.asyncStorage.data.set(QUERY_PERSISTENCE_STORAGE_KEY, legacyBlob);
    renderTree(harness);

    await waitFor(() =>
      expect(probe().getAttribute('data-status')).toBe('verified'),
    );
    // Live data, not the ghost: the legacy shelf was never hydrated.
    expect(probe().getAttribute('data-agents')).toBe('null');
    // And never destroyed either: byte-identical on disk.
    expect(harness.asyncStorage.data.get(QUERY_PERSISTENCE_STORAGE_KEY)).toBe(
      legacyBlob,
    );
  });

  it('mutations are never hydrated from a stored blob', async () => {
    const harness = createHarness(new Map([['default', async () => OBS_A]]));
    harness.asyncStorage.data.set(
      authorityPersistenceKey(NS_A),
      JSON.stringify({
        timestamp: Date.now(),
        buster: queryPersistenceBuster(),
        clientState: {
          queries: [
            {
              queryKey: ['projects'],
              queryHash: JSON.stringify(['projects']),
              state: {
                data: [{ id: 'p1', home: 'seeded' }],
                status: 'success',
                error: null,
                dataUpdatedAt: Date.now(),
              },
            },
          ],
          mutations: [
            {
              mutationKey: ['rename-agent'],
              state: {
                context: undefined,
                data: undefined,
                error: null,
                failureCount: 0,
                failureReason: null,
                isPaused: true,
                status: 'pending',
                variables: { slug: 'queued-rename' },
              },
            },
          ],
        },
      }),
    );
    renderTree(harness);

    await waitFor(() =>
      expect(probe().getAttribute('data-status')).toBe('verified'),
    );
    // The whitelisted query restored (seeded data, no fetch)…
    await waitFor(() =>
      expect(probe().getAttribute('data-projects')).toContain('seeded'),
    );
    expect(harness.projectFetches).toHaveLength(0);
    // …while the queued mutation did not survive the restore.
    expect(probe().getAttribute('data-mutations')).toBe('0');
  });

  it('namespace survives epoch-neutral store churn without refetch or key fork', async () => {
    const harness = createHarness(new Map([['default', async () => OBS_A]]));
    const [connA] = harness.connections;
    renderTree(harness);
    await waitFor(() =>
      expect(probe().getAttribute('data-namespace')).toBe(NS_A),
    );
    expect(harness.observationCalls).toHaveLength(1);

    await act(async () => {
      harness.store.update(connA.id, { name: 'Renamed HomeA' });
    });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(probe().getAttribute('data-namespace')).toBe(NS_A);
    expect(harness.observationCalls).toHaveLength(1);
    const persistKeys = [...harness.asyncStorage.data.keys()].filter((key) =>
      key.startsWith(`${AUTHORITY_CACHE_KEY_PREFIX}::`),
    );
    expect(persistKeys).toHaveLength(1);
  });
});
