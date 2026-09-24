/**
 * #481 client authority — integrated adversarial coverage over the REAL
 * provider tree, not helper-only.
 *
 * Mounts the production composition — real `ApiBaseProvider` (real
 * `ConnectionStore` singleton, real `StationCredentialBridge` committing
 * the real `_setApiBase` global and installing the real credential
 * resolver) + nonpersisted bootstrap `QueryClientProvider` +
 * `AuthorityQueryProvider` — with mocked WIRE data only: the observation
 * endpoint (`fetchObservation`), the protected project read (probe stub),
 * and `fetch` itself for the legacy-pattern proof. Everything between —
 * scope capture, stale-observation rejection, namespace derivation,
 * per-namespace clients, namespaced persist/restore, retirement cancel —
 * is production code.
 *
 * Each test states its own baseline through the public connections API on
 * unique origins (the store dedupes by exact URL and the singleton outlives
 * any one test) and removes its rows afterwards. The best-effort
 * boot-payload seed is held at `host-unavailable` so no test depends on
 * network; it is orthogonal to authority partition.
 *
 * @vitest-environment jsdom
 */

import { useConnections } from '@kontourai/station-connect';
import type { AuthorityObservation } from '@kontourai/station-contracts/authority-observation';
import { useUserLookup } from '@kontourai/station-sdk';
import {
  QueryClient,
  QueryClientProvider,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
// Test-local source import, NOT the public barrel: the barrel deliberately
// does not expose `_getApiBase` (no test-only public API expansion). This
// deep import resolves to the same module instance the bridge commits
// through (`api.ts` re-exports `./api-core`), so the global-origin hazard
// under test is the real one.
import { _getApiBase } from '../../../packages/sdk/src/api-core';
import { ApiBaseProvider } from '../contexts/ApiBaseContext';
import { useAuthorityPersistence } from '../contexts/AuthorityPersistenceContext';
import {
  AuthorityQueryProvider,
  type FetchAuthorityObservation,
} from '../contexts/AuthorityQueryContext';
import { isTurnInFlight } from '../contexts/active-chats-state';
import { activeChatsStore } from '../contexts/active-chats-store';
import { useScopedProjectsQuery } from '../contexts/ProjectsContext';
import {
  AUTHORITY_CACHE_KEY_PREFIX,
  authorityPersistenceKey,
  buildAuthorityNamespace,
} from '../lib/authorityNamespace';
import { resolveLocalUiSession } from '../lib/local-ui-bootstrap';
import {
  QUERY_PERSISTENCE_STORAGE_KEY,
  queryPersistenceBuster,
} from '../lib/queryPersistence';

vi.mock('../lib/local-ui-bootstrap', () => ({
  resolveLocalUiSession: vi.fn(async () => ({ kind: 'host-unavailable' })),
}));
vi.mock('../platform/useBundledServerStatus', () => ({
  useBundledServerStatus: () => null,
  restartBundledServer: vi.fn(),
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
/** Same home as A, but a changed principal/grant (re-paired identity). */
const OBS_A_ROTATED: AuthorityObservation = {
  schemaVersion: 'station.authority-observation/v1',
  environmentId: 'env-home-a',
  principal: { kind: 'human', id: 'human:local:carol' },
  grant: {
    kind: 'device',
    deviceId: 'device-carol-1',
    grantedScopes: ['pairing:chat'],
  },
};
/** Same endpoint family as A, different principal/grant. */
const OBS_A2: AuthorityObservation = {
  schemaVersion: 'station.authority-observation/v1',
  environmentId: 'env-home-a',
  principal: { kind: 'human', id: 'human:local:dave' },
  grant: {
    kind: 'device',
    deviceId: 'device-dave-1',
    grantedScopes: ['pairing:chat'],
  },
};

const NS_A = buildAuthorityNamespace(OBS_A);
const NS_B = buildAuthorityNamespace(OBS_B);
const NS_A_ROTATED = buildAuthorityNamespace(OBS_A_ROTATED);
const NS_A2 = buildAuthorityNamespace(OBS_A2);

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
  observationPlan: Map<string, () => Promise<AuthorityObservation>>;
  observationCalls: { apiBase: string; authorityKey: string }[];
  projectPlan: Map<string, () => Promise<ProjectList>>;
  projectFetches: (string | undefined)[];
  networkUp: boolean;
  legacyGate: {
    promise: Promise<unknown>;
    resolve: (value: unknown) => void;
  } | null;
  legacyResolutions: string[];
  dispatches: { url: string }[];
  asyncStorage: ReturnType<typeof memoryAsyncStorage>;
  fetchObservation: FetchAuthorityObservation;
  mountReloadProbe: boolean;
  mountUserProbe: boolean;
  /** Holds the REAL `useUserLookup` wire read open across a switch. */
  userGate: {
    promise: Promise<unknown>;
    resolve: (value: unknown) => void;
  } | null;
  /** The client the Probe last rendered under (the live verified shelf). */
  activeClient: QueryClient | null;
}

let homeCounter = 0;
const homeUrl = (tag: string): string => {
  homeCounter += 1;
  return `http://${tag}-${homeCounter}.test:3141`;
};

function projectListFor(activeId: string | undefined): ProjectList {
  // SAME project ids under every home — the collision the partition closes.
  return [{ id: 'p1', home: activeId ?? 'none' }];
}

type ConnectionsApi = ReturnType<typeof useConnections>;
let connections: ConnectionsApi | undefined;

function ConnectionsProbe() {
  connections = useConnections();
  return null;
}

function createHarness(): Harness {
  const harness: Harness = {
    observationPlan: new Map(),
    observationCalls: [],
    projectPlan: new Map(),
    projectFetches: [],
    networkUp: true,
    legacyGate: null,
    legacyResolutions: [],
    dispatches: [],
    asyncStorage: memoryAsyncStorage(),
    mountReloadProbe: false,
    mountUserProbe: false,
    userGate: null,
    activeClient: null,
    fetchObservation: async (request) => {
      harness.observationCalls.push({
        apiBase: request.apiBase,
        authorityKey: request.requestScope?.authorityKey ?? '',
      });
      // Request-faithful oracle: the wire answers for the PRESENTED
      // authority (URL + credential scope), never for whichever connection
      // happens to be live when the deferred resolves. Answering from live
      // store state here would manufacture exactly the cross-authority
      // confusion the provider's stale-observation guards exist to refuse.
      const behavior =
        harness.observationPlan.get(request.apiBase) ??
        harness.observationPlan.get('default');
      if (!behavior)
        throw new Error(`no observation plan for ${request.apiBase}`);
      return behavior();
    },
  };
  return harness;
}

function Probe() {
  const { status, namespace } = useAuthorityPersistence();
  const client = useQueryClient();
  const harness = (Probe as unknown as { harness: Harness }).harness;
  harness.activeClient = client;
  const projects = useQuery({
    queryKey: ['projects'],
    queryFn: async () => {
      const activeId = connections?.activeConnection?.id;
      harness.projectFetches.push(activeId);
      const behavior =
        (activeId && harness.projectPlan.get(activeId)) ??
        harness.projectPlan.get('default');
      if (behavior) return behavior();
      if (!harness.networkUp) throw new Error('network down');
      return projectListFor(activeId);
    },
    staleTime: Number.POSITIVE_INFINITY,
    retry: false,
  });
  // Legacy PATTERN under test (deterministic retirement-cancel proof):
  // resolves the module-global origin AT FETCH TIME (via a test-local
  // source import — the barrel does not expose it), threads its
  // AbortSignal, retries. Mounted on the verified client, so retirement
  // must cancel it before it can dispatch. The genuine signal-ignoring
  // callers (`useUserLookup`, mounted as UserProbe below) are proven
  // separately: cancel cannot abort them, unmount discards them.
  const legacy = useQuery({
    queryKey: ['legacy-probe'],
    queryFn: async ({ signal }) => {
      if (harness.legacyGate) await harness.legacyGate.promise;
      const base = await _getApiBase();
      harness.legacyResolutions.push(base);
      const response = await fetch(`${base}/api/legacy-probe`, { signal });
      return response.json();
    },
    enabled: harness.legacyGate !== null,
    retry: 3,
    retryDelay: 1,
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
      data-legacy={legacy.status}
      data-dispatches={String(harness.dispatches.length)}
    />
  );
}

/** The REAL canonical app hook: stable durable key, live wire scope. */
function ReloadProbe() {
  const query = useScopedProjectsQuery();
  return (
    <div
      data-testid="reload-probe"
      data-reload={query.data ? JSON.stringify(query.data) : query.status}
    >
      <button
        data-testid="reload-refetch"
        type="button"
        onClick={() => void query.refetch()}
      />
    </div>
  );
}

/** A REAL SDK query caller with the genuine legacy shape: `useUserLookup`
 * resolves the module-global origin at fetch time and threads NO
 * AbortSignal, so retirement `cancelQueries` cannot abort it. Its boundary
 * is effect-unmount discard plus never touching any query cache. */
function UserProbe() {
  const harness = (Probe as unknown as { harness: Harness }).harness;
  const lookup = useUserLookup(harness.mountUserProbe ? 'alice' : null);
  return (
    <div
      data-testid="user-probe"
      data-user={
        lookup.data
          ? JSON.stringify(lookup.data)
          : lookup.loading
            ? 'loading'
            : 'idle'
      }
    />
  );
}

function renderTree(
  harness: Harness,
  options?: {
    localUiApiBase?: string;
    /**
     * Use the PRODUCTION observation read (real `getAuthorityObservation`
     * through the stubbed global fetch) instead of the harness wire double,
     * to prove the seam's own bounded timeout. Only for tests that stub
     * `fetch` with black-hole semantics.
     */
    defaultObservation?: boolean;
    /** Short deadline for black-hole tests; production default otherwise. */
    observationTimeoutMs?: number;
  },
) {
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
  return render(
    <ApiBaseProvider>
      <ConnectionsProbe />
      <QueryClientProvider client={bootstrap}>
        <AuthorityQueryProvider
          {...(options?.defaultObservation
            ? {}
            : { fetchObservation: harness.fetchObservation })}
          storage={harness.asyncStorage.storage}
          localUiApiBase={options?.localUiApiBase ?? 'http://127.0.0.1:9'}
          persistThrottleTimeMs={0}
          observationTimeoutMs={options?.observationTimeoutMs}
        >
          <Probe />
          {harness.mountReloadProbe ? <ReloadProbe /> : null}
          <UserProbe />
        </AuthorityQueryProvider>
      </QueryClientProvider>
    </ApiBaseProvider>,
  );
}

function probe(): HTMLElement {
  return screen.getByTestId('probe');
}

/** Every home this file creates, so afterEach can remove it from the shared singleton. */
const createdHomeIds: string[] = [];

/**
 * Add a home WITHOUT activating it (`addConnection` keeps the current
 * active row), so observation/fetch plans can be installed for its id
 * BEFORE any switch — no activation churn, no plan-lookup races.
 */
async function addHome(
  tag: string,
  url?: string,
): Promise<{ id: string; url: string }> {
  const home = url ?? homeUrl(tag);
  let id = '';
  await act(async () => {
    id = connections?.addConnection(`Home-${tag}`, home).id ?? '';
  });
  if (!id) throw new Error(`no connection for ${home}`);
  createdHomeIds.push(id);
  return { id, url: home };
}

async function switchTo(id: string): Promise<void> {
  await act(async () => {
    await connections?.setActiveConnection(id);
  });
}

/** Distinct observation for the seeded Default row every test starts on. */
const OBS_DEFAULT: AuthorityObservation = {
  schemaVersion: 'station.authority-observation/v1',
  environmentId: 'env-default-seed',
  principal: { kind: 'human', id: 'human:local:seed' },
  grant: { kind: 'operator' },
};

function stubFetch(
  handler: (url: string, init?: RequestInit) => Promise<Response>,
) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: unknown, init?: RequestInit) =>
      handler(String(input), init),
    ),
  );
}

