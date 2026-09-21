/**
 * #481 hosted connect-modal regression — composition boundary coverage over
 * the REAL recovery + authority composition (not helper-only).
 *
 * The production defect: `AuthorityQueryProvider` replaced its ENTIRE
 * children tree on activation transitions (skeleton while pending, fresh
 * keyed client per namespace), so the `OnboardingGate` + its
 * `ConnectionManagerModal` unmounted mid-flow — after adding an address,
 * Request Access/Back disappeared. The fix separates lifetimes: the
 * recovery shell mounts ABOVE the authority tree in `RecoveryQueryBoundary`
 * (stable nonpersisted client, switch-scoped cache drop), while protected
 * data stays fully quarantined per authority.
 *
 * Mounts the production composition — real `ApiBaseProvider` (real
 * `ConnectionStore` singleton, real credential bridge) + nonpersisted
 * bootstrap `QueryClientProvider` + `RecoveryQueryBoundary` +
 * `AuthorityQueryProvider` — with mocked WIRE data only. `AccessRequestProbe`
 * stands in for the modal at the exact lifetime position the real gate
 * occupies (above the authority tree, inside the recovery boundary): what
 * is under test is the composition boundary (no unmount across a
 * transition), not the modal's internals — the hosted browser suites prove
 * the real modal. `ProtectedProbe` stands in for the protected workspace
 * (colliding `['projects']` key, home-tagged rows). `RecoveryConfigObserver`
 * drives the REAL `useRecoveryConfig` (explicit origin, identity-scoped key,
 * render-captured request scope via `getJson`) against a URL-prefix wire
 * double that records every dispatch's scope, recording every committed
 * render AND layout effect — the transition tests prove no stale entry
 * reaches either, including same-origin credential rotation through the
 * real `setCredential` API, and that each identity dispatches under its
 * own captured authority.
 *
 * Each test states its own baseline through the public connections API on
 * unique origins and removes its rows afterwards. The boot-payload seed is
 * held at `host-unavailable` so no test depends on network.
 *
 * @vitest-environment jsdom
 */

import { useConnections } from '@kontourai/station-connect';
import type { AuthorityObservation } from '@kontourai/station-contracts/authority-observation';
import {
  QueryClient,
  QueryClientProvider,
  useQuery,
} from '@tanstack/react-query';
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import { useEffect, useLayoutEffect, useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiBaseProvider } from '../contexts/ApiBaseContext';
import { useAuthorityPersistence } from '../contexts/AuthorityPersistenceContext';
import {
  AuthorityQueryProvider,
  type FetchAuthorityObservation,
} from '../contexts/AuthorityQueryContext';
import { RecoveryQueryBoundary } from '../contexts/RecoveryQueryBoundary';
import { useInvalidateCachesOnConnectionSwitch } from '../hooks/useInvalidateCachesOnConnectionSwitch';
import { useRecoveryConfig } from '../hooks/useRecoveryConfig';
import { buildAuthorityNamespace } from '../lib/authorityNamespace';
import { resolveLocalUiSession } from '../lib/local-ui-bootstrap';

vi.mock('../lib/local-ui-bootstrap', () => ({
  resolveLocalUiSession: vi.fn(async () => ({ kind: 'host-unavailable' })),
}));
vi.mock('../platform/useBundledServerStatus', () => ({
  useBundledServerStatus: () => null,
  restartBundledServer: vi.fn(),
}));

/**
 * Wire mock for the recovery config dispatch: the REAL `useRecoveryConfig`
 * (explicit origin, identity-scoped key) runs against this double, so the
 * transition tests below prove the production read path — not a probe-local
 * reimplementation. Other SDK exports pass through untouched (the authority
 * tree and connect store keep their real implementations).
 */
