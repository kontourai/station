/** @vitest-environment jsdom */

import type { ConnectionStatusResult } from '@kontourai/station-connect';
import type { StationProfileStore } from '@kontourai/station-contracts';
/**
 * The connected-server updates card is covered as one composition, mirroring
 * the real boot paths: a hydrated host-owned profile store, the native
 * request-binding capture/check, the shared health coordinator and the real
 * CoreUpdateCheck — with the two process/host boundaries (native transport,
 * renderer fetch) as the only mocks. Ownership evidence is never hand-set:
 * it arrives through ApiBaseContext's injected loopback or the persisted
 * profile projection, exactly as production composes it.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConnectedServerUpdateContext } from '../hooks/useConnectedServerUpdateContext';
import { NativeStationProfileStorage } from '../platform/native/stationProfileStorage';
import type { BundledServerStatus } from '../platform/native/types';

const nativeTransport = vi.hoisted(() => vi.fn<typeof fetch>());
const native = vi.hoisted(() => ({
  repository: null as InstanceType<typeof NativeStationProfileStorage> | null,
  bundledStatus: null as BundledServerStatus | null,
}));

vi.mock('../platform/PlatformProfileContext', () => ({
  nativeProfileRepository: () => {
    if (!native.repository) throw new Error('native fixture is not ready');
    return native.repository;
  },
  useNativeProfileSelection: () => async () => {},
  useNativeProfileStoreEpoch: () => 0,
  usePlatformProfile: () => profile,
}));

vi.mock('../platform/useBundledServerStatus', () => ({
  useBundledServerStatus: (enabled: boolean) =>
    enabled ? native.bundledStatus : null,
}));

vi.mock('../platform/native/authenticatedTransport', () => ({
  nativeAuthenticatedTransport: nativeTransport,
}));

const SHA = '71e0381f78e903cd81fc9d2d21266986103f6f39';
const PORT = 4311;
const LOOPBACK = `http://127.0.0.1:${PORT}`;
const PAIRED_ORIGIN = 'https://station.example.test:8444';

const DESKTOP_PROFILE = {
  isTauri: true,
  target: 'macos' as string,
  isMobile: false,
  isDesktop: true,
  supervisesBundledServer: true,
  isDevBuild: false,
};

const profile = { ...DESKTOP_PROFILE };

const EMPTY_STORE: StationProfileStore = {
  schemaVersion: 1,
  revision: 0,
  defaultProfile: null,
  projectProfiles: {},
  profiles: [],
};

function localProfile(
  name: string,
  endpoint: string,
  instanceId: string,
): StationProfileStore['profiles'][number] {
  return {
    schemaVersion: 1,
    name,
    endpoint,
    credentialRef: { kind: 'station-bearer', id: `ref-${name}` },
    setupSource: 'local',
    configurationState: 'configured',
    localService: {
      instanceId,
      baseDir: `/home/station-${name}`,
      serverPort: PORT,
      uiPort: PORT + 1,
    },
    createdAt: 1,
    updatedAt: 2,
  };
}

function pairedProfile(
  name: string,
  endpoint: string,
): StationProfileStore['profiles'][number] {
  return {
    schemaVersion: 1,
    name,
    endpoint,
    credentialRef: { kind: 'station-bearer', id: `ref-${name}` },
    setupSource: 'paired',
    configurationState: 'configured',
    createdAt: 1,
    updatedAt: 2,
  };
}

const SERVICE_STORE: StationProfileStore = {
  schemaVersion: 1,
  revision: 0,
  defaultProfile: 'local-service',
  projectProfiles: {},
  profiles: [localProfile('local-service', LOOPBACK, 'svc-instance-1')],
};

const PAIRED_STORE: StationProfileStore = {
  schemaVersion: 1,
  revision: 0,
  defaultProfile: 'paired-owner',
  projectProfiles: {},
  profiles: [pairedProfile('paired-owner', PAIRED_ORIGIN)],
};

const SAME_ORIGIN_STORE: StationProfileStore = {
  schemaVersion: 1,
  revision: 0,
  defaultProfile: 'profile-a',
  projectProfiles: {},
  profiles: [
    pairedProfile('profile-a', PAIRED_ORIGIN),
    pairedProfile('profile-b', PAIRED_ORIGIN),
  ],
};

/** A saved local owner that records the desktop sidecar's stable instance id. */
const SERVICE_STORE_WITH_SIDECAR_OWNER: StationProfileStore = {
  schemaVersion: 1,
  revision: 0,
  defaultProfile: 'local-service',
  projectProfiles: {},
  profiles: [localProfile('local-service', LOOPBACK, 'desktop-sidecar-stable')],
};