function listResponse(data: unknown): Response {
  return new Response(JSON.stringify({ success: true, data }));
}

// NOTE: no localStorage.clear() here — the shared ConnectionStore
// singleton persists through it, and wiping its storage mid-file leaves
// the store with rows but no active pointer. Inter-test isolation comes
// from the afterEach below (reset + remove created rows).

afterEach(async () => {
  // Return the shared singleton to its seeded Default and remove every home
  // this file created, so no test inherits another's rows or credentials.
  await act(async () => {
    connections?.resetToDefault();
    for (const id of createdHomeIds.splice(0)) {
      connections?.removeCredential(id);
      connections?.removeConnection(id);
    }
  });
  connections = undefined;
  vi.unstubAllGlobals();
  vi.mocked(resolveLocalUiSession).mockReset();
  vi.mocked(resolveLocalUiSession).mockResolvedValue({
    kind: 'host-unavailable',
  });
});

describe('authority query isolation (real provider tree, mocked wire)', () => {
  it('verifies the first authority with its captured scope and serves its data from a namespaced shelf', async () => {
    const harness = createHarness();
    harness.observationPlan.set('default', async () => OBS_DEFAULT);
    const { unmount } = renderTree(harness);
    const { id: idA, url: urlA } = await addHome('homea');
    harness.observationPlan.set(urlA, async () => OBS_A);
    await switchTo(idA);

    await waitFor(() =>
      expect(probe().getAttribute('data-status')).toBe('verified'),
    );
    await waitFor(() =>
      expect(probe().getAttribute('data-projects')).toContain(idA),
    );
    // The observation read carried the captured, non-secret request scope.
    expect(harness.observationCalls.length).toBeGreaterThan(0);
    expect(harness.observationCalls[0]?.authorityKey.length).toBeGreaterThan(0);
    expect(probe().getAttribute('data-namespace')).toBe(NS_A);
    await waitFor(() =>
      expect(harness.asyncStorage.data.has(authorityPersistenceKey(NS_A))).toBe(
        true,
      ),
    );
    unmount();
  });

  it('two homes sharing project ids never collide; returning restores without refetch', async () => {
    const harness = createHarness();
    harness.observationPlan.set('default', async () => OBS_DEFAULT);
    const { unmount } = renderTree(harness);
    const { id: idA, url: urlA } = await addHome('homea');
    const { id: idB, url: urlB } = await addHome('homeb');
    harness.observationPlan.set(urlA, async () => OBS_A);
    harness.observationPlan.set(urlB, async () => OBS_B);
    await switchTo(idA);

    await waitFor(() =>
      expect(probe().getAttribute('data-projects')).toContain(idA),
    );
    const fetchesAfterA = harness.projectFetches.length;

    await switchTo(idB);
    await waitFor(() =>
      expect(probe().getAttribute('data-projects')).toContain(idB),
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

    await switchTo(idA);
    await waitFor(() =>
      expect(probe().getAttribute('data-projects')).toContain(idA),
    );
    await waitFor(() =>
      expect(probe().getAttribute('data-status')).toBe('verified'),
    );
    // Restored from A's own blob — no refetch for the return trip.
    expect(harness.projectFetches.length).toBe(fetchesAfterA + 1);
    unmount();
  });

  it("#2309: switching Station forgets the previous Station's activity records", async () => {
    const harness = createHarness();
    harness.observationPlan.set('default', async () => OBS_DEFAULT);
    const { unmount } = renderTree(harness);
    const { id: idA, url: urlA } = await addHome('homea');
    const { id: idB, url: urlB } = await addHome('homeb');
    harness.observationPlan.set(urlA, async () => OBS_A);
    harness.observationPlan.set(urlB, async () => OBS_B);
    await switchTo(idA);
    await waitFor(() =>
      expect(probe().getAttribute('data-namespace')).toBe(NS_A),
    );

    const conversationId = 'claude:conv-authority-2309';
    activeChatsStore.initChat(conversationId, {
      agentSlug: 'dev-agent',
      agentName: 'Dev Agent',
      title: 'Authority',
      conversationId,
    });
    // Station A's record, at A's sequence.
    act(() =>
      activeChatsStore.applyConversationActivity({
        conversationId,
        asOfSequence: 9_000,
        openTurn: {
          turnId: 'a-turn',
          threadId: `${conversationId}:child`,
          startedAt: '2026-09-22T18:55:25.000Z',
        },
      }),
    );

    // Station A's older-server fallback state too: its turn fold and the
    // start this client witnessed.
    act(() =>
      activeChatsStore.updateChat(conversationId, {
        orchestrationTurnOpen: true,
        openTurnStartedAt: Date.parse('2026-09-22T18:55:25.000Z'),
      }),
    );

    await switchTo(idB);
    await waitFor(() =>
      expect(probe().getAttribute('data-namespace')).toBe(NS_B),
    );
    const afterSwitch = activeChatsStore.getSnapshot()[conversationId];
    expect(afterSwitch?.conversationActivity).toBeUndefined();
    // Nothing of A's is left for the fallback clock or liveness to read.
    expect(afterSwitch?.openTurnStartedAt).toBeUndefined();
    expect(afterSwitch?.orchestrationTurnOpen).toBeUndefined();
    expect(isTurnInFlight(afterSwitch)).toBe(false);
    // Station B's lower sequence is accepted, not rejected as older than A's.
    act(() =>
      activeChatsStore.applyConversationActivity({
        conversationId,
        asOfSequence: 12,
      }),
    );
    expect(
      activeChatsStore.getSnapshot()[conversationId]?.conversationActivity
        ?.asOfSequence,
    ).toBe(12);
    activeChatsStore.removeChat(conversationId);
    unmount();
  });

  it('station#2530 review D7: a real A→B→A switch dispatches the orchestration-authority-change event, not just a direct-call reconstruction of it', async () => {
    // ensureOrchestrationEventStream.recovery.test.ts drives the LISTENER
    // side of this by dispatching the CustomEvent directly — it never
    // renders `AuthorityQueryContext`, so it cannot prove the provider
    // itself still fires it on a real switch. This test renders the real
    // provider tree and drives the real switch path
    // (`connections.setActiveConnection`, exactly what a Station switch in
    // the app does), and would fail if the dispatch in
    // `AuthorityQueryContext.tsx` were ever deleted.
    const harness = createHarness();
    harness.observationPlan.set('default', async () => OBS_DEFAULT);
    const { unmount } = renderTree(harness);
    const { id: idA, url: urlA } = await addHome('homea-d7');
    const { id: idB, url: urlB } = await addHome('homeb-d7');
    harness.observationPlan.set(urlA, async () => OBS_A);
    harness.observationPlan.set(urlB, async () => OBS_B);

    await switchTo(idA);
    await waitFor(() =>
      expect(probe().getAttribute('data-namespace')).toBe(NS_A),
    );

    // The FIRST ever verified namespace never dispatches — there is no
    // prior verified namespace to announce a change FROM
    // (`lastVerifiedNamespaceRef.current !== undefined`) — so the listener
    // is only armed once A's own initial verification has already settled.
    const authorityChangeDetails: string[] = [];
    const onAuthorityChange = (event: Event) => {
      authorityChangeDetails.push(
        String((event as CustomEvent<string>).detail),
      );
    };
    window.addEventListener(
      'station:orchestration-authority-change',
      onAuthorityChange,
    );
    try {
      await switchTo(idB);
      await waitFor(() =>
        expect(probe().getAttribute('data-namespace')).toBe(NS_B),
      );
      await waitFor(() => expect(authorityChangeDetails.length).toBe(1));

      await switchTo(idA);
      await waitFor(() =>
        expect(probe().getAttribute('data-namespace')).toBe(NS_A),
      );
      await waitFor(() => expect(authorityChangeDetails.length).toBe(2));
    } finally {
      window.removeEventListener(
        'station:orchestration-authority-change',
        onAuthorityChange,
      );
    }
    unmount();
  });

  it('#2309: a re-verify of the SAME Station (a transient unverified gap) keeps the activity records', async () => {
    const harness = createHarness();
    harness.observationPlan.set('default', async () => OBS_DEFAULT);
    const { unmount } = renderTree(harness);
    const { id: idA, url: urlA } = await addHome('homea');
    const reverified = deferred<AuthorityObservation>();
    let rotated = false;
    harness.observationPlan.set(urlA, async () =>
      rotated ? reverified.promise : OBS_A,
    );
    await switchTo(idA);
    await waitFor(() =>
      expect(probe().getAttribute('data-namespace')).toBe(NS_A),
    );
    const conversationId = 'claude:conv-reverify-2309';
    activeChatsStore.initChat(conversationId, {
      agentSlug: 'dev-agent',
      agentName: 'Dev Agent',
      title: 'Reverify',
      conversationId,
    });
    act(() =>
      activeChatsStore.applyConversationActivity({
        conversationId,
        asOfSequence: 77,
        openTurn: {
          turnId: 'still-running',
          threadId: `${conversationId}:child`,
          startedAt: '2026-09-22T18:55:25.000Z',
        },
      }),
    );

    rotated = true;
    await act(async () => {
      connections?.setCredential(idA, 'cred-rotated-same-principal');
    });
    // The gap: nothing verified.
    await waitFor(() => expect(screen.queryByTestId('probe')).toBeNull());
    expect(
      activeChatsStore.getSnapshot()[conversationId]?.conversationActivity
        ?.asOfSequence,
    ).toBe(77);
    await act(async () => {
      reverified.resolve(OBS_A);
    });
    await waitFor(() =>
      expect(probe().getAttribute('data-namespace')).toBe(NS_A),
    );
    // Same Station: its sequences still compare, so the record stays.
    expect(
      activeChatsStore.getSnapshot()[conversationId]?.conversationActivity
        ?.asOfSequence,
    ).toBe(77);
    activeChatsStore.removeChat(conversationId);
    unmount();
  });

  it('same observed home, different principals partition (endpoint text is not identity)', async () => {
    // NOTE: the store normalizes endpoint paths away, so two rows cannot
    // share one origin through the product API at all — the closest
    // expressible case is two endpoints whose CLOSED observations name the
    // SAME home with DIFFERENT principals/grants. The namespace must still
    // partition (and endpoint-text exclusion itself is pinned by the
    // namespace unit tests, which assert origins never enter the tuple).
    const harness = createHarness();
    harness.observationPlan.set('default', async () => OBS_DEFAULT);
    const { unmount } = renderTree(harness);
    const { id: idA, url: urlA } = await addHome('homea');
    const { id: idA2, url: urlA2 } = await addHome('homea-second-user');
    expect(OBS_A.environmentId).toBe(OBS_A2.environmentId);
    harness.observationPlan.set(urlA, async () => OBS_A);
    harness.observationPlan.set(urlA2, async () => OBS_A2);
    await switchTo(idA);

    await waitFor(() =>
      expect(probe().getAttribute('data-namespace')).toBe(NS_A),
    );
    await switchTo(idA2);
    await waitFor(() =>
      expect(probe().getAttribute('data-namespace')).toBe(NS_A2),
    );
    expect(NS_A2).not.toBe(NS_A);
    await waitFor(() =>
      expect(
        harness.asyncStorage.data.has(authorityPersistenceKey(NS_A2)),
      ).toBe(true),
    );
    unmount();
  });

  it('a late read from the retired authority never paints (delayed fetcher discrimination)', async () => {
    const harness = createHarness();
    harness.observationPlan.set('default', async () => OBS_DEFAULT);
    const { unmount } = renderTree(harness);
    const { id: idA, url: urlA } = await addHome('homea');
    const { id: idB, url: urlB } = await addHome('homeb');
    harness.observationPlan.set(urlA, async () => OBS_A);
    harness.observationPlan.set(urlB, async () => OBS_B);
    // Hold A's FIRST project read open past the switch to B.
    const projectsA = deferred<ProjectList>();
    harness.projectPlan.set(idA, () => projectsA.promise);
    await switchTo(idA);
    await waitFor(() =>
      expect(probe().getAttribute('data-status')).toBe('verified'),
    );
    expect(probe().getAttribute('data-projects')).toBe('pending');

    await switchTo(idB);
    await waitFor(() =>
      expect(probe().getAttribute('data-projects')).toContain(idB),
    );
    // A's retired read resolves late into a retired, observerless cache.
    await act(async () => {
      projectsA.resolve(projectListFor(idA));
    });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(probe().getAttribute('data-projects')).toContain(idB);
    expect(probe().getAttribute('data-namespace')).toBe(NS_B);
    // The retired client persisted nothing paintable: either it never
    // wrote, or its shelf holds no project data.
    const nsABlob = harness.asyncStorage.data.get(
      authorityPersistenceKey(NS_A),
    );
    if (nsABlob !== undefined) expect(nsABlob).not.toContain(idA);
    unmount();
  });

  it('a retired legacy fetcher resolving the real global origin late dispatches nothing', async () => {
    const harness = createHarness();
    harness.observationPlan.set('default', async () => OBS_DEFAULT);
    harness.legacyGate = deferred<unknown>();
    stubFetch(async (url, init) => {
      // Spec behavior: an aborted signal rejects BEFORE dispatch.
      if (init?.signal?.aborted)
        throw new DOMException('aborted', 'AbortError');
      harness.dispatches.push({ url });
      return new Response(JSON.stringify([]));
    });
    const { unmount } = renderTree(harness);
    const { id: idA, url: urlA } = await addHome('homea');
    const { id: idB, url: urlB } = await addHome('homeb');
    harness.observationPlan.set(urlA, async () => OBS_A);
    harness.observationPlan.set(urlB, async () => OBS_B);
    await switchTo(idA);
    await waitFor(() =>
      expect(probe().getAttribute('data-status')).toBe('verified'),
    );
    expect(probe().getAttribute('data-legacy')).toBe('pending');
    expect(harness.dispatches).toHaveLength(0);

    // Switch while the legacy base resolution is still held open. The
    // bridge commits the new global origin on render; retirement cancels.
    await switchTo(idB);
    await waitFor(() =>
      expect(probe().getAttribute('data-namespace')).toBe(NS_B),
    );
    expect(await _getApiBase()).toContain('homeb-');

    // Release the held resolution. The retired fetch observes the NEW
    // global origin (proving the hazard was real)…
    await act(async () => {
      harness.legacyGate?.resolve(null);
    });
    // …while B's own tree runs the identical query legitimately. Every
    // parked fetch (Default's, A's, B's own) observes the NEW global origin
    // — the hazard was real — yet exactly one dispatch, the current
    // authority's own, may occur: the retired ones' signals aborted at
    // retirement and never dispatch.
    await waitFor(() =>
      expect(probe().getAttribute('data-legacy')).toBe('success'),
    );
    expect(harness.legacyResolutions.length).toBeGreaterThanOrEqual(2);
    expect(
      harness.legacyResolutions.every((base) => base.includes('homeb-')),
    ).toBe(true);
    expect(harness.dispatches).toHaveLength(1);
    expect(harness.dispatches[0]?.url).toContain('homeb-');
    unmount();
  });

  it('fast A->B->A with a delayed B observation never activates B', async () => {
    const harness = createHarness();
    harness.observationPlan.set('default', async () => OBS_DEFAULT);
    const { unmount } = renderTree(harness);
    const { id: idA, url: urlA } = await addHome('homea');
    const { id: idB, url: urlB } = await addHome('homeb');
    const observationB = deferred<AuthorityObservation>();
    harness.observationPlan.set(urlA, async () => OBS_A);
    harness.observationPlan.set(urlB, () => observationB.promise);
    await switchTo(idA);

    await waitFor(() =>
      expect(probe().getAttribute('data-namespace')).toBe(NS_A),
    );
    await switchTo(idB);
    // B's observation is still in flight — honest loading, not A's data.
    await waitFor(() =>
      expect(screen.queryByText(/Verifying Station authority/i)).not.toBeNull(),
    );
    await switchTo(idA);
    // A re-verifies with a live read on return.
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
    unmount();
  });

  it('A->B->A with a changed A principal re-reads and opens a new shelf (no cached revival)', async () => {
    const harness = createHarness();
    harness.observationPlan.set('default', async () => OBS_DEFAULT);
    const { unmount } = renderTree(harness);
    const { id: idA, url: urlA } = await addHome('homea');
    const { id: idB, url: urlB } = await addHome('homeb');
    let rotated = false;
    const returnedObservation = deferred<AuthorityObservation>();
    harness.observationPlan.set(urlA, async () =>
      rotated ? returnedObservation.promise : OBS_A,
    );
    harness.observationPlan.set(urlB, async () => OBS_B);
    await switchTo(idA);
    await waitFor(() =>
      expect(probe().getAttribute('data-namespace')).toBe(NS_A),
    );

    // Establish the persistence prerequisite before leaving A. Verification
    // renders before the async persister writes; switching immediately can
    // legitimately retire A before any shelf was created.
    await waitFor(() =>
      expect(harness.asyncStorage.data.has(authorityPersistenceKey(NS_A))).toBe(
        true,
      ),
    );

    await switchTo(idB);
    await waitFor(() =>
      expect(probe().getAttribute('data-namespace')).toBe(NS_B),
    );
    const callsBeforeReturn = harness.observationCalls.length;
    // A's device is revoked and re-paired as a new identity while on B.
    rotated = true;
    await switchTo(idA);
    await waitFor(() =>
      expect(harness.observationCalls.length).toBeGreaterThan(
        callsBeforeReturn,
      ),
    );
    try {
      // Cached A must not expose a verified subtree while its NEW identity
      // observation is still pending, even if React Query has old success data.
      expect(screen.queryByTestId('probe')).toBeNull();
    } finally {
      await act(async () => returnedObservation.resolve(OBS_A_ROTATED));
    }
    // The return trip performs a CURRENT read: new principal, new shelf —
    // the cached observation never counts as verification.
    await waitFor(() =>
      expect(probe().getAttribute('data-namespace')).toBe(NS_A_ROTATED),
    );
    expect(probe().getAttribute('data-status')).toBe('verified');
    expect(harness.observationCalls.length).toBeGreaterThan(callsBeforeReturn);
    // The previous shelf is retained on disk, untouched by the rotation.
    expect(harness.asyncStorage.data.has(authorityPersistenceKey(NS_A))).toBe(
      true,
    );
    unmount();
  });

  it('same-connection credential rotation re-reads with a loading gap (no cached revival)', async () => {
    const harness = createHarness();
    harness.observationPlan.set('default', async () => OBS_DEFAULT);
    const { unmount } = renderTree(harness);
    const { id: idA, url: urlA } = await addHome('homea');
    const rotatedObservation = deferred<AuthorityObservation>();
    let rotated = false;
    harness.observationPlan.set(urlA, async () =>
      rotated ? rotatedObservation.promise : OBS_A,
    );
    await switchTo(idA);
    await waitFor(() =>
      expect(probe().getAttribute('data-namespace')).toBe(NS_A),
    );
    // Establish the persistence prerequisite before rotating. Verification
    // renders before the async persister writes; rotating immediately can
    // legitimately retire A before any shelf was created, which reads as a
    // missing shelf under load.
    await waitFor(() =>
      expect(harness.asyncStorage.data.has(authorityPersistenceKey(NS_A))).toBe(
        true,
      ),
    );
    const callsBefore = harness.observationCalls.length;

    // Same endpoint, same row, new credential through the REAL Connections
    // API (`setCredential` bumps the authority generation, re-keying
    // observation): the rotation gap must be honest loading, never Alice's
    // old verified subtree, even though React Query still holds her cached
    // success for the previous key.
    rotated = true;
    await act(async () => {
      connections?.setCredential(idA, 'cred-rotated');
    });
    await waitFor(() =>
      expect(harness.observationCalls.length).toBeGreaterThan(callsBefore),
    );
    expect(screen.queryByTestId('probe')).toBeNull();
    await act(async () => {
      rotatedObservation.resolve(OBS_A_ROTATED);
    });
    await waitFor(() =>
      expect(probe().getAttribute('data-namespace')).toBe(NS_A_ROTATED),
    );
    expect(probe().getAttribute('data-status')).toBe('verified');
    // The previous shelf is retained on disk, untouched by the rotation.
    expect(harness.asyncStorage.data.has(authorityPersistenceKey(NS_A))).toBe(
      true,
    );
    unmount();
  });

  it('consecutive unverified fallbacks mount fresh clients (colliding keys)', async () => {
    const harness = createHarness();
    const offline = async (): Promise<AuthorityObservation> => {
      throw new TypeError('fetch failed');
    };
    harness.observationPlan.set('default', offline);
    const { unmount } = renderTree(harness);
    const { id: idA, url: urlA } = await addHome('homea');
    const { id: idB, url: urlB } = await addHome('homeb');
    harness.observationPlan.set(urlA, offline);
    harness.observationPlan.set(urlB, offline);
    harness.projectPlan.set(idA, async () => projectListFor(idA));
    harness.projectPlan.set(idB, async () => projectListFor(idB));

    await switchTo(idA);
    await waitFor(() =>
      expect(probe().getAttribute('data-status')).toBe('unverified'),
    );
    await waitFor(() =>
      expect(probe().getAttribute('data-projects')).toContain(idA),
    );

    // The same `observationFailed` branch renders for a different home: the
    // ephemeral client MUST be bound to the current live context, or its
    // `['projects']` cache would serve A's rows under B.
    await switchTo(idB);
    await waitFor(() =>
      expect(probe().getAttribute('data-projects')).toContain(idB),
    );
    expect(probe().getAttribute('data-projects')).not.toContain(idA);
    expect(probe().getAttribute('data-namespace')).toBe('');
    expect(harness.projectFetches[harness.projectFetches.length - 1]).toBe(idB);
    unmount();
  });

  it("a delayed boot payload never seeds another identity's shelf", async () => {
    const urlA = homeUrl('homea');
    const harness = createHarness();
    harness.observationPlan.set('default', async () => OBS_DEFAULT);
    const bootGate = deferred<unknown>();
    const bootPayload = {
      version: 1,
      sections: {
        projects: {
          data: [{ id: 'p1', home: 'boot-A-marker' }],
          success: true,
        },
      },
    };
    stubFetch(async (url) => {
      if (url.endsWith('/api/boot')) {
        await bootGate.promise;
        return new Response(JSON.stringify(bootPayload));
      }
      return new Response('not found', { status: 404 });
    });
    vi.mocked(resolveLocalUiSession).mockResolvedValueOnce({
      kind: 'authenticated',
    });
    const { unmount } = renderTree(harness, { localUiApiBase: urlA });
    const { id: idA } = await addHome('homea', urlA);
    const { id: idB, url: urlB } = await addHome('homeb');
    harness.observationPlan.set(urlA, async () => OBS_A);
    harness.observationPlan.set(urlB, async () => OBS_B);
    await switchTo(idA);
    await waitFor(() =>
      expect(probe().getAttribute('data-namespace')).toBe(NS_A),
    );
    // A's seed holds its boot fetch (at A's captured origin) open…
    await waitFor(() => {
      const calls = (globalThis.fetch as unknown as ReturnType<typeof vi.fn>)
        .mock.calls;
      expect(
        calls.some(([called]) => String(called).endsWith('/api/boot')),
      ).toBe(true);
    });

    // …while the page verifies B. The late payload resolves into a lapsed
    // scope, so every guarded write drops: B's live rows stay B's, and
    // neither shelf gains A's boot marker.
    await switchTo(idB);
    await waitFor(() =>
      expect(probe().getAttribute('data-namespace')).toBe(NS_B),
    );
    await act(async () => {
      bootGate.resolve(null);
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(probe().getAttribute('data-projects')).toContain(idB);
    expect(probe().getAttribute('data-projects')).not.toContain(
      'boot-A-marker',
    );
    for (const ns of [NS_A, NS_B]) {
      const blob = harness.asyncStorage.data.get(authorityPersistenceKey(ns));
      if (blob !== undefined) expect(blob).not.toContain('boot-A-marker');
    }
    unmount();
  });

  it('a real signal-ignoring SDK caller discards its late result and persists nothing', async () => {
    const harness = createHarness();
    harness.observationPlan.set('default', async () => OBS_DEFAULT);
    harness.mountUserProbe = true;
    const userGate = deferred<unknown>();
    harness.userGate = userGate;
    stubFetch(async (url) => {
      if (url.includes('/api/users/')) {
        // Held open across the switch: both instances' responses resolve
        // only after B is live.
        await userGate.promise;
        harness.dispatches.push({ url });
        const tag = url.includes('homea-') ? 'user-of-A' : 'user-of-B';
        return new Response(JSON.stringify({ user: tag }));
      }
      return new Response('not found', { status: 404 });
    });
    const { unmount } = renderTree(harness);
    const { id: idA, url: urlA } = await addHome('homea');
    const { id: idB, url: urlB } = await addHome('homeb');
    harness.observationPlan.set(urlA, async () => OBS_A);
    harness.observationPlan.set(urlB, async () => OBS_B);
    await switchTo(idA);
    await waitFor(() =>
      expect(probe().getAttribute('data-namespace')).toBe(NS_A),
    );
    // A's lookup resolved the pre-switch global and holds its response.
    await waitFor(() => {
      const calls = (globalThis.fetch as unknown as ReturnType<typeof vi.fn>)
        .mock.calls;
      expect(
        calls.some(([called]) => String(called).includes('/api/users/')),
      ).toBe(true);
    });

    // `useUserLookup` threads no AbortSignal, so retirement cancellation
    // cannot abort it — the honest boundary is effect-unmount discard (the
    // provider remounts children on namespace change) plus never writing
    // to any query cache.
    await switchTo(idB);
    await waitFor(() =>
      expect(probe().getAttribute('data-namespace')).toBe(NS_B),
    );
    await act(async () => {
      userGate.resolve(null);
    });
    await waitFor(() =>
      expect(
        screen.getByTestId('user-probe').getAttribute('data-user'),
      ).toContain('user-of-B'),
    );
    expect(
      screen.getByTestId('user-probe').getAttribute('data-user'),
    ).not.toContain('user-of-A');
    // Each instance bound the global that was current for its own mount —
    // no instance dispatched under the other's authority…
    const userDispatches = harness.dispatches
      .map((dispatch) => dispatch.url)
      .filter((url) => url.includes('/api/users/'));
    expect(userDispatches.some((url) => url.includes('homea-'))).toBe(true);
    expect(userDispatches.some((url) => url.includes('homeb-'))).toBe(true);
    // …and the hook persists nothing anywhere: neither shelf holds either
    // payload, because `useUserLookup` never writes to a query cache.
    for (const ns of [NS_A, NS_B]) {
      const blob = harness.asyncStorage.data.get(authorityPersistenceKey(ns));
      if (blob !== undefined) {
        expect(blob).not.toContain('user-of-A');
        expect(blob).not.toContain('user-of-B');
      }
    }
    unmount();
  });

  it('revocation re-observes, quarantines persistence, and retains the blob (no silent loss)', async () => {
    // The production revocation loop, end to end: a live scoped read gets
    // a 401 → the SDK reports it through the installed resolver → the
    // store flips the credential → re-observation fails closed.
    let listRevoked = false;
    stubFetch(async (url) => {
      if (url.endsWith('/api/projects')) {
        if (listRevoked) return new Response('denied', { status: 401 });
        return listResponse([{ slug: 'shared-slug', name: 'A' }]);
      }
      return new Response('not found', { status: 404 });
    });
    const harness = createHarness();
    harness.observationPlan.set('default', async () => OBS_DEFAULT);
    harness.mountReloadProbe = true;
    const { unmount } = renderTree(harness);
    const { id: idA, url: urlA } = await addHome('homea');
    let revoked = false;
    harness.observationPlan.set(urlA, async () => {
      if (revoked) throw UNAUTHORIZED;
      return OBS_A;
    });
    await switchTo(idA);

    const reloadProbe = () => screen.getByTestId('reload-probe');
    await waitFor(() =>
      expect(probe().getAttribute('data-status')).toBe('verified'),
    );
    await waitFor(() =>
      expect(reloadProbe().getAttribute('data-reload')).toContain(
        'shared-slug',
      ),
    );
    await waitFor(() =>
      expect(harness.asyncStorage.data.has(authorityPersistenceKey(NS_A))).toBe(
        true,
      ),
    );

    // Install a saved credential (itself a re-observing generation bump),
    // then have the live read rejected: the 401 travels the real reporting
    // path, not a direct store poke.
    await act(async () => {
      connections?.setCredential(idA, 'cred-1');
    });
    await waitFor(() =>
      expect(probe().getAttribute('data-status')).toBe('verified'),
    );
    const observationCallsBefore = harness.observationCalls.length;
    expect(observationCallsBefore).toBeGreaterThan(1);

    revoked = true;
    listRevoked = true;
    fireEvent.click(screen.getByTestId('reload-refetch'));
    // The credential transition re-drove observation, which failed closed.
    await waitFor(() =>
      expect(probe().getAttribute('data-status')).toBe('unavailable'),
    );
    expect(harness.observationCalls.length).toBeGreaterThan(
      observationCallsBefore,
    );
    expect(probe().getAttribute('data-namespace')).toBe('');
    // The revoked rows are no longer served…
    await waitFor(() =>
      expect(reloadProbe().getAttribute('data-reload')).toBe('error'),
    );
    // …and the authorized blob is retained verbatim — quarantine, not deletion.
    expect(harness.asyncStorage.data.has(authorityPersistenceKey(NS_A))).toBe(
      true,
    );
    unmount();
  });

  it('offline with no observation shows zero A rows and retains the blob byte-identical', async () => {
    const harness = createHarness();
    harness.observationPlan.set('default', async () => OBS_DEFAULT);
    const first = renderTree(harness);
    const { id: idA, url: urlA } = await addHome('homea');
    harness.observationPlan.set(urlA, async () => OBS_A);
    await switchTo(idA);
    await waitFor(() =>
      expect(probe().getAttribute('data-status')).toBe('verified'),
    );
    await waitFor(() =>
      expect(probe().getAttribute('data-projects')).toContain(idA),
    );
    await waitFor(() =>
      expect(harness.asyncStorage.data.has(authorityPersistenceKey(NS_A))).toBe(
        true,
      ),
    );
    const retainedBlob = harness.asyncStorage.data.get(
      authorityPersistenceKey(NS_A),
    );
    expect(retainedBlob).toBeDefined();
    first.unmount();

    // Cold boot with the wire down: the stored tuple must NOT be hydrated
    // or shown under unverified authority — a flag cannot quarantine a
    // blob once mounted children can read it. Zero A rows, blob intact.
    const offline = async () => {
      throw new TypeError('fetch failed');
    };
    harness.observationPlan.set(urlA, offline);
    harness.observationPlan.set('default', offline);
    harness.networkUp = false;
    renderTree(harness);
    await waitFor(() =>
      expect(probe().getAttribute('data-status')).toBe('unverified'),
    );
    expect(probe().getAttribute('data-namespace')).toBe('');
    // The read fails honestly (no silent stale rows)…
    await waitFor(() =>
      expect(probe().getAttribute('data-projects')).toBe('error'),
    );
    expect(probe().getAttribute('data-projects')).not.toContain(idA);
    expect(probe().getAttribute('data-agents')).toBe('null');
    expect(harness.asyncStorage.data.get(authorityPersistenceKey(NS_A))).toBe(
      retainedBlob,
    );
  });

  it('a black-holed observation read fails bounded onto the repair path with nothing restored', async () => {
    // The PRODUCTION observation read (real `getAuthorityObservation`,
    // seam deadline overridden to 200ms) against a fake host that answers
    // the seeded Default row but accepts-and-never-answers the new home —
    // a black hole, not a refusal. Without the seam's explicit timeout the
    // React Query caller signal alone disables the SDK deadline and this
    // hangs forever; with it the read fails bounded as observation loss:
    // status 'unverified' (not 401-'unavailable'), repair children mounted
    // on a fresh ephemeral client, no namespace, no prior rows — and a
    // later good read still verifies (the client is not poisoned).
    const harness = createHarness();
    // Installed before mount (mount observes Default immediately): answers
    // everything until the hung home's URL is assigned after `addHome`.
    let hungUrl = '';
    stubFetch(async (url, init) => {
      if (hungUrl !== '' && url.startsWith(hungUrl)) {
        // Faithful black hole: like a real socket that never answers, the
        // read settles only when the composed signal aborts (deadline or
        // caller cancel), exactly as real `fetch` behaves.
        const signal = init?.signal;
        if (signal?.aborted) throw new DOMException('aborted', 'AbortError');
        await new Promise<void>((_, reject) => {
          signal?.addEventListener(
            'abort',
            () => reject(new DOMException('aborted', 'AbortError')),
            { once: true },
          );
        });
        throw new DOMException('aborted', 'AbortError');
      }
      return new Response(JSON.stringify(OBS_DEFAULT), {
        headers: { 'content-type': 'application/json' },
      });
    });
    const { unmount } = renderTree(harness, {
      defaultObservation: true,
      observationTimeoutMs: 200,
    });
    const defaultId = connections?.activeConnection?.id ?? '';
    expect(defaultId).not.toBe('');
    const { id: idH, url: urlH } = await addHome('hung');
    hungUrl = urlH;
    // Default verifies through the production read first.
    await waitFor(() =>
      expect(probe().getAttribute('data-status')).toBe('verified'),
    );
    expect(probe().getAttribute('data-namespace')).toBe(
      buildAuthorityNamespace(OBS_DEFAULT),
    );
    const keysBeforeHang = [...harness.asyncStorage.data.keys()].sort();

    await switchTo(idH);
    // Bounded failure, not a hang: the repair path mounts with no identity.
    await waitFor(() =>
      expect(probe().getAttribute('data-status')).toBe('unverified'),
    );
    expect(probe().getAttribute('data-namespace')).toBe('');
    expect(probe().getAttribute('data-agents')).toBe('null');
    // Fresh ephemeral client: none of the previous authority's rows leak
    // into the hung home's tree (the probe stub's own current-id rows are
    // fresh fetches, not restored shelves).
    expect(probe().getAttribute('data-projects')).not.toContain(defaultId);
    // The failure persisted nothing and deleted nothing.
    expect([...harness.asyncStorage.data.keys()].sort()).toEqual(
      keysBeforeHang,
    );

    // Recoverable: returning to Default re-verifies through a fresh read.
    await switchTo(defaultId);
    await waitFor(() =>
      expect(probe().getAttribute('data-status')).toBe('verified'),
    );
    expect(probe().getAttribute('data-namespace')).toBe(
      buildAuthorityNamespace(OBS_DEFAULT),
    );
    unmount();
  });

  it('the legacy singleton blob is quarantined: never adopted, never deleted', async () => {
    const harness = createHarness();
    harness.observationPlan.set('default', async () => OBS_DEFAULT);
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
    const { unmount } = renderTree(harness);
    const { id: idA, url: urlA } = await addHome('homea');
    harness.observationPlan.set(urlA, async () => OBS_A);
    await switchTo(idA);

    await waitFor(() =>
      expect(probe().getAttribute('data-status')).toBe('verified'),
    );
    // Live data, not the ghost: the legacy shelf was never hydrated.
    expect(probe().getAttribute('data-agents')).toBe('null');
    // And never destroyed either: byte-identical on disk.
    expect(harness.asyncStorage.data.get(QUERY_PERSISTENCE_STORAGE_KEY)).toBe(
      legacyBlob,
    );
    unmount();
  });

  it('mutations are never hydrated from a stored blob', async () => {
    const harness = createHarness();
    harness.observationPlan.set('default', async () => OBS_DEFAULT);
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
    const { unmount } = renderTree(harness);
    const { id: idA, url: urlA } = await addHome('homea');
    harness.observationPlan.set(urlA, async () => OBS_A);
    await switchTo(idA);

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
    unmount();
  });

  it('namespace survives epoch-neutral store churn without refetch or key fork', async () => {
    const harness = createHarness();
    harness.observationPlan.set('default', async () => OBS_DEFAULT);
    const { unmount } = renderTree(harness);
    const { id: idA, url: urlA } = await addHome('homea');
    harness.observationPlan.set(urlA, async () => OBS_A);
    await switchTo(idA);

    await waitFor(() =>
      expect(probe().getAttribute('data-namespace')).toBe(NS_A),
    );
    // A's shelf is on disk before the churn, so "exactly A's key" below
    // cannot pass merely because the first write had not landed yet.
    await waitFor(() =>
      expect(harness.asyncStorage.data.has(authorityPersistenceKey(NS_A))).toBe(
        true,
      ),
    );
    const callsAfterVerify = harness.observationCalls.length;

    await act(async () => {
      connections?.updateConnection(idA, { name: 'Renamed HomeA' });
    });
    // The persister writes only on a cache event, so without one after the
    // churn a forked key would never reach storage and the check below
    // could not see it.
    const shelf = harness.activeClient;
    if (!shelf) throw new Error('Probe never rendered under a client');
    await act(async () => {
      shelf.setQueryData(['churn-probe'], 1);
    });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(probe().getAttribute('data-namespace')).toBe(NS_A);
    expect(harness.observationCalls).toHaveLength(callsAfterVerify);
    // The seeded Default row verifies too, and its own shelf is written
    // whenever its throttled persist lands before the switch to A retires
    // it — a scheduling race, legitimately persisted either way (#2440).
    // A fork is a SECOND key for this home, so exclude only Default's.
    const persistKeys = [...harness.asyncStorage.data.keys()].filter(
      (key) =>
        key.startsWith(`${AUTHORITY_CACHE_KEY_PREFIX}::`) &&
        key !== authorityPersistenceKey(buildAuthorityNamespace(OBS_DEFAULT)),
    );
    expect(persistKeys).toEqual([authorityPersistenceKey(NS_A)]);
    unmount();
  });

  it('a real scoped Project read restores across a fresh activation without refetch (stable data identity)', async () => {
    stubFetch(async (url) => {
      if (url.endsWith('/api/projects')) {
        return listResponse([{ slug: 'shared-slug', name: 'A' }]);
      }
      return new Response('not found', { status: 404 });
    });
    const harness = createHarness();
    harness.observationPlan.set('default', async () => OBS_DEFAULT);
    harness.mountReloadProbe = true;
    const first = renderTree(harness);
    const { id: idA, url: urlA } = await addHome('homea');
    harness.observationPlan.set(urlA, async () => OBS_A);
    await switchTo(idA);

    const reloadProbe = () => screen.getByTestId('reload-probe');
    await waitFor(() =>
      expect(reloadProbe().getAttribute('data-reload')).toContain(
        'shared-slug',
      ),
    );
    // The durable-keyed entry persisted under the authority shelf…
    await waitFor(() => {
      const raw = harness.asyncStorage.data.get(authorityPersistenceKey(NS_A));
      expect(raw).toBeDefined();
      expect(raw as string).toContain('shared-slug');
    });
    const listFetchesAfterSave = (
      globalThis.fetch as unknown as ReturnType<typeof vi.fn>
    ).mock.calls.filter(([url]) =>
      String(url).endsWith('/api/projects'),
    ).length;
    // At least the authority's own read happened (the seeded Default row
    // may have read first under its own shelf — irrelevant here).
    expect(listFetchesAfterSave).toBeGreaterThanOrEqual(1);
    first.unmount();

    // Fresh activation (new tab epoch, same connection identity): the live
    // observation re-reads, but the STABLE data key hits the shelf.
    const observationCallsBefore = harness.observationCalls.length;
    renderTree(harness);
    await waitFor(() =>
      expect(reloadProbe().getAttribute('data-reload')).toContain(
        'shared-slug',
      ),
    );
    // Observation re-read (current verification)…
    expect(harness.observationCalls.length).toBeGreaterThan(
      observationCallsBefore,
    );
    // …while the Project list restored with zero new wire reads.
    const listFetchesAfterReload = (
      globalThis.fetch as unknown as ReturnType<typeof vi.fn>
    ).mock.calls.filter(([url]) =>
      String(url).endsWith('/api/projects'),
    ).length;
    expect(listFetchesAfterReload).toBe(listFetchesAfterSave);
  });
});
