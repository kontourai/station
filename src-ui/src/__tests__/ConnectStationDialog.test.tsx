// @vitest-environment jsdom
import type { PairingResult } from '@kontourai/station-connect';
import type {
  PeerEnrollment,
  PeerEnrollmentInput,
} from '@kontourai/station-contracts/environment-security';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

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
  useHostRequestAuthorityScope: () => ({
    apiBase: 'https://controller.test',
    authorityKey: 'controller-authority',
    isCurrent: () => !wire.stale,
  }),
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
  return {
    ...actual,
    useConnections: () => ({
      apiBase: 'https://controller.test',
      activeConnection: { id: 'controller', name: 'Kontour' },
      connections: [],
      addConnection: wire.add,
      commitVerifiedPairing: wire.commit,
      setActiveConnection: wire.select,
      setCredential: wire.credential,
      markDeviceSession: vi.fn(),
      reconcileHandshake: wire.reconcile,
    }),
    JoinDevicePairingPanel: ({
      onPaired,
    }: {
      onPaired: (result: PairingResult) => Promise<void>;
    }) => (
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
          })
        }
      >
        Approve device transport
      </button>
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
function mount() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const props = {
    isOpen: true,
    intent: { peerOnly: true },
    onClose: vi.fn(),
    onReopen: vi.fn(),
    onApprovalPending: vi.fn(),
  };
  return {
    props,
    ...render(
      <QueryClientProvider client={client}>
        <ConnectStationDialog {...props} />
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
    wire.start.mockRejectedValue(new Error('Connection lost after request'));
    const first = mount();
    await identify();
    fireEvent.click(
      screen.getByRole('button', { name: 'Request selected access' }),
    );
    await screen.findByText('Connection lost after request');
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
});
