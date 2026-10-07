// @vitest-environment jsdom
import type {
  CompletePaired,
  PairingResult,
  PendingPairingExchange,
  StorageAdapter,
} from '@kontourai/station-connect';
import {
  ConnectionStore,
  ConnectionsProvider,
  completeVerifiedPairing,
  useConnections,
} from '@kontourai/station-connect';
import type {
  PeerEnrollment,
  PeerEnrollmentInput,
} from '@kontourai/station-contracts/environment-security';
import { getJson, setClientCredentialResolver } from '@kontourai/station-sdk';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { PendingPairingReconciler } from '../components/PendingPairingReconciler';

const wire = vi.hoisted(() => ({
  start: vi.fn(),
  get: vi.fn(),
  complete: vi.fn(),
  cancel: vi.fn(),
  add: vi.fn(),
  select: vi.fn(),
  credential: vi.fn(),
  commit: vi.fn(),
  reconcile: vi.fn(),
  stale: false,
  unbound: false,
  useConnections: vi.fn(),
  actualUseConnections: null as
    | typeof import('@kontourai/station-connect')['useConnections']
    | null,
  completePending: vi.fn(),
  pairingFailure: vi.fn(),
  compatibility: vi.fn(),
  joinPanel: vi.fn(),
  fakeJoinPanel: vi.fn(),
  actualJoinPanel: null as
    | typeof import('@kontourai/station-connect')['JoinDevicePairingPanel']
    | null,
}));
vi.mock('@kontourai/station-sdk', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@kontourai/station-sdk')>();
  return { ...actual };
});
vi.mock('../../../packages/sdk/src/client/peer-enrollments', () => ({
  startPeerEnrollment: wire.start,
  getPeerEnrollment: wire.get,
  completePeerEnrollment: wire.complete,
  cancelPeerEnrollment: wire.cancel,
}));
vi.mock('../contexts/ApiBaseContext', () => ({
  useHostRequestAuthorityScope: () =>
    wire.unbound
      ? undefined
      : {
          apiBase: 'https://controller.test',
          authorityKey: 'controller-authority',
          isCurrent: () => !wire.stale,
        },
}));
vi.mock('../platform/PlatformProfileContext', () => ({
  usePlatformProfile: () => ({ isTauri: false }),
}));
vi.mock('../lib/compatibilityLoader', () => ({
  checkHostCompatibility: wire.compatibility,
}));
vi.mock('@kontourai/station-connect', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@kontourai/station-connect')>();
  wire.actualUseConnections = actual.useConnections;
  wire.actualJoinPanel = actual.JoinDevicePairingPanel;
  wire.fakeJoinPanel.mockImplementation(
    ({
      onPaired,
      onApprovalPending,
    }: {
      onPaired: (result: PairingResult) => Promise<void>;
      onApprovalPending: (pending: PendingPairingExchange) => void;
    }) => (
      <>
        <button
          type="button"
          onClick={() =>
            void onPaired({
              endpoint: 'https://destination.test',
              environmentId: 'remote-station',
              clientInstanceId: '14f53f4b-156e-4c9d-a810-f161d519631d',
              device: {
                id: 'device-grant-id',
                name: 'Browser',
                kind: 'device',
                scope: 'orchestration:read orchestration:operate',
                createdAt: 1,
                activityTracking: 'tracked-since-issued',
                lastSeenFrom: null,
                usageCount: 0,
                lastActiveDay: null,
                revokedAt: null,
                revocation: { state: 'not-revoked' },
              },
              credential: 'device-grant',
              browserSession: false,
            }).catch(wire.pairingFailure)
          }
        >
          Approve device transport
        </button>
        <button
          type="button"
          onClick={() =>
            onApprovalPending({
              endpoint: 'https://destination.test',
              expectedEnvironmentId: 'remote-station',
              offerId: 'offer',
              proof: 'request-proof',
              requestId: 'request-id',
              expiresAt: Date.now() + 60_000,
              browserSession: false,
              requestKind: 'direct',
            })
          }
        >
          Submit device request
        </button>
      </>
    ),
  );
  return {
    ...actual,
    useConnections: wire.useConnections,
    completePendingPairing: wire.completePending,
    JoinDevicePairingPanel: wire.joinPanel,
  };
});

