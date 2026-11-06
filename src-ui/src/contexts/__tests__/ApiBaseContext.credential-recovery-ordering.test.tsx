/**
 * archive#3601/archive#3602 — the response boundary is ordered after
 * the state it reports, in a browser that HAS the Web Locks API too.
 *
 * `ConnectionStore` serializes its shared-storage writes under a Web Lock, so
 * a credential transition is applied inside a lock callback rather than in the
 * calling tick. The user-visible contract the recovery suite pins — the
 * banner is gone the moment the accepted response resolves — therefore held
 * only where the store happened to be synchronous, which in this repo is every
 * test environment: jsdom has no `navigator.locks`.
 *
 * This file installs a Web-Locks-shaped manager on `navigator` BEFORE the
 * provider builds its store, so the production default (`navigator.locks`) is
 * what the real store picks up, and then asserts the same contract with no
 * `waitFor` and no extra flush.
 */
// @vitest-environment jsdom

import { useConnections } from '@kontourai/station-connect';
import { act, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const navigate = vi.fn();

vi.mock('../../hooks/useSystemStatus', () => ({
  useSystemStatus: () => ({
    data: null,
    isLoading: false,
    isPending: false,
    isError: false,
    failureReason: null,
    refetch: vi.fn(),
  }),
}));
vi.mock('../../hooks/useInvalidateCachesOnConnectionSwitch', () => ({
  useInvalidateCachesOnConnectionSwitch: () => {},
}));
// The gate reads config through the identity-scoped recovery hook (never
// the shared bare-key query under the stable boundary); substitute there so
// this suite keeps testing the credential transport, not scoping.
// #4519: OnboardingGate reads the managed policy; this Station has none.
vi.mock('../../hooks/useManagedRemoteClientsRefusal', () => ({
  useManagedRemoteClientsLimit: () => undefined,
  useManagedRemoteClientsRefusal: () => undefined,
}));
vi.mock('../../hooks/useRecoveryConfig', () => ({
  useRecoveryConfig: () => ({ data: undefined }),
  recoveryConfigKey: (...parts: unknown[]) => parts,
}));
vi.mock('../../components/UsageTelemetryDisclosure', () => ({
  UsageTelemetryDisclosure: () => null,
}));
vi.mock('../../contexts/ToastContext', () => ({
  useToast: () => ({ showToast: vi.fn() }),
}));
vi.mock('../../contexts/NavigationContext', () => ({
  useNavigation: () => ({ navigate, pathname: '/' }),
}));
vi.mock('../../components/PendingPairingReconciler', () => ({
  PendingPairingReconciler: () => null,
}));
vi.mock('../../lib/serverHealth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/serverHealth')>()),
  checkServerHealth: vi.fn(),
  checkServerHealthDetailed: vi.fn(),
  probeServerConnection: vi.fn<
    typeof import('../../lib/serverHealth').probeServerConnection
  >(() => new Promise(() => {})),
}));
vi.mock('../../platform/useBundledServerStatus', () => ({
  useBundledServerStatus: () => null,
  restartBundledServer: vi.fn(),
}));
vi.mock('../../platform/PlatformProfileContext', async () => {
  const { credentialRecoveryPlatformProfileContext } = await import(
    './fixtures/credentialRecoveryPlatformProfileContext'
  );
  return credentialRecoveryPlatformProfileContext;
});

// The transport, `setClientCredentialResolver` and the credential callbacks
// are the subject here, so the SDK is kept REAL; only the React query hooks
// `OnboardingGate` reaches for are substituted, so this suite does not have to
// host a live query graph.
vi.mock('@kontourai/station-sdk', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@kontourai/station-sdk')>()),
  useForceRefetchSystemStatus: () => vi.fn(),
  useEngineConnectionsQuery: () => ({ data: [] }),
  useConfigQuery: () => ({ data: undefined }),
  useUpdateConfigMutation: () => ({ mutate: () => {}, isPending: false }),
}));

// The real store and the real provider; only the heavy connection-manager
// dialog (which this suite never opens) is substituted.
vi.mock('@kontourai/station-connect', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@kontourai/station-connect')>()),
  ConnectionManagerModal: () => null,
}));