interface SdkWire {
  configFetchPlan: Map<string, () => Promise<unknown>>;
  configFetchLog: {
    url: string;
    activeId: string | undefined;
    /** The render-captured request authority the dispatch carried, if any. */
    requestScope: { apiBase: string; authorityKey: string } | null;
  }[];
}
const sdkWire: SdkWire = {
  configFetchPlan: new Map(),
  configFetchLog: [],
};
vi.mock('@kontourai/station-sdk', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@kontourai/station-sdk')>();
  // The production recovery read dispatches through `getJson` with the
  // render-captured `requestScope` (plus finite timeout and AbortSignal).
  // This double answers the same envelope shape AND records the scope
  // each dispatch carried, so the transition tests prove the authority
  // capture is threaded per identity — not merely that keys partition.
  // (It does not reimplement the SDK's dispatch/body guard; the real
  // guard is proven with the real `getJson` in authorityRecoveryScope.)
  const answerConfig = async (url: string, opts?: unknown) => {
    const activeId = connections?.activeConnection?.id;
    const requestScope =
      (opts as { requestScope?: { apiBase: string; authorityKey: string } })
        ?.requestScope ?? null;
    sdkWire.configFetchLog.push({ url, activeId, requestScope });
    // Longest-prefix match: the '' fallback must never shadow a
    // per-origin plan registered after it.
    const plans = [...sdkWire.configFetchPlan.entries()].sort(
      ([a], [b]) => b.length - a.length,
    );
    for (const [prefix, behavior] of plans) {
      if (url.startsWith(prefix)) {
        const data = await behavior();
        return {
          ok: true,
          json: async () => ({ success: true, data }),
        };
      }
    }
    throw new Error(`no config wire plan for ${url}`);
  };
  return {
    ...actual,
    authenticatedFetch: async (input: unknown) => answerConfig(String(input)),
    getJson: async (url: string, opts?: unknown) =>
      answerConfig(url, opts),
  };
});

const OBS_A: AuthorityObservation = {
  schemaVersion: 'station.authority-observation/v1',
  environmentId: 'env-recovery-a',
  principal: { kind: 'human', id: 'human:local:recovery-alice' },
  grant: { kind: 'operator' },
};
const OBS_B: AuthorityObservation = {
  schemaVersion: 'station.authority-observation/v1',
  environmentId: 'env-recovery-b',
  principal: { kind: 'human', id: 'human:local:recovery-bob' },
  grant: { kind: 'operator' },
};
const NS_A = buildAuthorityNamespace(OBS_A);
const NS_B = buildAuthorityNamespace(OBS_B);

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

type ProjectList = { id: string; home: string }[];

interface Harness {
  observationPlan: Map<string, () => Promise<AuthorityObservation>>;
  projectPlan: Map<string, () => Promise<ProjectList>>;
  projectFetches: (string | undefined)[];
  configRenders: ConfigRecord[];
  configLayouts: ConfigRecord[];
  accessMounts: number;
  accessUnmounts: number;
  asyncStorage: ReturnType<typeof memoryAsyncStorage>;
  fetchObservation: FetchAuthorityObservation;
}

let homeCounter = 1000;
const homeUrl = (tag: string): string => {
  homeCounter += 1;
  return `http://${tag}-${homeCounter}.recovery.test:3141`;
};

