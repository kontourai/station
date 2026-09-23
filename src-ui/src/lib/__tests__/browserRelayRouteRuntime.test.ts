/** @vitest-environment jsdom */

import type { SavedConnection } from '@kontourai/station-connect';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  read: vi.fn(),
  trustClose: vi.fn(),
  restore: vi.fn(),
  invalidate: vi.fn(),
  connect: vi.fn(),
  peerClose: vi.fn(),
  channelClose: vi.fn(),
  transport: vi.fn(async () => new Response('{}')),
}));

vi.mock('@kontourai/station-connect/connection-trust', () => ({
  openDeviceConnectionTrustStore: async () => ({
    read: mocks.read,
    close: mocks.trustClose,
  }),
}));
vi.mock('@kontourai/station-connect/self-hosted-browser', () => ({
  BrowserRoutingGrantCustody: class {
    restore = mocks.restore;
    invalidate = mocks.invalidate;
  },
  SelfHostedBrokerBrowserClient: class {},
  createBrowserPionConnection: () => ({
    connect: mocks.connect,
    close: mocks.peerClose,
  }),
  createSelfHostedApplicationTransport: () => ({
    transport: mocks.transport,
    transportBindingIsCurrent: () => true,
    close: mocks.channelClose,
  }),
}));

import {
  captureBrowserRelayRoute,
  prepareBrowserRelayRoute,
  retireBrowserRelayRoute,
} from '../browserRelayRouteRuntime';

const scope = {
  stationId: '11111111-1111-4111-8111-111111111111',
  enrollmentId: '22222222-2222-4222-8222-222222222222',
  routingGeneration: 1,
  browserOrigin: window.location.origin,
};
const route = { brokerOrigin: 'https://broker.example.test', scope };
const origin = 'https://station.example.test';
function connection(id: string): SavedConnection {
  return {
    id,
    url: origin,
    brokerRoute: route,
  } as SavedConnection;
}

describe('browser broker route preparation', () => {
  beforeEach(() => {
    for (const mock of Object.values(mocks)) mock.mockReset();
    mocks.read.mockResolvedValue({
      status: 'approved',
      trust: { stationId: scope.stationId, enrollmentId: scope.enrollmentId },
    });
    mocks.restore.mockResolvedValue(true);
    mocks.connect.mockResolvedValue({ applicationOrigin: origin });
  });
  afterEach(() => retireBrowserRelayRoute());

  it('keeps the selected route alive if a replacement has no grant', async () => {
    await prepareBrowserRelayRoute(connection('route-a'), 1);
    expect(captureBrowserRelayRoute('route-a', origin, route)).not.toBeNull();
    mocks.restore.mockResolvedValueOnce(false);
    await expect(
      prepareBrowserRelayRoute(connection('route-b'), 2),
    ).rejects.toThrow('no current routing grant');
    expect(captureBrowserRelayRoute('route-a', origin, route)).not.toBeNull();
    expect(mocks.channelClose).not.toHaveBeenCalled();
  });

  it('retires only the matching selection epoch', async () => {
    await prepareBrowserRelayRoute(connection('route-a'), 1);
    retireBrowserRelayRoute('route-a', 0);
    expect(captureBrowserRelayRoute('route-a', origin, route)).not.toBeNull();
    retireBrowserRelayRoute('route-a', 1);
    expect(captureBrowserRelayRoute('route-a', origin, route)).toBeNull();
  });

  it('does not publish a completed route after selection ownership changes', async () => {
    await prepareBrowserRelayRoute(connection('route-a'), 1);
    await expect(
      prepareBrowserRelayRoute(connection('route-b'), 2, () => false),
    ).rejects.toThrow('superseded');
    expect(captureBrowserRelayRoute('route-a', origin, route)).not.toBeNull();
    expect(captureBrowserRelayRoute('route-b', origin, route)).toBeNull();
  });
});
