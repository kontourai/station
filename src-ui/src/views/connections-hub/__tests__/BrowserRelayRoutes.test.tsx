/** @vitest-environment jsdom */

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  connections: [] as Array<Record<string, unknown>>,
  addBrokerRoute: vi.fn(),
  removeConnection: vi.fn(),
  select: vi.fn(),
  readTrust: vi.fn(),
  closeTrust: vi.fn(),
  redeem: vi.fn(),
  forget: vi.fn(),
  invalidate: vi.fn(),
}));

vi.mock('@kontourai/station-connect', () => ({
  useConnections: () => ({
    connections: mocks.connections,
    activeConnection: null,
    addBrokerRoute: mocks.addBrokerRoute,
    removeConnection: mocks.removeConnection,
    setActiveConnection: mocks.select,
  }),
}));
vi.mock('../../../platform/PlatformProfileContext', () => ({
  usePlatformProfile: () => ({ isTauri: false }),
}));
vi.mock('@kontourai/station-connect/connection-trust', () => ({
  openDeviceConnectionTrustStore: async () => ({
    read: mocks.readTrust,
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

function fillAndAccept() {
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
  fireEvent.click(screen.getByRole('button', { name: 'Accept route' }));
}

describe('browser broker route acceptance', () => {
  beforeEach(() => {
    for (const mock of Object.values(mocks)) {
      if ('mockReset' in mock) mock.mockReset();
    }
    mocks.connections = [];
    mocks.redeem.mockResolvedValue(undefined);
  });

  it('refuses an invitation before redemption when Station trust is absent', async () => {
    mocks.readTrust.mockResolvedValue(null);
    render(<BrowserRelayRoutes />);
    fillAndAccept();
    expect(
      await screen.findByText(
        /Approve this Station’s signing key independently/,
      ),
    ).toBeTruthy();
    expect(mocks.redeem).not.toHaveBeenCalled();
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
});