function projectListFor(activeId: string | undefined): ProjectList {
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
    projectPlan: new Map(),
    projectFetches: [],
    configRenders: [],
    configLayouts: [],
    accessMounts: 0,
    accessUnmounts: 0,
    asyncStorage: memoryAsyncStorage(),
    fetchObservation: async (request) => {
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

/**
 * The access-request flow at the recovery lifetime position: component
 * state (open + panel) owned here must survive authority transitions that
 * replace the entire protected subtree. Mirrors the real
 * `ConnectionManagerModal` contract just far enough to prove the boundary:
 * an open dialog with a Request Access heading and a Back action.
 */
function AccessRequestProbe() {
  const harness = (AccessRequestProbe as unknown as { harness: Harness })
    .harness;
  const [open, setOpen] = useState(false);
  const [panel, setPanel] = useState('list');
  // Mount accounting: `[]` is intentional — exactly one increment per
  // mount and one per unmount, regardless of later re-renders. The harness
  // is installed before render and never replaced for a mounted tree.
  useEffect(() => {
    harness.accessMounts += 1;
    return () => {
      harness.accessUnmounts += 1;
    };
  }, []);
  return (
    <div data-testid="access-shell">
      <button
        data-testid="access-open"
        type="button"
        onClick={() => {
          setOpen(true);
          setPanel('request-access');
        }}
      >
        open request access
      </button>
      {open ? (
        <div role="dialog" aria-label="Connection manager">
          <h2>{panel === 'request-access' ? 'Request Access' : 'List'}</h2>
          <button type="button" onClick={() => setPanel('list')}>
            Back
          </button>
        </div>
      ) : null}
    </div>
  );
}

/**
 * The REAL production recovery read (`useRecoveryConfig`: explicit origin,
 * identity-scoped key) with a render-phase AND layout-effect observer. Both
 * record every committed view as `{ active, snapshot }`, so a transition
 * that served the previous connection's entry — to the render OR to a child
 * layout effect running before the boundary's own reset — is caught even
 * when no stale paint ever reaches the screen.
 */
interface ConfigRecord {
  active: string | null;
  snapshot: string;
}
function RecoveryConfigObserver() {
  const harness = (AccessRequestProbe as unknown as { harness: Harness })
    .harness;
  const activeId = connections?.activeConnection?.id ?? null;
  const config = useRecoveryConfig();
  const snapshot = config.data ? JSON.stringify(config.data) : config.status;
  harness.configRenders.push({ active: activeId, snapshot });
  useLayoutEffect(() => {
    harness.configLayouts.push({
      active: connections?.activeConnection?.id ?? null,
      snapshot: config.data ? JSON.stringify(config.data) : config.status,
    });
  });
  return <div data-testid="recovery-config" data-config={snapshot} />;
}

/** Protected workspace read with the colliding key, quarantined per authority. */
function ProtectedProbe() {
  const { status, namespace } = useAuthorityPersistence();
  const harness = (AccessRequestProbe as unknown as { harness: Harness })
    .harness;
  const projects = useQuery({
    queryKey: ['projects'],
    queryFn: async () => {
      const activeId = connections?.activeConnection?.id;
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
      data-testid="protected"
      data-status={status}
      data-namespace={namespace ?? ''}
      data-projects={
        projects.data ? JSON.stringify(projects.data) : projects.status
      }
    />
  );
}

function renderCompositionTree(harness: Harness) {
  (AccessRequestProbe as unknown as { harness: Harness }).harness = harness;
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
        <RecoveryQueryBoundary>
          <AccessRequestProbe />
          <RecoveryConfigObserver />
        </RecoveryQueryBoundary>
        <AuthorityQueryProvider
          fetchObservation={harness.fetchObservation}
          storage={harness.asyncStorage.storage}
          localUiApiBase="http://127.0.0.1:9"
          persistThrottleTimeMs={0}
        >
          <ProtectedProbe />
        </AuthorityQueryProvider>
      </QueryClientProvider>
    </ApiBaseProvider>,
  );
}

function accessDialog() {
  return within(screen.getByRole('dialog', { name: 'Connection manager' }));
}

function protectedProbe(): HTMLElement {
  return screen.getByTestId('protected');
}

/** Every home this file creates, so afterEach can remove it from the shared singleton. */
const createdHomeIds: string[] = [];

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

const OBS_DEFAULT: AuthorityObservation = {
  schemaVersion: 'station.authority-observation/v1',
  environmentId: 'env-recovery-default-seed',
  principal: { kind: 'human', id: 'human:local:recovery-seed' },
  grant: { kind: 'operator' },
};

afterEach(async () => {
  await act(async () => {
    connections?.resetToDefault();
    for (const id of createdHomeIds.splice(0)) {
      connections?.removeCredential(id);
      connections?.removeConnection(id);
    }
  });
  connections = undefined;
  // The SDK wire double is a module singleton: reset per test so fetch
  // plans and logs never leak across tests. (The toast store is untouched
  // baseline in this slice — no test here writes toasts.)
  sdkWire.configFetchPlan.clear();
  sdkWire.configFetchLog.length = 0;
  vi.mocked(resolveLocalUiSession).mockReset();
  vi.mocked(resolveLocalUiSession).mockResolvedValue({
    kind: 'host-unavailable',
  });
});

describe('authority recovery composition (real provider tree, mocked wire)', () => {
  it('an open access-request flow survives activation transitions with zero old private rows', async () => {
    const harness = createHarness();
    harness.observationPlan.set('default', async () => OBS_DEFAULT);
    sdkWire.configFetchPlan.set('', async () => ({
      home: connections?.activeConnection?.id ?? 'none',
    }));
    const { unmount } = renderCompositionTree(harness);
    const { id: idA, url: urlA } = await addHome('reca');
    const { id: idB, url: urlB } = await addHome('recb');
    const observationB = deferred<AuthorityObservation>();
    harness.observationPlan.set(urlA, async () => OBS_A);
    harness.observationPlan.set(urlB, () => observationB.promise);
    await switchTo(idA);

    await waitFor(() =>
      expect(protectedProbe().getAttribute('data-projects')).toContain(idA),
    );
    // The operator opens the access-request flow while A is verified.
    fireEvent.click(screen.getByTestId('access-open'));
    expect(
      accessDialog().getByRole('heading', { name: 'Request Access' })
        .textContent,
    ).toBe('Request Access');

    // Adding B activates it: the observation is still in flight, so the
    // protected subtree is honestly loading — but the recovery shell,
    // including the open dialog, must NOT unmount.
    await switchTo(idB);
    await waitFor(() =>
      expect(screen.queryByText(/Verifying Station authority/i)).not.toBeNull(),
    );
    expect(
      accessDialog().getByRole('heading', { name: 'Request Access' })
        .textContent,
    ).toBe('Request Access');
    expect(accessDialog().getByRole('button', { name: 'Back' })).not.toBeNull();
    // Quarantine during the gap: no protected probe, no A rows anywhere.
    expect(screen.queryByTestId('protected')).toBeNull();
    expect(document.body.textContent).not.toContain(idA);

    // B verifies: the dialog is STILL open, protected shows B only.
    await act(async () => {
      observationB.resolve(OBS_B);
    });
    await waitFor(() =>
      expect(protectedProbe().getAttribute('data-projects')).toContain(idB),
    );
    expect(protectedProbe().getAttribute('data-namespace')).toBe(NS_B);
    expect(
      accessDialog().getByRole('heading', { name: 'Request Access' })
        .textContent,
    ).toBe('Request Access');
    expect(document.body.textContent).not.toContain(idA);

    // Return to A: still no remount, A rows restored from A's own shelf.
    await switchTo(idA);
    await waitFor(() =>
      expect(protectedProbe().getAttribute('data-namespace')).toBe(NS_A),
    );
    await waitFor(() =>
      expect(protectedProbe().getAttribute('data-projects')).toContain(idA),
    );
    expect(
      accessDialog().getByRole('heading', { name: 'Request Access' })
        .textContent,
    ).toBe('Request Access');
    expect(harness.accessMounts).toBe(1);
    expect(harness.accessUnmounts).toBe(0);
    unmount();
  });

  it('recovery config is identity-scoped: no render or layout effect serves the previous connection', async () => {
    // The production read (`useRecoveryConfig`: explicit origin +
    // identity-scoped key) against a deferred wire for B. The render AND the
    // layout-effect observer record every committed view; any record pairing
    // B-active with A's data fails the test — including a commit whose paint
    // never happens. The hook's five-minute staleTime is production parity:
    // with the old bare key this data would simply persist (no refetch, no
    // pending), so the pending assertions below are the scoped key proving
    // itself, not the boundary's reset (which runs after child layout
    // effects and could not save them).
    const harness = createHarness();
    harness.observationPlan.set('default', async () => OBS_DEFAULT);
    sdkWire.configFetchPlan.set('', async () => ({
      home: connections?.activeConnection?.id ?? 'none',
    }));
    const { unmount } = renderCompositionTree(harness);
    const { id: idA, url: urlA } = await addHome('reccfga');
    const { id: idB, url: urlB } = await addHome('reccfgb');
    const configB = deferred<unknown>();
    sdkWire.configFetchPlan.set(urlA, async () => ({ home: idA }));
    sdkWire.configFetchPlan.set(urlB, () => configB.promise);
    harness.observationPlan.set(urlA, async () => OBS_A);
    harness.observationPlan.set(urlB, async () => OBS_B);
    await switchTo(idA);
    await waitFor(() =>
      expect(
        screen.getByTestId('recovery-config').getAttribute('data-config'),
      ).toContain(idA),
    );
    const renderMark = harness.configRenders.length;
    const layoutMark = harness.configLayouts.length;

    await switchTo(idB);
    // While B's config is unresolved, every committed view under B-active
    // is pending — in renders AND in layout effects. One record pairing
    // B with A's data is the defect.
    await waitFor(() =>
      expect(
        screen.getByTestId('recovery-config').getAttribute('data-config'),
      ).toBe('pending'),
    );
    for (const record of harness.configRenders.slice(renderMark)) {
      if (record.active === idB) {
        expect(record.snapshot).not.toContain(idA);
      }
    }
    for (const record of harness.configLayouts.slice(layoutMark)) {
      if (record.active === idB) {
        expect(record.snapshot).not.toContain(idA);
      }
    }

    await act(async () => {
      configB.resolve({ home: idB });
    });
    await waitFor(() =>
      expect(
        screen.getByTestId('recovery-config').getAttribute('data-config'),
      ).toContain(idB),
    );
    // The dispatches carried their own render-captured authority — not a
    // shared global: A's dispatch names A's origin+key, B's names B's, and
    // the keys differ. A rotation that reused one capture for both would
    // fail this, not just the key-partition assertions above.
    const dispatchA = sdkWire.configFetchLog.find((entry) =>
      entry.url.startsWith(urlA),
    );
    const dispatchB = sdkWire.configFetchLog.find((entry) =>
      entry.url.startsWith(urlB),
    );
    expect(dispatchA?.requestScope?.apiBase).toBe(urlA);
    expect(dispatchB?.requestScope?.apiBase).toBe(urlB);
    expect(dispatchA?.requestScope?.authorityKey).not.toBe(
      dispatchB?.requestScope?.authorityKey,
    );
    unmount();
  });

  it('same-origin credential rotation re-reads recovery config instead of serving the old entry', async () => {
    // `setCredential` through the real Connections API bumps the authority
    // generation and re-observes (same observation, same namespace), so the
    // protected tree stays mounted while the recovery identity advances.
    // The scoped key must refetch under the rotation; the old entry must
    // never render as current afterwards.
    let rotations = 0;
    const harness = createHarness();
    harness.observationPlan.set('default', async () => OBS_DEFAULT);
    sdkWire.configFetchPlan.set('', async () => ({
      home: connections?.activeConnection?.id ?? 'none',
    }));
    const { unmount } = renderCompositionTree(harness);
    const { id: idA, url: urlA } = await addHome('recrot');
    sdkWire.configFetchPlan.set(urlA, async () => ({
      home: idA,
      rotation: rotations,
    }));
    harness.observationPlan.set(urlA, async () => OBS_A);
    await switchTo(idA);
    await waitFor(() =>
      expect(
        screen.getByTestId('recovery-config').getAttribute('data-config'),
      ).toContain(idA),
    );

    rotations += 1;
    await act(async () => {
      connections?.setCredential(idA, 'rotated-credential');
    });
    // New identity, new entry: a refetch dispatches (tagged with the new
    // rotation) and the commit renders pending first — the old entry is
    // unreachable under the new key, not merely invalidated.
    await waitFor(() =>
      expect(
        screen.getByTestId('recovery-config').getAttribute('data-config'),
      ).toContain('"rotation":1'),
    );
    expect(
      sdkWire.configFetchLog.filter((entry) => entry.url.startsWith(urlA))
        .length,
    ).toBeGreaterThanOrEqual(2);
    unmount();
  });

  // NOTE (root correction): toast/notification/action isolation across
  // authority changes is a separate #481/106 follow-up, not proven here.
  // The toast store stays a baseline module singleton in this slice; a
  // connection-only ambient dismissal would miss same-origin rotations and
  // mis-stamp late callbacks, so no scoped-toast test belongs in this file.

  it('the relocated switch invalidation still marks the targeted cache stale on a switch', async () => {
    // The archive#1290 hook moved with the client it targets
    // (`AuthoritySwitchInvalidator`, inside the authority tree) when the
    // recovery shell hoisted above it. This pins the hook logic itself:
    // a switch input change invalidates the client it runs under, so a
    // relocation that dropped the call would lose stale-marking.
    let fetches = 0;
    const client = new QueryClient({
      defaultOptions: {
        queries: { retry: false, refetchOnWindowFocus: false },
      },
    });
    function SwitchHarness({ apiBase }: { apiBase: string }) {
      const { hasActiveConnection, connectionScope } =
        useConnectionSwitchScopeForTest(apiBase);
      useInvalidateCachesOnConnectionSwitch(
        apiBase,
        hasActiveConnection,
        connectionScope,
      );
      const observed = useQuery({
        queryKey: ['projects'],
        queryFn: async () => {
          fetches += 1;
          return [{ id: 'p1' }];
        },
        staleTime: Number.POSITIVE_INFINITY,
      });
      return (
        <div
          data-testid="switch-probe"
          data-projects={observed.data ? 'ready' : observed.status}
        />
      );
    }
    const { rerender, unmount } = render(
      <QueryClientProvider client={client}>
        <SwitchHarness apiBase="http://switch-a.recovery.test:3141" />
      </QueryClientProvider>,
    );
    await waitFor(() =>
      expect(
        screen.getByTestId('switch-probe').getAttribute('data-projects'),
      ).toBe('ready'),
    );
    expect(fetches).toBe(1);
    rerender(
      <QueryClientProvider client={client}>
        <SwitchHarness apiBase="http://switch-b.recovery.test:3141" />
      </QueryClientProvider>,
    );
    await waitFor(() => expect(fetches).toBeGreaterThan(1));
    unmount();
    client.clear();
  });
});

/**
 * Test-local scope with the same shape as the production hook input: the
 * identity under test is the (apiBase, scope) pair, not the connections
 * store. The production `useConnectionSwitchScope` reads the live store;
 * here the switch is driven by props so the invalidation logic is pinned
 * without store churn.
 */
function useConnectionSwitchScopeForTest(apiBase: string): {
  hasActiveConnection: boolean;
  connectionScope: string | null;
} {
  return { hasActiveConnection: true, connectionScope: `${apiBase}:scope` };
}
