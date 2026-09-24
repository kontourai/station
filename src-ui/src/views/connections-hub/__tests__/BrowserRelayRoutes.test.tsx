/** @vitest-environment jsdom */

import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  connections: [] as Array<Record<string, unknown>>,
  activeConnection: null as Record<string, unknown> | null,
  addBrokerRoute: vi.fn(),
  removeConnection: vi.fn(),
  removeAuthority: vi.fn(),
  select: vi.fn(),
  captureSelectionIntent: vi.fn(),
  conditionalReconnect: vi.fn(),
  readTrust: vi.fn(),
  approveTrust: vi.fn(),
  closeTrust: vi.fn(),
  redeem: vi.fn(),
  saveTurn: vi.fn(),
  forgetTurn: vi.fn(),
  turnIdentity: null as unknown,
  retire: vi.fn(),
  forget: vi.fn(),
  invalidate: vi.fn(),
}));

vi.mock('@kontourai/station-connect', () => ({
  useConnections: () => ({
    connections: mocks.connections,
    activeConnection: mocks.activeConnection,
    addBrokerRoute: mocks.addBrokerRoute,
    removeConnection: mocks.removeConnection,
    setActiveConnection: mocks.select,
    captureSelectionIntent: mocks.captureSelectionIntent,
    reconnectActiveIfSelectionCurrent: mocks.conditionalReconnect,
  }),
}));
vi.mock('../../../platform/PlatformProfileContext', () => ({
  usePlatformProfile: () => ({ isTauri: false }),
}));
vi.mock('@kontourai/station-connect/connection-trust', () => ({
  openDeviceConnectionTrustStore: async () => ({
    read: mocks.readTrust,
    approve: mocks.approveTrust,
    close: mocks.closeTrust,
  }),
}));
vi.mock('@kontourai/station-connect/self-hosted-browser', () => ({
  parseBrokerRouteInvitationUrl: () => ({
    brokerOrigin: 'https://broker.example.test',
    scope: {
      stationId: '11111111-1111-4111-8111-111111111111',
      enrollmentId: '22222222-2222-4222-8222-222222222222',
      routingGeneration: 1,
      browserOrigin: 'http://localhost:3000',
    },
    invitationSecret: 'must-never-enter-saved-route',
  }),
  BrowserRoutingGrantCustody: class {
    forgetRoute = mocks.forget;
    invalidate = mocks.invalidate;
  },
  redeemBrokerRouteInvitation: mocks.redeem,
}));
vi.mock('../../../lib/browserRelayTurnCustody', () => ({
  BrowserRelayTurnCustody: class {
    constructor(identity: unknown) {
      mocks.turnIdentity = identity;
    }
    save = mocks.saveTurn;
    forget = mocks.forgetTurn;
  },
  parseBrowserRelayTurnConfiguration: (value: unknown) => value,
}));
vi.mock('../../../lib/browserRelayApplicationAuthority', () => ({
  removeBrowserRelayApplicationAuthority: mocks.removeAuthority,
}));
vi.mock('../../../lib/browserRelayRouteBinding', () => ({
  retireBrowserRelayRoute: mocks.retire,
}));

import { BrowserRelayRoutes } from '../BrowserRelayRoutes';

const approvedTrust = {
  schemaVersion: 1,
  revision: 1,
  status: 'approved',
  trust: {
    stationId: '11111111-1111-4111-8111-111111111111',
    enrollmentId: '22222222-2222-4222-8222-222222222222',
  },
};

function fillAndAccept(turn?: {
  url?: string;
  username?: string;
  credential?: string;
}) {
  fireEvent.change(screen.getByLabelText('Station name'), {
    target: { value: 'Home Station' },
  });
  fireEvent.change(screen.getByLabelText('Station application address'), {
    target: { value: 'https://station.example.test' },
  });
  fireEvent.change(
    screen.getByLabelText('Broker invitation link or private JSON'),
    {
      target: { value: 'https://client.example.test/#invitation' },
    },
  );
  if (turn?.url)
    fireEvent.change(screen.getByLabelText('TURN server URL'), {
      target: { value: turn.url },
    });
  if (turn?.username)
    fireEvent.change(screen.getByLabelText('TURN username'), {
      target: { value: turn.username },
    });
  if (turn?.credential)
    fireEvent.change(screen.getByLabelText('TURN credential'), {
      target: { value: turn.credential },
    });
  fireEvent.click(screen.getByRole('button', { name: 'Accept route' }));
}