import { ConnectStationDialog } from '../views/connections-hub/ConnectStationDialog';

const pending: PeerEnrollment = {
  id: 'request',
  apiBase: 'https://destination.test',
  environmentId: 'remote-station',
  label: 'Remote',
  status: 'pending',
  expiresAt: Date.now() + 60_000,
};
function mount(peerOnly = true, store?: ConnectionStore) {
  if (store) wire.useConnections.mockImplementation(wire.actualUseConnections!);
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const props = {
    isOpen: true,
    intent: { peerOnly },
    onClose: vi.fn(),
    onReopen: vi.fn(),
    onApprovalPending: vi.fn(),
  };
  return {
    props,
    ...render(
      <QueryClientProvider client={client}>
        {store ? (
          <ConnectionsProvider store={store}>
            <ConnectStationDialog {...props} />
          </ConnectionsProvider>
        ) : (
          <ConnectStationDialog {...props} />
        )}
      </QueryClientProvider>,
    ),
    client,
  };
}
async function identify(address = 'https://destination.test') {
  fireEvent.change(screen.getByLabelText('Station address'), {
    target: { value: address },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
  await screen.findByText('remote-station');
}

describe('Connect Station grant composition', () => {
  beforeEach(() => {
    sessionStorage.clear();
    wire.stale = false;
    wire.unbound = false;
    wire.useConnections.mockReset();
    const fixtureValues = new Map<string, string>();
    const fixtureStorage: StorageAdapter = {
      get: (key) => fixtureValues.get(key) ?? null,
      set: (key, value) => {
        fixtureValues.set(key, value);
      },
      remove: (key) => {
        fixtureValues.delete(key);
      },
    };
    const fixtureStore = new ConnectionStore({
      storage: fixtureStorage,
      credentialStorage: fixtureStorage,
    });
    const addedController = fixtureStore.add(
      'Kontour',
      'https://controller.test',
    );
    fixtureStore.reconcileHandshake(addedController.id, {
      environmentId: 'controller-station',
      authentication: { scheme: 'bearer', protocolVersion: 1 },
    });
    const controller = fixtureStore.getActive()!;
    wire.useConnections.mockImplementation(() => ({
      apiBase: 'https://controller.test',
      activeConnection: controller,
      connections: [controller],
      addConnection: wire.add,
      commitVerifiedPairing: wire.commit,
      setActiveConnection: wire.select,
      setCredential: wire.credential,
      markDeviceSession: vi.fn(),
      reconcileHandshake: wire.reconcile,
    }));
    wire.completePending.mockReset();
    wire.pairingFailure.mockReset();
    wire.joinPanel.mockReset();
    wire.joinPanel.mockImplementation(wire.fakeJoinPanel);
    wire.compatibility.mockReset();
    wire.compatibility.mockResolvedValue({
      blocking: false,
      verdict: 'compatible',
      reason: 'Compatible',
    });
    wire.start.mockReset();
    wire.get.mockReset();
    wire.complete.mockReset();
    wire.cancel.mockReset();
    wire.add.mockReset();
    wire.select.mockReset();
    wire.credential.mockReset();
    wire.commit.mockReset();
    wire.reconcile.mockReset();
    wire.start.mockImplementation(
      async (
        _base: string,
        input: PeerEnrollmentInput,
      ): Promise<PeerEnrollment> => ({
        ...pending,
        id: input.id,
      }),
    );
    wire.get.mockImplementation(async (_base, id) => ({ ...pending, id }));
    wire.complete.mockImplementation(async (_base, id) => ({
      ...pending,
      id,
      status: 'connected',
    }));
    wire.add.mockReturnValue(
      fixtureStore.add('Remote', 'https://destination.test'),
    );
    wire.commit.mockResolvedValue('saved-remote');
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(JSON.stringify({ environmentId: 'remote-station' }), {
            status: 200,
          }),
      ),
    );
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    setClientCredentialResolver(undefined);
  });

  test('identifies once, requests peer access from the captured controller, and saves Device access independently without activating it', async () => {
    mount();
    await identify();
    fireEvent.click(
      screen.getByLabelText('Use https://destination.test from this device'),
    );
    fireEvent.click(
      screen.getByRole('button', { name: 'Request selected access' }),
    );
    await waitFor(() => expect(wire.start).toHaveBeenCalledOnce());
    expect(wire.start).toHaveBeenCalledWith(
      'https://controller.test',
      expect.objectContaining({
        apiBase: 'https://destination.test',
        environmentId: 'remote-station',
      }),
      expect.objectContaining({
        requestScope: expect.objectContaining({
          authorityKey: 'controller-authority',
        }),
      }),
    );
    fireEvent.click(
      screen.getByRole('button', { name: 'Approve device transport' }),
    );
    await screen.findByText(/Device access saved/);
    expect(wire.commit).toHaveBeenCalledOnce();
    expect(wire.credential).toHaveBeenCalledWith(
      'saved-remote',
      'device-grant',
    );
    expect(wire.select).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Check approval' }));
    await screen.findByText(/Peer access approved/);
    expect(wire.start).toHaveBeenCalledOnce();
    expect(wire.select).not.toHaveBeenCalled();
  });

  test('a lost start response retains one request reference across reopening and never issues another start automatically', async () => {
    wire.start.mockRejectedValue(
      new Error('Connection lost before reservation was acknowledged'),
    );
    wire.get.mockRejectedValue(new Error('Request reference not found (404)'));
    const first = mount();
    await identify();
    fireEvent.click(
      screen.getByRole('button', { name: 'Request selected access' }),
    );
    await screen.findByText(
      'Connection lost before reservation was acknowledged',
    );
    const reservation = wire.start.mock.calls[0][1].id;
    first.unmount();
    mount();
    await identify();
    await waitFor(() =>
      expect(wire.get).toHaveBeenCalledWith(
        'https://controller.test',
        reservation,
        expect.anything(),
      ),
    );
    expect(wire.start).toHaveBeenCalledOnce();
    expect(
      screen.queryByRole('button', { name: 'Request selected access' }),
    ).toBeNull();
    await screen.findByRole('button', { name: 'Retry this same request' });
    wire.start.mockImplementation(
      async (
        _base: string,
        input: PeerEnrollmentInput,
      ): Promise<PeerEnrollment> => ({ ...pending, id: input.id }),
    );
    fireEvent.click(
      screen.getByRole('button', { name: 'Retry this same request' }),
    );
    await waitFor(() => expect(wire.start).toHaveBeenCalledTimes(2));
    expect(wire.start.mock.calls[1][1].id).toBe(reservation);
  });

  test('an authority change blocks new grants while keeping the reviewed destination visible', async () => {
    const mounted = mount();
    await identify();
    wire.stale = true;
    mounted.rerender(
      <QueryClientProvider client={mounted.client}>
        <ConnectStationDialog {...mounted.props} />
      </QueryClientProvider>,
    );
    expect(screen.getByText('remote-station')).toBeTruthy();
    expect(
      screen.getByRole('button', { name: 'Request selected access' }),
    ).toHaveProperty('disabled', true);
    expect(wire.start).not.toHaveBeenCalled();
  });
  test('a refused status read withdraws cached approval instead of presenting it as current', async () => {
    const mounted = mount();
    await identify();
    fireEvent.click(
      screen.getByRole('button', { name: 'Request selected access' }),
    );
    await waitFor(() => expect(wire.start).toHaveBeenCalledOnce());
    fireEvent.click(screen.getByRole('button', { name: 'Check approval' }));
    await screen.findByText(/Peer access approved/);
    wire.get.mockRejectedValue(new Error('Operator access denied'));
    await act(async () => {
      await mounted.client.invalidateQueries({
        queryKey: ['peer-enrollments'],
      });
    });
    await screen.findByText(/The request status could not be read/);
    expect(screen.queryByText(/Peer access approved/)).toBeNull();
    expect(
      screen.queryByText(/Waiting for approval on the destination/),
    ).toBeNull();
    expect(wire.start).toHaveBeenCalledOnce();
  });
  test('a first Device can identify and pair without a controller scope while peer enrollment stays unavailable', async () => {
    wire.unbound = true;
    const values = new Map<string, string>();
    const storage: StorageAdapter = {
      get: (key) => values.get(key) ?? null,
      set: (key, value) => {
        values.set(key, value);
      },
      remove: (key) => {
        values.delete(key);
      },
    };
    const store = new ConnectionStore({ storage, credentialStorage: storage });
    mount(false, store);
    await identify();
    expect(screen.queryByText(/Station access changed/)).toBeNull();
    expect(
      screen.getByLabelText(/Let .* send work to https:\/\/destination.test/),
    ).toHaveProperty('disabled', true);
    fireEvent.click(
      screen.getByRole('button', { name: 'Request selected access' }),
    );
    fireEvent.click(
      screen.getByRole('button', { name: 'Approve device transport' }),
    );
    await screen.findByText(/Device access saved/);
    const paired = store
      .getAll()
      .find((connection) => connection.url === 'https://destination.test');
    expect(paired?.environmentId).toBe('remote-station');
    expect(store.getCredential(paired!.id)).toBe('device-grant');
    expect(wire.start).not.toHaveBeenCalled();
    expect(wire.get).not.toHaveBeenCalled();
  });

  test.each(['immediate', 'pending'] as const)(
    'approved same-identity endpoint replacement binds the credential to the approved origin (%s)',
    async (mode) => {
      const values = new Map<string, string>();
      const storage: StorageAdapter = {
        get: (key) => values.get(key) ?? null,
        set: (key, value) => {
          values.set(key, value);
        },
        remove: (key) => {
          values.delete(key);
        },
      };
      const store = new ConnectionStore({
        storage,
        credentialStorage: storage,
      });
      const controller = store.add('Kontour', 'https://controller.test');
      const original = store.add(
        'Original destination',
        'https://old-destination.test',
      );
      store.reconcileHandshake(original.id, {
        environmentId: 'remote-station',
        authentication: { scheme: 'bearer', protocolVersion: 1 },
      });
      store.setCredential(original.id, 'old-origin-grant');
      const view = mount(false, store);
      await identify();
      if (mode === 'immediate') {
        fireEvent.click(
          screen.getByRole('button', { name: 'Request selected access' }),
        );
        fireEvent.click(
          screen.getByRole('button', { name: 'Approve device transport' }),
        );
        await screen.findByText(/Device access saved/);
      } else {
        fireEvent.click(
          screen.getByRole('button', { name: 'Request selected access' }),
        );
        fireEvent.click(
          screen.getByRole('button', { name: 'Submit device request' }),
        );
        const pendingExchange: PendingPairingExchange =
          view.props.onApprovalPending.mock.calls[0][0];
        expect(
          store
            .getAll()
            .find(
              (connection) =>
                connection.id === pendingExchange.targetConnectionId,
            )?.url,
        ).toBe('https://destination.test');
        const deviceResult: PairingResult = {
          endpoint: pendingExchange.endpoint,
          environmentId: 'remote-station',
          clientInstanceId: '14f53f4b-156e-4c9d-a810-f161d519631d',
          browserSession: false,
          credential: 'device-grant',
          device: {
            id: 'device',
            name: 'Browser',
            kind: 'device',
            scope: 'orchestration:read',
            createdAt: 1,
            activityTracking: 'tracked-since-issued',
            lastSeenFrom: null,
            usageCount: 0,
            lastActiveDay: null,
            revokedAt: null,
            revocation: { state: 'not-revoked' },
          },
        };
        wire.completePending.mockImplementation(
          async (_pending, options: { completePaired: CompletePaired }) => {
            const committed = await options.completePaired(deviceResult, {
              signal: new AbortController().signal,
            });
            expect(committed).toEqual({ status: 'completed' });
            return { status: 'paired', result: deviceResult };
          },
        );
        const completed = vi.fn();
        render(
          <ConnectionsProvider store={store}>
            <PendingPairingReconciler
              pending={pendingExchange}
              enabled
              onCompleted={completed}
              onTerminalFailure={vi.fn()}
              onConnectionWaiting={vi.fn()}
              onApprovalWaiting={vi.fn()}
            />
          </ConnectionsProvider>,
        );
        await waitFor(() => expect(completed).toHaveBeenCalledOnce());
      }
      const bound = store
        .getAll()
        .find((connection) => connection.environmentId === 'remote-station');
      expect(bound?.url).toBe('https://destination.test');
      expect(store.getCredential(bound!.id)).toBe('device-grant');
      expect(store.getActive()?.id).toBe(controller.id);
      act(() => {
        store.setActive(bound!.id);
      });
      setClientCredentialResolver(() => ({
        origin: store.getActive()!.url,
        credential: store.getCredential(store.getActive()!.id) ?? undefined,
      }));
      const transport = vi.mocked(fetch);
      transport.mockClear();
      transport.mockImplementation(
        async () => new Response('{}', { status: 200 }),
      );
      await getJson('https://destination.test/api/health');
      await getJson('https://old-destination.test/api/health');
      const requests = transport.mock.calls;
      expect(new Headers(requests[0][1]?.headers).get('Authorization')).toBe(
        'Bearer device-grant',
      );
      expect(
        new Headers(requests[1][1]?.headers).get('Authorization'),
      ).toBeNull();
      view.unmount();
    },
  );

  test.each(['https://controller.test', 'https://destination.test'])(
    'selected Station preflight keeps Device access and never starts a replacement at %s',
    async (address) => {
      const values = new Map<string, string>();
      const storage: StorageAdapter = {
        get: (key) => values.get(key) ?? null,
        set: (key, value) => {
          values.set(key, value);
        },
        remove: (key) => {
          values.delete(key);
        },
      };
      const store = new ConnectionStore({
        storage,
        credentialStorage: storage,
      });
      const controlling = store.add('Kontour', 'https://controller.test');
      store.reconcileHandshake(controlling.id, {
        environmentId: 'remote-station',
        authentication: { scheme: 'bearer', protocolVersion: 1 },
      });
      store.setCredential(controlling.id, 'controlling-origin-grant');
      mount(false, store);
      await identify(address);
      expect(
        screen.getByLabelText(`Use ${address} from this device`),
      ).toHaveProperty('disabled', true);
      expect(
        screen.getByRole('button', { name: 'Request selected access' }),
      ).toHaveProperty('disabled', true);
      fireEvent.click(
        screen.getByRole('button', { name: 'Request selected access' }),
      );
      expect(
        screen.queryByRole('button', { name: 'Approve device transport' }),
      ).toBeNull();
      expect(wire.start).not.toHaveBeenCalled();
      expect(
        vi
          .mocked(fetch)
          .mock.calls.every(([url]) =>
            String(url).includes('/.well-known/station/v1'),
          ),
      ).toBe(true);
      expect(store.getActive()?.url).toBe('https://controller.test');
      expect(store.getCredential(controlling.id)).toBe(
        'controlling-origin-grant',
      );
    },
  );

  test.each([
    ['immediate', 'https://controller.test'],
    ['pending', 'https://controller.test'],
    ['immediate', 'https://destination.test'],
    ['pending', 'https://destination.test'],
  ] as const)(
    'approved Device access cannot replace the selected controller (%s at %s)',
    async (mode, address) => {
      const values = new Map<string, string>();
      const storage: StorageAdapter = {
        get: (key) => values.get(key) ?? null,
        set: (key, value) => {
          values.set(key, value);
        },
        remove: (key) => {
          values.delete(key);
        },
      };
      const store = new ConnectionStore({
        storage,
        credentialStorage: storage,
      });
      const controlling = store.add('Kontour', 'https://controller.test');
      store.reconcileHandshake(controlling.id, {
        environmentId: 'remote-station',
        authentication: { scheme: 'bearer', protocolVersion: 1 },
      });
      store.setCredential(controlling.id, 'controlling-origin-grant');
      const target =
        address === 'https://controller.test'
          ? controlling
          : store.add('Approved address', address);
      wire.useConnections.mockImplementation(wire.actualUseConnections!);
      const result: PairingResult = {
        endpoint: address,
        environmentId: 'remote-station',
        clientInstanceId: '14f53f4b-156e-4c9d-a810-f161d519631d',
        browserSession: false,
        credential: 'replacement-device-grant',
        device: {
          id: 'replacement-device',
          name: 'Browser',
          kind: 'device',
          scope: 'orchestration:read',
          createdAt: 1,
          activityTracking: 'tracked-since-issued',
          lastSeenFrom: null,
          usageCount: 0,
          lastActiveDay: null,
          revokedAt: null,
          revocation: { state: 'not-revoked' },
        },
      };
      if (mode === 'immediate') {
        let context: ReturnType<typeof useConnections> | undefined;
        function CapturePairingOwner() {
          context = useConnections();
          return null;
        }
        render(
          <ConnectionsProvider store={store}>
            <CapturePairingOwner />
          </ConnectionsProvider>,
        );
        await expect(
          completeVerifiedPairing(
            context!,
            {
              connectionId: target.id,
              name: target.name,
              endpoint: address,
              activate: false,
              bindApprovedEndpoint: true,
            },
            result,
          ),
        ).rejects.toMatchObject({ name: 'PairingControllerEndpointConflict' });
      } else {
        const pendingExchange: PendingPairingExchange = {
          endpoint: address,
          expectedEnvironmentId: 'remote-station',
          offerId: 'offer',
          proof: 'request-proof',
          requestId: 'approved-request',
          expiresAt: Date.now() + 60_000,
          browserSession: false,
          requestKind: 'direct',
          targetConnectionId: target.id,
          activateConnection: false,
        };
        wire.completePending.mockImplementation(
          async (_pending, options: { completePaired: CompletePaired }) => {
            const outcome = await options.completePaired(result, {
              signal: new AbortController().signal,
            });
            expect(outcome.status).toBe('failed');
            return {
              status: 'post-exchange-failed',
              failure:
                outcome.status === 'failed' ? outcome.failure : undefined,
            };
          },
        );
        const failure = vi.fn();
        render(
          <ConnectionsProvider store={store}>
            <PendingPairingReconciler
              pending={pendingExchange}
              enabled
              onCompleted={vi.fn()}
              onTerminalFailure={failure}
              onConnectionWaiting={vi.fn()}
              onApprovalWaiting={vi.fn()}
            />
          </ConnectionsProvider>,
        );
        await waitFor(() => expect(failure).toHaveBeenCalledOnce());
        expect(failure.mock.calls[0][1]).toContain(
          'Use Reconnect or Request access',
        );
      }
      expect(store.getActive()?.url).toBe('https://controller.test');
      expect(store.getCredential(controlling.id)).toBe(
        'controlling-origin-grant',
      );
      if (target.id !== controlling.id) {
        expect(
          store.getAll().find((connection) => connection.id === target.id)
            ?.environmentId,
        ).toBeNull();
        expect(store.getCredential(target.id)).toBeNull();
      }
      setClientCredentialResolver(() => ({
        origin: store.getActive()!.url,
        credential: store.getCredential(store.getActive()!.id) ?? undefined,
      }));
      const transport = vi.mocked(fetch);
      transport.mockClear();
      transport.mockImplementation(
        async () => new Response('{}', { status: 200 }),
      );
      await getJson('https://controller.test/api/health');
      await getJson('https://destination.test/api/health');
      expect(
        new Headers(transport.mock.calls[0][1]?.headers).get('Authorization'),
      ).toBe('Bearer controlling-origin-grant');
      expect(
        new Headers(transport.mock.calls[1][1]?.headers).get('Authorization'),
      ).toBeNull();
    },
  );
  test('an unreadable cross-origin browser handshake explains origin configuration without declaring the receiver unreachable or submitting enrollment', async () => {
    wire.compatibility.mockResolvedValue({
      blocking: true,
      verdict: 'unknown',
      reason:
        'Station compatibility could not be verified because the host could not be reached.',
    });
    mount(false);
    fireEvent.change(screen.getByLabelText('Station address'), {
      target: { value: 'https://destination.test' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    await screen.findByRole('region', { name: 'Browser connection guidance' });
    expect(screen.getByRole('alert').textContent).toContain(
      'This browser could not verify',
    );
    expect(screen.getByRole('alert').textContent).not.toContain(
      'host could not be reached',
    );
    expect(
      screen.getByText(`--allowed-origin=${window.location.origin}`),
    ).toBeTruthy();
    expect(
      screen.getByText(
        'No access request was submitted during this identification check.',
      ),
    ).toBeTruthy();
    expect(
      screen.getByRole('link', {
        name: 'open the destination Station directly',
      }),
    ).toHaveProperty('href', 'https://destination.test/');
    expect(wire.start).not.toHaveBeenCalled();
    expect(wire.commit).not.toHaveBeenCalled();
    expect(
      screen.queryByRole('button', { name: 'Approve device transport' }),
    ).toBeNull();
  });
  test('a real refused cross-origin Device request retains its refusal and offers a usable alternative without saving a grant', async () => {
    localStorage.clear();
    wire.joinPanel.mockImplementation(wire.actualJoinPanel!);
    const transport = vi.mocked(fetch);
    transport.mockImplementation(async (input) => {
      const url = new URL(String(input));
      if (url.pathname === '/.well-known/station/v1')
        return Response.json({ environmentId: 'remote-station' });
      if (url.pathname === '/.well-known/station/v1/pairing/access-request')
        return Response.json({ error: 'origin_forbidden' }, { status: 403 });
      throw new Error(`Unexpected request ${url.pathname}`);
    });
    mount(false);
    await identify();
    fireEvent.click(
      screen.getByRole('button', { name: 'Request selected access' }),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Request access' }));
    await screen.findByText(
      'This Station does not allow access requests from this app address.',
    );
    expect(
      screen.getByRole('complementary', { name: 'Browser Device pairing' })
        .textContent,
    ).toContain('If access requests are refused in this browser');
    expect(
      screen.getByRole('link', {
        name: 'open the destination directly in another tab',
      }),
    ).toHaveProperty('href', 'https://destination.test/');
    expect(
      transport.mock.calls.some(
        ([url, init]) =>
          String(url).endsWith('/pairing/access-request') &&
          init?.method === 'POST',
      ),
    ).toBe(true);
    expect(wire.start).not.toHaveBeenCalled();
    expect(wire.commit).not.toHaveBeenCalled();
    expect(wire.credential).not.toHaveBeenCalled();
    expect(wire.select).not.toHaveBeenCalled();
    localStorage.clear();
  });
});
