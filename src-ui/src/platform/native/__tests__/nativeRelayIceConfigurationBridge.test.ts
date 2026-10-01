import type { RelayIceConfigurationV1 } from '@kontourai/station-contracts/relay-ice';
import { describe, expect, test, vi } from 'vitest';
import { createNativeRelayIceConfigurationBridge } from '../nativeRelayIceConfigurationBridge';

const now = 1_800_000_000_000;
const scope = {
  stationId: '11111111-1111-4111-8111-111111111111',
  enrollmentId: '22222222-2222-4222-8222-222222222222',
  routingGeneration: 4,
} as const;
const surface = {
  kind: 'station-native',
  appIdentifier: 'io.kontourai.station',
  channel: 'nightly',
  clientInstanceId: '33333333-3333-4333-8333-333333333333',
  keyThumbprint: 'A'.repeat(43),
} as const;

function response(expiresAt = now + 40_000): RelayIceConfigurationV1 {
  return {
    version: 'station-relay-ice-configuration/v1',
    scope,
    surface,
    iceTransportPolicy: 'relay',
    issuedAt: now,
    expiresAt,
    iceServers: [
      {
        urls: ['turns:relay.example:5349?transport=tcp'],
        username: 'short-lived-user',
        credential: 'short-lived-secret',
      },
    ],
  };
}

function input(signal: AbortSignal, peerDeadline = now + 30_000) {
  return {
    profileName: 'Home Station',
    expectedProfileRevision: 12,
    scope,
    surface,
    peerDeadline,
    signal,
  };
}

describe('native relay ICE configuration bridge', () => {
  test('uses the fixed host RPC and returns only relay ICE configuration', async () => {
    const invoke = vi.fn(async () => response());
    const bridge = createNativeRelayIceConfigurationBridge(invoke, () => now);
    const result = await bridge.get(input(new AbortController().signal));

    expect(invoke).toHaveBeenCalledExactlyOnceWith(
      'station_native_relay_ice_configuration',
      { profileName: 'Home Station', expectedProfileRevision: 12 },
    );
    expect(result).toEqual({
      configuration: {
        iceTransportPolicy: 'relay',
        iceServers: [
          {
            urls: ['turns:relay.example:5349?transport=tcp'],
            username: 'short-lived-user',
            credential: 'short-lived-secret',
          },
        ],
      },
      expiresAt: now + 40_000,
    });
  });

  test('does not invoke the host for an already-aborted request and drops a late response', async () => {
    const controller = new AbortController();
    const invoke = vi.fn(async () => response());
    const bridge = createNativeRelayIceConfigurationBridge(invoke, () => now);
    controller.abort();
    await expect(bridge.get(input(controller.signal))).rejects.toMatchObject({
      name: 'AbortError',
    });
    expect(invoke).not.toHaveBeenCalled();

    const lateController = new AbortController();
    let resolveResponse!: (value: unknown) => void;
    const lateInvoke = vi.fn(
      () =>
        new Promise<unknown>((resolve) => {
          resolveResponse = resolve;
        }),
    );
    const lateBridge = createNativeRelayIceConfigurationBridge(
      lateInvoke,
      () => now,
    );
    const pending = lateBridge.get(input(lateController.signal));
    lateController.abort();
    resolveResponse(response());
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  });

  test('refuses credentials that expire before the caller-selected peer deadline', async () => {
    const invoke = vi.fn(async () => response(now + 40_000));
    const bridge = createNativeRelayIceConfigurationBridge(invoke, () => now);
    await expect(
      bridge.get(input(new AbortController().signal, now + 50_000)),
    ).rejects.toThrow('native_relay_ice_peer_deadline_uncovered');
  });
});