function fillSavedTurnDialog() {
  const dialog = screen.getByRole('dialog');
  fireEvent.change(within(dialog).getByLabelText('TURN server URL'), {
    target: { value: 'turn:127.0.0.1:3478?transport=tcp' },
  });
  fireEvent.change(within(dialog).getByLabelText('TURN username'), {
    target: { value: 'lab-turn-user' },
  });
  fireEvent.change(within(dialog).getByLabelText('TURN credential'), {
    target: { value: 'lab-turn-secret' },
  });
  fireEvent.click(
    within(dialog).getByRole('button', { name: 'Save TURN settings' }),
  );
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (cause: Error) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

describe('browser broker route acceptance', () => {
  beforeEach(() => {
    for (const mock of [
      mocks.addBrokerRoute,
      mocks.removeConnection,
      mocks.removeAuthority,
      mocks.select,
      mocks.captureSelectionIntent,
      mocks.conditionalReconnect,
      mocks.readTrust,
      mocks.approveTrust,
      mocks.closeTrust,
      mocks.redeem,
      mocks.saveTurn,
      mocks.forgetTurn,
      mocks.retire,
      mocks.forget,
      mocks.invalidate,
    ])
      mock.mockReset();
    mocks.connections = [];
    mocks.activeConnection = null;
    mocks.turnIdentity = null;
    mocks.redeem.mockResolvedValue(undefined);
    mocks.saveTurn.mockResolvedValue(undefined);
    mocks.forgetTurn.mockResolvedValue(undefined);
    mocks.removeAuthority.mockResolvedValue(undefined);
    mocks.forget.mockResolvedValue(undefined);
    mocks.captureSelectionIntent.mockReturnValue(0);
    mocks.conditionalReconnect.mockImplementation(async (id: string) => {
      await mocks.select(id);
      return true;
    });
  });

  it('refuses an invitation before redemption when Station trust is absent', async () => {
    mocks.readTrust.mockResolvedValue(null);
    render(<BrowserRelayRoutes />);
    fillAndAccept();
    expect(
      await screen.findByText(
        /Approve this Station’s signing key from the operator’s separate key report/,
      ),
    ).toBeTruthy();
    expect(mocks.redeem).not.toHaveBeenCalled();
    expect(mocks.approveTrust).not.toHaveBeenCalled();
    expect(mocks.addBrokerRoute).not.toHaveBeenCalled();
  });

  it('persists only broker metadata after approved trust and redemption', async () => {
    mocks.readTrust.mockResolvedValue(approvedTrust);
    render(<BrowserRelayRoutes />);
    fillAndAccept();
    await waitFor(() => expect(mocks.addBrokerRoute).toHaveBeenCalledOnce());
    await waitFor(() => expect(mocks.redeem).toHaveBeenCalledOnce());
    expect(mocks.addBrokerRoute).toHaveBeenCalledWith({
      name: 'Home Station',
      applicationOrigin: 'https://station.example.test',
      brokerRoute: {
        brokerOrigin: 'https://broker.example.test',
        scope: expect.objectContaining({
          stationId: approvedTrust.trust.stationId,
        }),
      },
    });
    expect(JSON.stringify(mocks.addBrokerRoute.mock.calls)).not.toContain(
      'must-never-enter-saved-route',
    );
  });

  it('stores local TURN credentials before saving route metadata or spending the invitation', async () => {
    const sequence: string[] = [];
    const secret = 'lab-turn-secret';
    mocks.readTrust.mockResolvedValue(approvedTrust);
    mocks.saveTurn.mockImplementation(async (configuration) => {
      sequence.push('turn');
      expect(configuration).toEqual({
        schemaVersion: 1,
        url: 'turn:127.0.0.1:3478?transport=tcp',
        username: 'lab-turn-user',
        credential: secret,
      });
    });
    mocks.addBrokerRoute.mockImplementation(() => sequence.push('route'));
    mocks.redeem.mockImplementation(async () => sequence.push('redeem'));

    render(<BrowserRelayRoutes />);
    fillAndAccept({
      url: 'turn:127.0.0.1:3478?transport=tcp',
      username: 'lab-turn-user',
      credential: secret,
    });
    await waitFor(() => expect(mocks.redeem).toHaveBeenCalledOnce());

    expect(sequence).toEqual(['turn', 'route', 'redeem']);
    expect(mocks.turnIdentity).toEqual({
      applicationOrigin: 'https://station.example.test',
      browserOrigin: window.location.origin,
      route: {
        brokerOrigin: 'https://broker.example.test',
        scope: expect.objectContaining({
          stationId: approvedTrust.trust.stationId,
        }),
      },
    });
    expect(JSON.stringify(mocks.addBrokerRoute.mock.calls)).not.toContain(
      secret,
    );
  });

  it('does not add or redeem a route when TURN secret custody fails', async () => {
    mocks.readTrust.mockResolvedValue(approvedTrust);
    mocks.saveTurn.mockRejectedValue(new Error('TURN storage is full'));

    render(<BrowserRelayRoutes />);
    fillAndAccept({
      url: 'turn:127.0.0.1:3478?transport=tcp',
      username: 'lab-turn-user',
      credential: 'lab-turn-secret',
    });

    expect(await screen.findByText('TURN storage is full')).toBeTruthy();
    expect(mocks.addBrokerRoute).not.toHaveBeenCalled();
    expect(mocks.redeem).not.toHaveBeenCalled();
  });

  it('changes TURN on a saved active route only after retiring its peer, then reconnects', async () => {
    const sequence: string[] = [];
    const savedRoute = {
      id: 'saved-route',
      name: 'Home Station',
      url: 'https://station.example.test',
      brokerRoute: {
        brokerOrigin: 'https://broker.example.test',
        scope: {
          stationId: approvedTrust.trust.stationId,
          enrollmentId: approvedTrust.trust.enrollmentId,
          routingGeneration: 1,
          browserOrigin: window.location.origin,
        },
      },
    };
    mocks.connections = [savedRoute];
    mocks.activeConnection = savedRoute;
    mocks.retire.mockImplementation(() => sequence.push('retire'));
    mocks.saveTurn.mockImplementation(async () => sequence.push('save'));
    mocks.select.mockImplementation(async () => sequence.push('reconnect'));

    render(<BrowserRelayRoutes />);
    fireEvent.click(screen.getByRole('button', { name: 'Configure TURN' }));
    fillSavedTurnDialog();

    await waitFor(() =>
      expect(mocks.select).toHaveBeenCalledWith('saved-route'),
    );
    expect(sequence).toEqual(['retire', 'save', 'reconnect']);
    expect(mocks.retire).toHaveBeenCalledWith('saved-route');
    expect(mocks.turnIdentity).toEqual({
      applicationOrigin: savedRoute.url,
      browserOrigin: window.location.origin,
      route: savedRoute.brokerRoute,
    });
  });

  it('does not reconnect the edited route if selection changes while TURN storage is pending', async () => {
    const savedRoute = {
      id: 'saved-route',
      name: 'Home Station',
      url: 'https://station.example.test',
      brokerRoute: {
        brokerOrigin: 'https://broker.example.test',
        scope: {
          stationId: approvedTrust.trust.stationId,
          enrollmentId: approvedTrust.trust.enrollmentId,
          routingGeneration: 1,
          browserOrigin: window.location.origin,
        },
      },
    };
    const otherStation = {
      id: 'station-b',
      name: 'Station B',
      url: 'https://station-b.example.test',
    };
    const pendingWrite = deferred<void>();
    mocks.connections = [savedRoute, otherStation];
    mocks.activeConnection = savedRoute;
    mocks.saveTurn.mockReturnValue(pendingWrite.promise);

    const view = render(<BrowserRelayRoutes />);
    fireEvent.click(screen.getByRole('button', { name: 'Configure TURN' }));
    fillSavedTurnDialog();
    await waitFor(() => expect(mocks.saveTurn).toHaveBeenCalledOnce());
    mocks.activeConnection = otherStation;
    view.rerender(<BrowserRelayRoutes />);

    await act(async () => {
      pendingWrite.resolve(undefined);
      await pendingWrite.promise;
    });

    expect(mocks.select).not.toHaveBeenCalled();
    expect(mocks.activeConnection?.id).toBe('station-b');
  });

  it('does not recover the edited route after storage fails if selection changed', async () => {
    const savedRoute = {
      id: 'saved-route',
      name: 'Home Station',
      url: 'https://station.example.test',
      brokerRoute: {
        brokerOrigin: 'https://broker.example.test',
        scope: {
          stationId: approvedTrust.trust.stationId,
          enrollmentId: approvedTrust.trust.enrollmentId,
          routingGeneration: 1,
          browserOrigin: window.location.origin,
        },
      },
    };
    const otherStation = {
      id: 'station-b',
      name: 'Station B',
      url: 'https://station-b.example.test',
    };
    const pendingWrite = deferred<void>();
    mocks.connections = [savedRoute, otherStation];
    mocks.activeConnection = savedRoute;
    mocks.saveTurn.mockReturnValue(pendingWrite.promise);

    const view = render(<BrowserRelayRoutes />);
    fireEvent.click(screen.getByRole('button', { name: 'Configure TURN' }));
    fillSavedTurnDialog();
    await waitFor(() => expect(mocks.saveTurn).toHaveBeenCalledOnce());
    mocks.activeConnection = otherStation;
    view.rerender(<BrowserRelayRoutes />);

    await act(async () => {
      pendingWrite.reject(new Error('TURN storage failed'));
      await pendingWrite.promise.catch(() => undefined);
    });

    expect(mocks.select).not.toHaveBeenCalled();
    expect(mocks.activeConnection?.id).toBe('station-b');
  });

  it('does not run failure recovery reconnect after the TURN dialog unmounts', async () => {
    const savedRoute = {
      id: 'saved-route',
      name: 'Home Station',
      url: 'https://station.example.test',
      brokerRoute: {
        brokerOrigin: 'https://broker.example.test',
        scope: {
          stationId: approvedTrust.trust.stationId,
          enrollmentId: approvedTrust.trust.enrollmentId,
          routingGeneration: 1,
          browserOrigin: window.location.origin,
        },
      },
    };
    const pendingWrite = deferred<void>();
    mocks.connections = [savedRoute];
    mocks.activeConnection = savedRoute;
    mocks.saveTurn.mockReturnValue(pendingWrite.promise);

    const view = render(<BrowserRelayRoutes />);
    fireEvent.click(screen.getByRole('button', { name: 'Configure TURN' }));
    fillSavedTurnDialog();
    await waitFor(() => expect(mocks.saveTurn).toHaveBeenCalledOnce());
    view.unmount();

    await act(async () => {
      pendingWrite.reject(new Error('TURN storage failed'));
      await pendingWrite.promise.catch(() => undefined);
    });

    expect(mocks.select).not.toHaveBeenCalled();
  });

  it('does not save or redeem after the acceptance screen closes during trust lookup', async () => {
    let finishTrust: ((value: typeof approvedTrust) => void) | undefined;
    mocks.readTrust.mockImplementation(
      () =>
        new Promise<typeof approvedTrust>((resolve) => {
          finishTrust = resolve;
        }),
    );
    const view = render(<BrowserRelayRoutes />);
    fillAndAccept();
    await waitFor(() => expect(mocks.readTrust).toHaveBeenCalledOnce());
    view.unmount();
    finishTrust?.(approvedTrust);
    await waitFor(() => expect(mocks.invalidate).toHaveBeenCalled());
    expect(mocks.addBrokerRoute).not.toHaveBeenCalled();
    expect(mocks.redeem).not.toHaveBeenCalled();
  });

  it('refuses an existing route with a different application origin before redeeming', async () => {
    mocks.connections = [
      {
        id: 'existing',
        name: 'Existing Station',
        url: 'https://other-station.example.test',
        brokerRoute: {
          brokerOrigin: 'https://broker.example.test',
          scope: {
            stationId: approvedTrust.trust.stationId,
            enrollmentId: approvedTrust.trust.enrollmentId,
            routingGeneration: 1,
            browserOrigin: 'http://localhost:3000',
          },
        },
      },
    ];
    render(<BrowserRelayRoutes />);
    fillAndAccept();
    expect(
      await screen.findByText(
        /already saved for a different Station application address/,
      ),
    ).toBeTruthy();
    expect(mocks.addBrokerRoute).not.toHaveBeenCalled();
    expect(mocks.redeem).not.toHaveBeenCalled();
  });

  it('does not replace TURN custody when the same route is reaccepted', async () => {
    const existing = {
      id: 'existing',
      name: 'Home Station',
      url: 'https://station.example.test',
      brokerRoute: {
        brokerOrigin: 'https://broker.example.test',
        scope: {
          stationId: approvedTrust.trust.stationId,
          enrollmentId: approvedTrust.trust.enrollmentId,
          routingGeneration: 1,
          browserOrigin: 'http://localhost:3000',
        },
      },
    };
    mocks.readTrust.mockResolvedValue(approvedTrust);
    mocks.connections = [existing];

    render(<BrowserRelayRoutes />);
    fillAndAccept({
      url: 'turn:127.0.0.1:3478?transport=tcp',
      username: 'replacement-user',
      credential: 'replacement-secret',
    });

    expect(
      await screen.findByText(
        /already saved\. Use Configure TURN to change its TURN settings/,
      ),
    ).toBeTruthy();
    expect(mocks.saveTurn).not.toHaveBeenCalled();
    expect(mocks.forgetTurn).not.toHaveBeenCalled();
    expect(mocks.addBrokerRoute).not.toHaveBeenCalled();
    expect(mocks.redeem).not.toHaveBeenCalled();
    expect(mocks.connections).toEqual([existing]);
  });

  it('retires application authority and grant before forgetting the saved route', async () => {
    const sequence: string[] = [];
    mocks.connections = [
      {
        id: 'saved-route',
        name: 'Home Station',
        url: 'https://station.example.test',
        brokerRoute: {
          brokerOrigin: 'https://broker.example.test',
          scope: {
            stationId: approvedTrust.trust.stationId,
            enrollmentId: approvedTrust.trust.enrollmentId,
            routingGeneration: 1,
            browserOrigin: window.location.origin,
          },
        },
      },
    ];
    mocks.forgetTurn.mockImplementation(async () => {
      sequence.push('turn');
    });
    mocks.removeAuthority.mockImplementation(async () => {
      sequence.push('authority');
    });
    mocks.forget.mockImplementation(async () => {
      sequence.push('grant');
    });
    mocks.removeConnection.mockImplementation(() => {
      sequence.push('saved-route');
    });
    render(<BrowserRelayRoutes />);
    fireEvent.click(screen.getByRole('button', { name: 'Forget route' }));
    await waitFor(() =>
      expect(mocks.removeConnection).toHaveBeenCalledWith('saved-route'),
    );
    expect(sequence).toEqual(['turn', 'authority', 'grant', 'saved-route']);
  });

  it('keeps a route available for cleanup retry if application custody is unavailable', async () => {
    mocks.connections = [
      {
        id: 'saved-route',
        name: 'Home Station',
        url: 'https://station.example.test',
        brokerRoute: {
          brokerOrigin: 'https://broker.example.test',
          scope: {
            stationId: approvedTrust.trust.stationId,
            enrollmentId: approvedTrust.trust.enrollmentId,
            routingGeneration: 1,
            browserOrigin: window.location.origin,
          },
        },
      },
    ];
    mocks.removeAuthority.mockRejectedValue(new Error('Custody unavailable'));
    render(<BrowserRelayRoutes />);
    fireEvent.click(screen.getByRole('button', { name: 'Forget route' }));
    expect(await screen.findByText('Custody unavailable')).toBeTruthy();
    expect(mocks.forget).not.toHaveBeenCalled();
    expect(mocks.removeConnection).not.toHaveBeenCalled();
  });
});