import { authenticatedFetch } from '@kontourai/station-sdk';
import { WorkspaceStationState } from '../../components/notifications/StationConditions';
import { OnboardingGate } from '../../components/OnboardingGate';
import { captureStationConnectionAuthority } from '../../connections/station-connection-authority';
import { ApiBaseProvider } from '../ApiBaseContext';

const BANNER = /Request access to reconnect/i;

type ConnectionsApi = ReturnType<typeof useConnections>;

let connections: ConnectionsApi | undefined;

function ConnectionsProbe() {
  connections = useConnections();
  return null;
}

/**
 * A Web-Locks-shaped manager: one queue per lock NAME, callbacks resolved on
 * the microtask queue. Installed on `navigator` so `ConnectionStore` finds it
 * exactly where it looks for the real one.
 */
function installLockManager() {
  const queues = new Map<string, Promise<unknown>>();
  const manager = {
    request(name: string, callback: () => void | Promise<void>) {
      const queue = queues.get(name) ?? Promise.resolve();
      // Deferred to a MACROTASK, not a microtask: `act` drains microtasks, so
      // a microtask-only lock would let the transition land whether or not the
      // SDK awaited it, and this file would assert nothing.
      const run = queue
        .then(() => new Promise((resolve) => setTimeout(resolve, 0)))
        .then(() => callback());
      queues.set(
        name,
        run.then(
          () => undefined,
          () => undefined,
        ),
      );
      return run;
    },
  };
  Object.defineProperty(window.navigator, 'locks', {
    value: manager,
    configurable: true,
    writable: true,
  });
  return manager;
}

const lockManager = installLockManager();

function fetchByPath(routes: Record<string, () => Promise<Response>> = {}) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: unknown) => {
      const url = String(input);
      for (const [path, respond] of Object.entries(routes)) {
        if (url.includes(path)) return respond();
      }
      return new Response('{"error":{"code":"authentication_required"}}', {
        status: 401,
      });
    }),
  );
}

