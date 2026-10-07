// @vitest-environment jsdom
import type {
  CompletePaired,
  PairingResult,
  PendingPairingExchange,
  StorageAdapter,
} from '@kontourai/station-connect';
import { ConnectionsProvider } from '@kontourai/station-connect';
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
import { ConnectionStore } from '../../../packages/connect/src/core/ConnectionStore';
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
  checkHostCompatibility: vi.fn(async () => ({ blocking: false })),
}));
vi.mock('@kontourai/station-connect', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@kontourai/station-connect')>();
  wire.actualUseConnections = actual.useConnections;
  return {
    ...actual,
    useConnections: wire.useConnections,
    completePendingPairing: wire.completePending,
    JoinDevicePairingPanel: ({
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
async function identify() {
  fireEvent.change(screen.getByLabelText('Station address'), {
    target: { value: 'https://destination.test' },
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
    wire.useConnections.mockImplementation(() => ({
      apiBase: 'https://controller.test',
      activeConnection: { id: 'controller', name: 'Kontour' },
      connections: [],
      addConnection: wire.add,
      commitVerifiedPairing: wire.commit,
      setActiveConnection: wire.select,
      setCredential: wire.credential,
      markDeviceSession: vi.fn(),
      reconcileHandshake: wire.reconcile,
    }));
    wire.completePending.mockReset();
    wire.pairingFailure.mockReset();
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
    wire.add.mockReturnValue({ id: 'saved-remote', name: 'Remote' });
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

  test.each(['immediate', 'pending'] as const)(
    'a grant at an alternate address cannot rebind the controlling Station (%s)',
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
      const controlling = store.add('Kontour', 'https://controller.test');
      store.reconcileHandshake(controlling.id, {
        environmentId: 'remote-station',
        authentication: { scheme: 'bearer', protocolVersion: 1 },
      });
      store.setCredential(controlling.id, 'controlling-origin-grant');
      const view = mount(false, store);
      await identify();
      fireEvent.click(
        screen.getByRole('button', { name: 'Request selected access' }),
      );
      if (mode === 'immediate') {
        fireEvent.click(
          screen.getByRole('button', { name: 'Approve device transport' }),
        );
        await waitFor(() => expect(wire.pairingFailure).toHaveBeenCalledOnce());
        expect(wire.pairingFailure.mock.calls[0][0]).toMatchObject({
          name: 'PairingControllerEndpointConflict',
        });
      } else {
        fireEvent.click(
          screen.getByRole('button', { name: 'Submit device request' }),
        );
        const pendingExchange: PendingPairingExchange =
          view.props.onApprovalPending.mock.calls[0][0];
        const result: PairingResult = {
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
          'Select the new route explicitly',
        );
      }
      expect(store.getActive()?.url).toBe('https://controller.test');
      expect(store.getCredential(controlling.id)).toBe(
        'controlling-origin-grant',
      );
      const alternate = store
        .getAll()
        .find((connection) => connection.url === 'https://destination.test');
      expect(alternate?.environmentId).toBeNull();
      expect(store.getCredential(alternate!.id)).toBeNull();
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
});