const HANDSHAKE = {
  schemaVersion: 1,
  environmentId: 'environment-1',
  authentication: { scheme: 'bearer', protocolVersion: 1 },
  transports: { http: 1, sse: 1, websocket: 1 },
  compatibility: {
    serverVersion: '0.4.1',
    protocolVersion: 1,
    minClientProtocol: 1,
  },
};

const FALLBACK_BINDING_ID = '99999999-9999-4999-8999-999999999999';
const BINDING_IDS: Record<string, string> = {
  'local-service': '11111111-1111-4111-8111-111111111111',
  'paired-owner': '22222222-2222-4222-8222-222222222222',
  'profile-a': '33333333-3333-4333-8333-333333333333',
  'profile-b': '44444444-4444-4444-8444-444444444444',
};

function sidecarStatus(
  over: Partial<BundledServerStatus> = {},
): BundledServerStatus {
  return {
    phase: 'running',
    attempt: 1,
    maxAttempts: 3,
    apiBase: LOOPBACK,
    port: PORT,
    generation: 3,
    instanceId: 'desktop-sidecar-stable',
    bootId: 'boot-1',
    lastExitCode: null,
    nextRetryInMs: null,
    logPath: null,
    ownership: 'sidecar',
    canRunInBackground: true,
    failClosed: false,
    message: '',
    ...over,
  };
}

let identityBody: () => unknown;
let identityMode: 'auto' | 'queue';
let identityFailure: number | undefined;
let identityCalls: Array<{ url: string; signal: AbortSignal | null }>;
let transportCalls: string[];
let identityQueue: Array<{
  resolve: (response: Response) => void;
  signal: AbortSignal | null;
}>;
let rendererCalls: string[];

function identityResponseFor(over: Record<string, unknown> = {}) {
  return {
    instanceId: 'desktop-sidecar-stable',
    bootId: 'boot-1',
    sha: SHA,
    devicePresentation: { deviceClass: 'host', hostName: 'Kontour' },
    ...over,
  };
}

const DEFAULT_IDENTITY = () => identityResponseFor();

let connections:
  | ReturnType<typeof import('@kontourai/station-connect').useConnections>
  | undefined;
let health: ConnectionStatusResult | undefined;
let context: ConnectedServerUpdateContext | undefined;

async function renderHarness({
  store = EMPTY_STORE,
  bundledStatus = null,
  authorize = true,
  identity = DEFAULT_IDENTITY,
  identityFailure: failureStatus = undefined,
  queueIdentity = false,
  profileOverrides = {},
}: {
  store?: StationProfileStore;
  bundledStatus?: BundledServerStatus | null;
  authorize?: boolean;
  identity?: () => unknown;
  identityFailure?: number;
  queueIdentity?: boolean;
  profileOverrides?: Partial<typeof DESKTOP_PROFILE>;
} = {}) {
  identityBody = identity;
  identityMode = queueIdentity ? 'queue' : 'auto';
  identityFailure = failureStatus;
  identityCalls = [];
  transportCalls = [];
  identityQueue = [];
  rendererCalls = [];
  Object.assign(profile, DESKTOP_PROFILE, profileOverrides);
  native.bundledStatus = bundledStatus;
  native.repository = new NativeStationProfileStorage({
    async invoke<T>(
      command: string,
      args?: Record<string, unknown>,
    ): Promise<T> {
      if (command === 'station_profile_store_read') return store as T;
      if (command === 'station_profile_authorize_active') {
        const matched = store.profiles.find(
          (candidate) => candidate.name === args?.profileName,
        );
        if (!matched) return null as T;
        // The receipt parser enforces a UUID-shaped opaque binding id.
        return {
          bindingId: BINDING_IDS[matched.name] ?? FALLBACK_BINDING_ID,
          exactOrigin: matched.endpoint,
        } as T;
      }
      throw new Error(`unexpected native command: ${command}`);
    },
  });
  await native.repository.hydrate();
  if (authorize && store.defaultProfile) {
    await native.repository.authorizeDefaultProfile();
  }
  // `@kontourai/station-connect` keeps a module-level shared ConnectionStore;
  // a fresh module graph per test isolates each fixture's hydrated store.
  vi.resetModules();
  const [
    { ApiBaseProvider },
    { ConnectedServerUpdates },
    { useConnectedServerUpdateContext },
    connect,
    { checkServerHealth, probeServerConnection },
  ] = await Promise.all([
    import('../contexts/ApiBaseContext'),
    import('../views/settings/ConnectedServerUpdates'),
    import('../hooks/useConnectedServerUpdateContext'),
    import('@kontourai/station-connect'),
    import('../lib/serverHealth'),
  ]);
  const { useConnections, useConnectionStatus } = connect;

  function CorrelationProbe() {
    connections = useConnections();
    health = useConnectionStatus({
      checkHealth: checkServerHealth,
      probeEndpoint: probeServerConnection,
      pollInterval: 60_000,
    });
    context = useConnectedServerUpdateContext();
    return null;
  }

  const queryClient = new QueryClient();
  const buildTree = () => (
    <QueryClientProvider client={queryClient}>
      <ApiBaseProvider>
        <CorrelationProbe />
        <ConnectedServerUpdates />
      </ApiBaseProvider>
    </QueryClientProvider>
  );
  const view = render(buildTree());
  return { view, queryClient, rerender: () => view.rerender(buildTree()) };
}

