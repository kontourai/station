import { beforeEach, expect, it, vi } from 'vitest';

const boundary = vi.hoisted(() => ({
  selection: true,
  binding: vi.fn(),
  bridge: vi.fn(),
  ice: vi.fn(),
  peer: vi.fn(),
  fetch: vi.fn<typeof fetch>(),
}));
const trust = {
  stationId: '11111111-1111-4111-8111-111111111111',
  enrollmentId: '22222222-2222-4222-8222-222222222222',
  generation: 1,
  signingKey: { kty: 'EC', crv: 'P-256', x: 'x'.repeat(43), y: 'y'.repeat(43) },
};
const scope = {
  stationId: trust.stationId,
  enrollmentId: trust.enrollmentId,
  routingGeneration: 1,
};
const surface = {
  kind: 'station-native',
  appIdentifier: 'com.kontourai.station.dev',
  channel: 'dev',
  clientInstanceId: '33333333-3333-4333-8333-333333333333',
  keyThumbprint: 't'.repeat(43),
};
vi.mock('../nativeRelaySignalingBridge', () => ({
  createNativeRelayBindingOwner: (...args: unknown[]) =>
    boundary.binding(...args),
}));
vi.mock('../nativeApplicationSignalingBridge', () => ({
  createNativeApplicationSignalingBridge: (...args: unknown[]) =>
    boundary.bridge(...args),
}));
vi.mock('../nativeRelayIceConfigurationBridge', () => ({
  createNativeRelayIceConfigurationBridge: () => ({ get: boundary.ice }),
}));
vi.mock('@kontourai/station-connect/native-application', () => ({
  createNativeApplicationTransport: (...args: unknown[]) =>
    boundary.peer(...args),
}));

import { createNativeRelayApplicationRuntime } from '../nativeRelayApplicationRuntime';

const origin = 'https://station.example.test';
const currentTrust = {
  current: () => trust,
  isCurrent: () => true,
  recheck: async () => true,
};
beforeEach(() => {
  boundary.selection = true;
  boundary.binding.mockReset().mockResolvedValue({
    binding: { ...trust, scope, surface, trustRevision: 1 },
    trust: currentTrust,
  });
  boundary.bridge
    .mockReset()
    .mockResolvedValue({ trust: currentTrust, signaling: { scope, surface } });
  boundary.ice.mockReset().mockResolvedValue({
    configuration: { iceTransportPolicy: 'relay', iceServers: [] },
    expiresAt: Date.now() + 600_000,
  });
  boundary.fetch.mockReset().mockResolvedValue(Response.json({ data: [] }));
  boundary.peer.mockReset().mockReturnValue({ fetch: boundary.fetch });
});
const runtime = () =>
  createNativeRelayApplicationRuntime({
    route: {
      routeVersion: 1,
      profileName: 'relay',
      profileRevision: 4,
      brokerOrigin: 'https://broker.example.test',
      stationId: trust.stationId,
      enrollmentId: trust.enrollmentId,
    },
    origin,
    bindingId: 'host-binding',
    signal: new AbortController().signal,
    selectionIsCurrent: () => boundary.selection,
  });
it('uses the actual host binding then obtains fresh ICE and a fresh application peer for each read', async () => {
  const owner = await runtime();
  await owner.fetch(`${origin}/api/projects/demo`);
  await owner.fetch(`${origin}/api/projects/demo/shared-work`);
  expect(boundary.binding).toHaveBeenCalledWith(
    expect.objectContaining({
      bindingCommand: 'station_native_relay_application_binding',
      profileName: 'relay',
      profileRevision: 4,
    }),
  );
  expect(boundary.bridge).toHaveBeenCalledTimes(2);
  expect(boundary.ice).toHaveBeenCalledTimes(2);
  expect(boundary.peer).toHaveBeenCalledTimes(2);
  expect(boundary.ice.mock.calls[0][0].peerDeadline).toBeGreaterThanOrEqual(
    Date.now() + 119_000,
  );
  expect(boundary.peer.mock.calls[0][0].configuration.iceTransportPolicy).toBe(
    'relay',
  );
});
it('refuses unsupported operator, foreign-origin and contribution leaves before any peer or ICE request', async () => {
  const owner = await runtime();
  for (const url of [
    `${origin}/config/app`,
    `${origin}/api/projects/demo/layouts`,
    'https://foreign.example.test/api/projects',
  ])
    await expect(owner.fetch(url)).rejects.toThrow('not_supported');
  await expect(
    owner.fetch(`${origin}/api/tasks/task/room/messages`, {
      method: 'POST',
      body: '{}',
    }),
  ).rejects.toThrow('not_supported');
  expect(boundary.ice).not.toHaveBeenCalled();
  expect(boundary.peer).not.toHaveBeenCalled();
});
it('selection retired during ICE prevents peer creation and dispatch', async () => {
  const owner = await runtime();
  boundary.ice.mockImplementationOnce(async () => {
    boundary.selection = false;
    return {
      configuration: { iceTransportPolicy: 'relay', iceServers: [] },
      expiresAt: Date.now() + 600_000,
    };
  });
  await expect(owner.fetch(`${origin}/api/projects`)).rejects.toThrow(
    'retired',
  );
  expect(boundary.peer).not.toHaveBeenCalled();
  expect(boundary.fetch).not.toHaveBeenCalled();
});