describe('with Web Locks installed, the banner follows the awaited response', () => {
  afterEach(() => {
    connections = undefined;
    vi.unstubAllGlobals();
  });

  it('raises and retires the banner within the tick the response resolves in', async () => {
    const origin = window.location.origin;
    render(
      <ApiBaseProvider>
        <ConnectionsProbe />
        <OnboardingGate>
          <div>App</div>
          <WorkspaceStationState />
        </OnboardingGate>
      </ApiBaseProvider>,
    );
    await screen.findByText('App');
    // The store the provider built must be the one using the installed manager.
    expect(window.navigator.locks).toBe(lockManager);
    const active = connections?.activeConnection;
    if (!active) throw new Error('no active connection to base the test on');
    await act(async () => {
      connections?.markDeviceSession(active.id);
    });
    expect(screen.queryByText(BANNER)).toBeNull();

    fetchByPath();
    await act(async () => {
      await authenticatedFetch(`${origin}/api/boot`);
    });
    // No `waitFor`: the 401 does not resolve before the rejection it reports.
    expect(
      screen.queryByRole('status')?.textContent ?? 'NO RESTRICTION',
    ).toMatch(BANNER);

    fetchByPath({ '/api/': async () => new Response('{"success":true}') });
    await act(async () => {
      await authenticatedFetch(`${origin}/api/settings`);
    });
    expect(screen.queryByRole('status')).toBeNull();
    expect(screen.queryByText(BANNER)).toBeNull();
  });

  it.each([false, true])(
    'dispatches concurrent profile scopes without changing selection and settles B refusal only on B (same origin: %s)',
    async (sameOrigin) => {
      render(
        <ApiBaseProvider>
          <ConnectionsProbe />
        </ApiBaseProvider>,
      );
      const api = connections;
      if (!api?.activeConnection) throw new Error('missing active connection');
      const a = api.activeConnection.id;
      let b = '';
      act(() => {
        api.setCredential(a, 'credential-a');
        b = api.addConnection(
          'B concurrent',
          sameOrigin
            ? 'https://concurrent-same-origin-b.test'
            : 'https://concurrent-b.test',
        ).id;
        api.setCredential(b, 'credential-b');
        if (sameOrigin) api.updateConnection(b, { url: api.apiBase });
      });
      const authorityA = await captureStationConnectionAuthority(a);
      const authorityB = await captureStationConnectionAuthority(b);
      const dispatched: { url: string; credential: string | null }[] = [];
      vi.stubGlobal(
        'fetch',
        vi.fn<typeof fetch>(async (input, init) => {
          const url = String(input);
          dispatched.push({
            url,
            credential: new Headers(init?.headers).get('Authorization'),
          });
          return new Response('{}', {
            status:
              new Headers(init?.headers).get('Authorization') ===
              'Bearer credential-b'
                ? 401
                : 200,
          });
        }),
      );
      await act(async () => {
        const results = await Promise.allSettled([
          authenticatedFetch(`${authorityA.requestScope.apiBase}/api/boot`, {
            requestScope: authorityA.requestScope,
          }),
          authenticatedFetch(`${authorityB.requestScope.apiBase}/api/boot`, {
            requestScope: authorityB.requestScope,
          }),
        ]);
        expect(results[0].status).toBe('fulfilled');
        expect(results[1]).toMatchObject({
          status: 'rejected',
          reason: { name: 'StationRequestAuthorityError' },
        });
      });
      expect(dispatched).toEqual(
        expect.arrayContaining([
          {
            url: `${authorityA.requestScope.apiBase}/api/boot`,
            credential: 'Bearer credential-a',
          },
          {
            url: `${authorityB.requestScope.apiBase}/api/boot`,
            credential: 'Bearer credential-b',
          },
        ]),
      );
      expect(connections?.activeConnection?.id).toBe(a);
      expect(connections?.getConnectionCredential(a)).toBe('credential-a');
      expect(
        connections?.connections.find((item) => item.id === b)?.credentialState,
      ).toBe('required');
      authorityA.release();
      authorityB.release();
    },
  );

  it('does not dispatch a profile that rotates while credential preparation is awaited', async () => {
    render(
      <ApiBaseProvider>
        <ConnectionsProbe />
      </ApiBaseProvider>,
    );
    const api = connections;
    if (!api) throw new Error('missing connections');
    let id = '';
    act(() => {
      id = api.addConnection('B before await', 'https://before-await.test').id;
      api.setCredential(id, 'b-before-await');
    });
    const authority = await captureStationConnectionAuthority(id);
    const fetch = vi.fn<typeof globalThis.fetch>();
    vi.stubGlobal('fetch', fetch);
    const pending = authenticatedFetch('https://before-await.test/api/boot', {
      requestScope: authority.requestScope,
    });
    act(() => api.setCredential(id, 'b-after-await'));
    await expect(pending).rejects.toMatchObject({
      name: 'StationRequestAuthorityError',
    });
    expect(fetch).not.toHaveBeenCalled();
    expect(connections?.getConnectionCredential(id)).toBe('b-after-await');
    authority.release();
  });

  it('rejects retired, rotated and foreign selectors before dispatch and guards delayed response bodies', async () => {
    render(
      <ApiBaseProvider>
        <ConnectionsProbe />
      </ApiBaseProvider>,
    );
    const api = connections;
    if (!api) throw new Error('missing connections');
    let id = '';
    act(() => {
      id = api.addConnection('B delayed', 'https://delayed-b.test').id;
      api.setCredential(id, 'old-b');
    });
    const authority = await captureStationConnectionAuthority(id);
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(new Response('{}'));
    vi.stubGlobal('fetch', fetch);
    const response = await authenticatedFetch(
      'https://delayed-b.test/api/boot',
      { requestScope: authority.requestScope },
    );
    act(() => api.setCredential(id, 'new-b'));
    await expect(response.json()).rejects.toMatchObject({
      name: 'StationRequestAuthorityError',
    });
    await expect(
      authenticatedFetch('https://delayed-b.test/api/boot', {
        requestScope: authority.requestScope,
      }),
    ).rejects.toMatchObject({ name: 'StationRequestAuthorityError' });
    const replacement = await captureStationConnectionAuthority(id);
    await expect(
      authenticatedFetch('https://foreign.test/api/boot', {
        requestScope: replacement.requestScope,
      }),
    ).rejects.toMatchObject({ name: 'StationRequestAuthorityError' });
    replacement.release();
    await expect(
      authenticatedFetch('https://delayed-b.test/api/boot', {
        requestScope: replacement.requestScope,
      }),
    ).rejects.toMatchObject({ name: 'StationRequestAuthorityError' });
    expect(fetch).toHaveBeenCalledOnce();
    authority.release();
  });

  it('does not revive a retired reader when a new source leases the same profile', async () => {
    render(
      <ApiBaseProvider>
        <ConnectionsProbe />
      </ApiBaseProvider>,
    );
    const id = connections?.activeConnection?.id;
    if (!id) throw new Error('missing active connection');
    const old = await captureStationConnectionAuthority(id);
    const current = await captureStationConnectionAuthority(id);
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockImplementation(async () => new Response('{}'));
    vi.stubGlobal('fetch', fetch);
    const response = await authenticatedFetch(
      `${old.requestScope.apiBase}/api/boot`,
      { requestScope: old.requestScope },
    );
    old.release();
    expect(current.isCurrent()).toBe(true);
    expect(current.requestScope.authorityKey).not.toBe(
      old.requestScope.authorityKey,
    );
    await expect(response.json()).rejects.toMatchObject({
      name: 'StationRequestAuthorityError',
    });
    await expect(
      authenticatedFetch(`${current.requestScope.apiBase}/api/boot`, {
        requestScope: current.requestScope,
      }),
    ).resolves.toMatchObject({ status: 200 });
    current.release();
  });

  it('drops a late 401 after profile rotation without retiring the replacement credential', async () => {
    render(
      <ApiBaseProvider>
        <ConnectionsProbe />
      </ApiBaseProvider>,
    );
    const api = connections;
    if (!api) throw new Error('missing connections');
    let id = '';
    act(() => {
      id = api.addConnection('Late response', 'https://late-response.test').id;
      api.setCredential(id, 'late-old');
    });
    const authority = await captureStationConnectionAuthority(id);
    let settle: (response: Response) => void = () => {
      throw new Error('request not issued');
    };
    let dispatched: () => void = () => {};
    const started = new Promise<void>((resolve) => {
      dispatched = resolve;
    });
    vi.stubGlobal(
      'fetch',
      vi.fn<typeof fetch>(
        () =>
          new Promise((resolve) => {
            settle = resolve;
            dispatched();
          }),
      ),
    );
    const pending = authenticatedFetch('https://late-response.test/api/boot', {
      requestScope: authority.requestScope,
    });
    const rejected = expect(pending).rejects.toMatchObject({
      name: 'StationRequestAuthorityError',
    });
    await started;
    act(() => api.setCredential(id, 'late-new'));
    settle(new Response('{}', { status: 401 }));
    await rejected;
    expect(connections?.getConnectionCredential(id)).toBe('late-new');
    expect(
      connections?.connections.find((connection) => connection.id === id)
        ?.credentialState,
    ).toBe('saved');
    authority.release();
  });

  it('stops a pending body chunk at profile rotation while leaving other profiles current', async () => {
    render(
      <ApiBaseProvider>
        <ConnectionsProbe />
      </ApiBaseProvider>,
    );
    const api = connections;
    const activeId = api?.activeConnection?.id;
    if (!api || !activeId) throw new Error('missing connections');
    let id = '';
    act(() => {
      id = api.addConnection(
        'Streaming profile',
        'https://streaming-profile.test',
      ).id;
      api.setCredential(id, 'streaming-old');
    });
    const active = await captureStationConnectionAuthority(activeId);
    const authority = await captureStationConnectionAuthority(id);
    let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
    const body = new ReadableStream<Uint8Array>({
      start(value) {
        controller = value;
      },
    });
    vi.stubGlobal(
      'fetch',
      vi.fn<typeof fetch>().mockResolvedValue(new Response(body)),
    );
    const response = await authenticatedFetch(
      'https://streaming-profile.test/api/events',
      { requestScope: authority.requestScope },
    );
    const reader = response.body!.getReader();
    const encoder = new TextEncoder();
    controller!.enqueue(encoder.encode('data: first\n\n'));
    expect(await reader.read()).toMatchObject({
      done: false,
      value: encoder.encode('data: first\n\n'),
    });
    const pending = reader.read();
    const rejected = expect(pending).rejects.toMatchObject({
      name: 'StationRequestAuthorityError',
    });
    act(() => api.setCredential(id, 'streaming-new'));
    controller!.enqueue(encoder.encode('data: stale\n\n'));
    await rejected;
    expect(active.isCurrent()).toBe(true);
    expect(connections?.getConnectionCredential(id)).toBe('streaming-new');
    await reader.cancel().catch(() => {});
    active.release();
    authority.release();
  });
});