async function waitConnected() {
  await waitFor(() => expect(health?.status).toBe('connected'));
}

async function waitIdentitySettled() {
  await waitFor(() => expect(context?.identitySettled).toBe(true));
}

/** Release queued identity responses one at a time until health connects. */
async function drainProbeUntilConnected(body: () => unknown) {
  identityBody = body;
  for (let i = 0; i < 10 && health?.status !== 'connected'; i += 1) {
    await waitFor(() => expect(identityQueue.length).toBeGreaterThan(0));
    await act(async () => {
      identityQueue.shift()?.resolve(Response.json(identityBody()));
    });
  }
  await waitConnected();
}

describe('ConnectedServerUpdates', () => {
  beforeEach(() => {
    connections = undefined;
    health = undefined;
    context = undefined;
    localStorage.clear();
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: unknown) => {
        const url = String(input);
        rendererCalls.push(url);
        if (url.includes('/.well-known/station/v1')) {
          return Response.json(HANDSHAKE);
        }
        if (url.includes('/api/system/identity')) {
          return Response.json(identityBody());
        }
        throw new Error(`unexpected renderer fetch: ${url}`);
      }),
    );
    nativeTransport.mockReset();
    nativeTransport.mockImplementation(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        transportCalls.push(url);
        if (url.includes('/api/system/core-update')) {
          // The mounted CoreUpdateCheck's own source query; nothing here
          // asserts its body beyond a parseable, current status.
          return Response.json({ updateAvailable: false });
        }
        if (!url.includes('/api/system/identity')) {
          throw new Error(`unexpected native transport call: ${url}`);
        }
        const signal = init?.signal ?? null;
        identityCalls.push({ url, signal });
        const authorityGuard = (
          init as { authorityGuard?: () => void } | undefined
        )?.authorityGuard;
        authorityGuard?.();
        if (identityFailure !== undefined) {
          return new Response('identity unavailable', {
            status: identityFailure,
          });
        }
        if (identityMode === 'queue') {
          return new Promise<Response>((resolve) => {
            identityQueue.push({ resolve, signal });
          });
        }
        return Response.json(identityBody());
      },
    );
  });

  afterEach(() => {
    native.repository = null;
    native.bundledStatus = null;
    vi.unstubAllGlobals();
  });

  it('renders the built-in copy for an established embedded sidecar and never requests the source check', async () => {
    await renderHarness({
      bundledStatus: sidecarStatus(),
      identity: () =>
        identityResponseFor({ instanceId: 'desktop-sidecar-stable' }),
    });
    await waitConnected();
    expect(
      await screen.findByText(
        'Built-in server — updated with this desktop app.',
      ),
    ).toBeTruthy();
    expect(screen.getByText('Use Desktop app updates above.')).toBeTruthy();
    expect(screen.queryByText(/provenance/i)).toBeNull();
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(
      transportCalls.filter((url) => url.includes('/api/system/core-update')),
    ).toHaveLength(0);
    expect(rendererCalls.some((url) => url.includes('core-update'))).toBe(
      false,
    );
    expect(
      identityCalls.some(({ url }) => url.includes('/api/system/identity')),
    ).toBe(true);
  });

  it('renders the established installed service even while the native phase reads stopped', async () => {
    await renderHarness({
      store: SERVICE_STORE,
      bundledStatus: sidecarStatus({
        ownership: 'service',
        phase: 'stopped',
        instanceId: 'svc-instance-1',
        generation: null,
        bootId: null,
      }),
      identity: () =>
        identityResponseFor({ instanceId: 'svc-instance-1', bootId: 'b2' }),
    });
    await waitConnected();
    await waitIdentitySettled();
    expect(
      await screen.findByText('Installed service on this Mac.'),
    ).toBeTruthy();
    expect(
      screen.getByText(
        'This service is updated separately from the desktop app.',
      ),
    ).toBeTruthy();
    expect(screen.queryByText('Stopped')).toBeNull();
    // The ordinary source check is mounted and auto-checks once settled.
    await waitFor(() =>
      expect(
        transportCalls.some((url) => url.includes('/api/system/core-update')),
      ).toBe(true),
    );
  });

  it('renders the paired-server presentation for an authenticated server outside a local-owner match', async () => {
    await renderHarness({
      store: PAIRED_STORE,
      profileOverrides: { supervisesBundledServer: false },
      identity: () =>
        identityResponseFor({
          instanceId: 'remote-instance',
          bootId: 'remote-boot',
          devicePresentation: {
            deviceClass: 'paired',
            hostName: 'Office host',
          },
        }),
    });
    await waitConnected();
    await waitIdentitySettled();
    expect(
      await screen.findByText('Server on station.example.test:8444.'),
    ).toBeTruthy();
    expect(screen.getByText('Manage updates on that host.')).toBeTruthy();
    expect(
      screen.getByText(
        'Updates apply to the server at this address and affect its connected clients.',
      ),
    ).toBeTruthy();
    expect(
      screen.getByText(`Connected to paired-owner · ${PAIRED_ORIGIN}`),
    ).toBeTruthy();
    await waitFor(() =>
      expect(
        transportCalls.some((url) => url.includes('/api/system/core-update')),
      ).toBe(true),
    );
  });

  it('resolves unresolved when the desktop supervises nothing though identity answers', async () => {
    await renderHarness({
      store: PAIRED_STORE,
      bundledStatus: null,
      profileOverrides: { supervisesBundledServer: true },
      identity: () =>
        identityResponseFor({
          instanceId: 'remote-instance',
          bootId: 'remote-boot',
        }),
    });
    await waitConnected();
    await waitIdentitySettled();
    expect(
      await screen.findByText('Server update method unknown.'),
    ).toBeTruthy();
    expect(
      screen.queryByText('Built-in server — updated with this desktop app.'),
    ).toBeNull();
  });

  it.each([
    {
      name: 'omitted native boot id',
      status: sidecarStatus({ bootId: null }),
      identity: identityResponseFor(),
    },
    {
      name: 'wrong native boot id',
      status: sidecarStatus({ bootId: 'boot-2' }),
      identity: identityResponseFor(),
    },
    {
      name: 'answering instance is not the native owner',
      status: sidecarStatus(),
      identity: identityResponseFor({ instanceId: 'other-instance' }),
    },
    {
      name: 'same port with a different instance',
      status: sidecarStatus({ instanceId: 'desktop-sidecar-other' }),
      identity: identityResponseFor(),
    },
  ])('resolves unresolved for $name', async ({ status, identity }) => {
    await renderHarness({
      bundledStatus: status,
      identity: () => identity,
    });
    await waitConnected();
    await waitIdentitySettled();
    expect(
      await screen.findByText('Server update method unknown.'),
    ).toBeTruthy();
    expect(
      screen.queryByText('Built-in server — updated with this desktop app.'),
    ).toBeNull();
    expect(screen.queryByText('Installed service on this Mac.')).toBeNull();
  });

  it('resolves unresolved while a persisted connection has no native binding yet', async () => {
    await renderHarness({
      store: SERVICE_STORE,
      authorize: false,
      bundledStatus: sidecarStatus({
        ownership: 'service',
        phase: 'stopped',
        instanceId: 'svc-instance-1',
        generation: null,
        bootId: null,
      }),
      identity: () =>
        identityResponseFor({ instanceId: 'svc-instance-1', bootId: 'b2' }),
    });
    await waitConnected();
    await waitIdentitySettled();
    expect(
      await screen.findByText('Server update method unknown.'),
    ).toBeTruthy();
    expect(screen.queryByText('Installed service on this Mac.')).toBeNull();
  });

  it('resolves unresolved and keeps the card silent about method when identity is incomplete', async () => {
    await renderHarness({
      bundledStatus: sidecarStatus(),
      identity: () => ({ instanceId: 'desktop-sidecar-stable' }),
    });
    await waitConnected();
    await waitIdentitySettled();
    expect(
      await screen.findByText('Server update method unknown.'),
    ).toBeTruthy();
    expect(
      screen.queryByText('Built-in server — updated with this desktop app.'),
    ).toBeNull();
    expect(
      transportCalls.filter((url) => url.includes('/api/system/core-update')),
    ).toHaveLength(0);
  });

  it('keeps the source check off when the identity request fails for an established-shaped sidecar', async () => {
    await renderHarness({
      bundledStatus: sidecarStatus(),
      identityFailure: 503,
    });
    await waitConnected();
    await waitIdentitySettled();
    expect(
      await screen.findByText('Server update method unknown.'),
    ).toBeTruthy();
    expect(
      screen.queryByText('Built-in server — updated with this desktop app.'),
    ).toBeNull();
    // An identity error is settled but not ready: the automatic source check
    // must stay off against a server the correlation could not name.
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(
      transportCalls.filter((url) => url.includes('/api/system/core-update')),
    ).toHaveLength(0);
  });

  it('holds the source check until the native observation arrives, then renders the built-in copy', async () => {
    // Mount with a saved local owner already answering (identity settles)
    // while the supervising desktop's native snapshot is still pending: the
    // real snapshot arrives through an async subscription after mount.
    const { rerender } = await renderHarness({
      store: SERVICE_STORE_WITH_SIDECAR_OWNER,
      identity: () =>
        identityResponseFor({ instanceId: 'desktop-sidecar-stable' }),
      bundledStatus: null,
    });
    await waitConnected();
    await waitIdentitySettled();
    expect(context?.identityReady).toBe(true);
    expect(context?.nativeObservationPending).toBe(true);
    expect(
      screen.queryByText('Built-in server — updated with this desktop app.'),
    ).toBeNull();
    expect(
      transportCalls.filter((url) => url.includes('/api/system/core-update')),
    ).toHaveLength(0);

    // The subscription delivers after identity has settled.
    native.bundledStatus = sidecarStatus();
    rerender();
    expect(
      await screen.findByText(
        'Built-in server — updated with this desktop app.',
      ),
    ).toBeTruthy();
    expect(
      transportCalls.filter((url) => url.includes('/api/system/core-update')),
    ).toHaveLength(0);
  });

  it('does not render the built-in copy while the observed sidecar is only starting, and holds the source check', async () => {
    await renderHarness({
      bundledStatus: sidecarStatus({ phase: 'starting' }),
    });
    await waitConnected();
    await waitIdentitySettled();
    expect(
      await screen.findByText('Server update method unknown.'),
    ).toBeTruthy();
    expect(
      screen.queryByText('Built-in server — updated with this desktop app.'),
    ).toBeNull();
    // The selection claims the observed owner and correlation has not
    // established it: the automatic source check stays off.
    expect(context?.claimedOwnerUnresolved).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(
      transportCalls.filter((url) => url.includes('/api/system/core-update')),
    ).toHaveLength(0);
  });

  it('holds the check for a claimed-but-unestablished owner and keeps it on for a resolved paired server', async () => {
    // Truth table, claimed side: matching owner ids but a wrong boot leaves
    // kind unresolved — the check must not fire at the unnamed server.
    const first = await renderHarness({
      bundledStatus: sidecarStatus({ bootId: 'boot-2' }),
    });
    await waitConnected();
    await waitIdentitySettled();
    expect(context?.claimedOwnerUnresolved).toBe(true);
    expect(
      await screen.findByText('Server update method unknown.'),
    ).toBeTruthy();
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(
      transportCalls.filter((url) => url.includes('/api/system/core-update')),
    ).toHaveLength(0);
    first.view.unmount();

    // Truth table, unclaimed side: a paired connection claims NO native
    // owner, so the hold must not apply — the resolved server keeps its
    // automatic check.
    await renderHarness({
      store: PAIRED_STORE,
      profileOverrides: { supervisesBundledServer: false },
      identity: () =>
        identityResponseFor({
          instanceId: 'remote-instance',
          bootId: 'remote-boot',
          devicePresentation: {
            deviceClass: 'paired',
            hostName: 'Office host',
          },
        }),
    });
    await waitConnected();
    await waitIdentitySettled();
    expect(context?.claimedOwnerUnresolved).toBe(false);
    expect(
      await screen.findByText('Server on station.example.test:8444.'),
    ).toBeTruthy();
    await waitFor(() =>
      expect(
        transportCalls.some((url) => url.includes('/api/system/core-update')),
      ).toBe(true),
    );
  });

  it('renders a neutral checking line, not the unavailable copy, while the connection is being checked', async () => {
    await renderHarness({
      store: SAME_ORIGIN_STORE,
      queueIdentity: true,
      profileOverrides: { supervisesBundledServer: false },
    });
    // The held probe identity keeps the coordinator in its connecting state.
    expect(await screen.findByText('Checking the connection…')).toBeTruthy();
    expect(
      screen.queryByText(
        'Connected server unavailable. Reconnect to check its update status.',
      ),
    ).toBeNull();
    await drainProbeUntilConnected(() =>
      identityResponseFor({
        instanceId: 'instance-a',
        bootId: 'boot-a',
        devicePresentation: { deviceClass: 'paired', hostName: 'Host A' },
      }),
    );
    await waitFor(() =>
      expect(screen.queryByText('Checking the connection…')).toBeNull(),
    );
  });

  it('never renders the built-in copy in a browser shell even when identity strings would match', async () => {
    await renderHarness({
      identity: () =>
        identityResponseFor({
          instanceId: 'desktop-sidecar-stable',
          devicePresentation: {
            deviceClass: 'paired',
            hostName: 'Elsewhere',
          },
        }),
      profileOverrides: {
        isTauri: false,
        target: 'web',
        isDesktop: false,
        supervisesBundledServer: false,
      },
    });
    await waitConnected();
    // A browser shell selects connections through browser storage, not the
    // native profile store; point the selected connection at the paired origin.
    await act(async () => {
      connections?.setApiBase(PAIRED_ORIGIN);
    });
    await waitConnected();
    await waitIdentitySettled();
    expect(
      screen.queryByText('Built-in server — updated with this desktop app.'),
    ).toBeNull();
    expect(
      await screen.findByText('Server on station.example.test:8444.'),
    ).toBeTruthy();
  });

  it('never renders the built-in copy on a mobile shell', async () => {
    await renderHarness({
      store: PAIRED_STORE,
      bundledStatus: sidecarStatus(),
      identity: () =>
        identityResponseFor({
          instanceId: 'desktop-sidecar-stable',
          devicePresentation: {
            deviceClass: 'paired',
            hostName: 'Elsewhere',
          },
        }),
      profileOverrides: {
        target: 'android',
        isMobile: true,
        isDesktop: false,
        supervisesBundledServer: false,
      },
    });
    await waitConnected();
    await waitIdentitySettled();
    expect(
      screen.queryByText('Built-in server — updated with this desktop app.'),
    ).toBeNull();
    expect(
      await screen.findByText('Server on station.example.test:8444.'),
    ).toBeTruthy();
  });

  it('isolates selection A→B→A: a late A response cannot label B nor repopulate any cache', async () => {
    const { queryClient } = await renderHarness({
      store: SAME_ORIGIN_STORE,
      queueIdentity: true,
      profileOverrides: { supervisesBundledServer: false },
    });
    await drainProbeUntilConnected(() =>
      identityResponseFor({
        instanceId: 'instance-a',
        bootId: 'boot-a',
        devicePresentation: { deviceClass: 'paired', hostName: 'Host A' },
      }),
    );
    await waitFor(() => expect(identityQueue.length).toBeGreaterThan(0));
    const heldA = identityQueue.shift();
    expect(heldA?.signal).toBeTruthy();
    const scopeA1 = context?.scopeKey;
    expect(scopeA1).toBeTruthy();
    expect(
      await screen.findByText(`Connected to profile-a · ${PAIRED_ORIGIN}`),
    ).toBeTruthy();

    await native.repository?.authorizeActiveConnection(
      'station-profile:profile-b',
    );
    await act(async () => {
      await connections?.setActiveConnection('station-profile:profile-b');
    });
    // The superseded request is cancelled and its cache entry removed.
    await waitFor(() => expect(heldA?.signal?.aborted).toBe(true));
    expect(
      queryClient
        .getQueryCache()
        .getAll()
        .some((entry) => entry.queryKey[1] === scopeA1),
    ).toBe(false);

    await drainProbeUntilConnected(() =>
      identityResponseFor({
        instanceId: 'instance-b',
        bootId: 'boot-b',
        devicePresentation: { deviceClass: 'paired', hostName: 'Host B' },
      }),
    );
    await waitFor(() => expect(identityQueue.length).toBeGreaterThan(0));
    const heldB = identityQueue.shift();
    await act(async () => {
      heldB?.resolve(
        Response.json(
          identityResponseFor({
            instanceId: 'instance-b',
            bootId: 'boot-b',
            devicePresentation: { deviceClass: 'paired', hostName: 'Host B' },
          }),
        ),
      );
    });
    await waitIdentitySettled();
    expect(
      await screen.findByText(`Connected to profile-b · ${PAIRED_ORIGIN}`),
    ).toBeTruthy();
    const scopeB = context?.scopeKey;
    expect(scopeB).toBeTruthy();
    expect(scopeB).not.toEqual(scopeA1);
    const bEntry = queryClient
      .getQueryCache()
      .getAll()
      .find((entry) => entry.queryKey[1] === scopeB);
    expect(
      (bEntry?.state.data as { instanceId?: string } | undefined)?.instanceId,
    ).toBe('instance-b');

    // Releasing the held A response now must not repopulate A's scope.
    await act(async () => {
      heldA?.resolve(
        Response.json(
          identityResponseFor({
            instanceId: 'instance-a',
            bootId: 'boot-a',
            devicePresentation: { deviceClass: 'paired', hostName: 'Host A' },
          }),
        ),
      );
    });
    expect(
      queryClient
        .getQueryCache()
        .getAll()
        .some((entry) => entry.queryKey[1] === scopeA1),
    ).toBe(false);

    // A→B→A: a fresh A observation refetches under a new scope.
    await native.repository?.authorizeActiveConnection(
      'station-profile:profile-a',
    );
    await act(async () => {
      await connections?.setActiveConnection('station-profile:profile-a');
    });
    await drainProbeUntilConnected(() =>
      identityResponseFor({
        instanceId: 'instance-a2',
        bootId: 'boot-a2',
        devicePresentation: { deviceClass: 'paired', hostName: 'Host A' },
      }),
    );
    await waitFor(() => expect(identityQueue.length).toBeGreaterThan(0));
    await act(async () => {
      identityQueue.shift()?.resolve(
        Response.json(
          identityResponseFor({
            instanceId: 'instance-a2',
            bootId: 'boot-a2',
            devicePresentation: { deviceClass: 'paired', hostName: 'Host A' },
          }),
        ),
      );
    });
    await waitIdentitySettled();
    const scopeA2 = context?.scopeKey;
    expect(scopeA2).toBeTruthy();
    expect(scopeA2).not.toEqual(scopeA1);
    expect(
      await screen.findByText(`Connected to profile-a · ${PAIRED_ORIGIN}`),
    ).toBeTruthy();
    const a2Entry = queryClient
      .getQueryCache()
      .getAll()
      .find((entry) => entry.queryKey[1] === scopeA2);
    expect(
      (a2Entry?.state.data as { instanceId?: string } | undefined)?.instanceId,
    ).toBe('instance-a2');
    expect(
      queryClient
        .getQueryCache()
        .getAll()
        .some((entry) => entry.queryKey[1] === scopeA1),
    ).toBe(false);
  });
});
