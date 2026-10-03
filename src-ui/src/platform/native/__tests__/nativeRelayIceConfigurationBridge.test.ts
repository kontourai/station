import type { RelayIceConfigurationV1 } from '@kontourai/station-contracts/relay-ice';
import type {
  SelfHostedBrokerNativeClientSurfaceV2,
  SelfHostedBrokerNativeScopeV2,
} from '@kontourai/station-contracts/self-hosted-broker';
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
type Mutable<T> = { -readonly [Key in keyof T]: T[Key] };

function response(
  expiresAt = now + 40_000,
  responseScope: SelfHostedBrokerNativeScopeV2 = scope,
  responseSurface: SelfHostedBrokerNativeClientSurfaceV2 = surface,
): RelayIceConfigurationV1 {
  return {
    version: 'station-relay-ice-configuration/v1',
    scope: responseScope,
    surface: responseSurface,
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

  test('binds the awaited receipt to copied caller context rather than mutable input', async () => {
    const controller = new AbortController();
    const mutableScope: Mutable<SelfHostedBrokerNativeScopeV2> = { ...scope };
    const mutableSurface: Mutable<SelfHostedBrokerNativeClientSurfaceV2> = {
      ...surface,
    };
    const request = {
      ...input(controller.signal, now + 50_000),
      scope: mutableScope,
      surface: mutableSurface,
    };
    let resolveResponse!: (value: unknown) => void;
    const invoke = vi.fn(
      () =>
        new Promise<unknown>((resolve) => {
          resolveResponse = resolve;
        }),
    );
    const bridge = createNativeRelayIceConfigurationBridge(invoke, () => now);
    const pending = bridge.get(request);

    request.profileName = 'Replacement Station';
    request.expectedProfileRevision = 99;
    request.peerDeadline = now + 30_000;
    request.signal = new AbortController().signal;
    mutableScope.stationId = '44444444-4444-4444-8444-444444444444';
    mutableScope.routingGeneration = 5;
    mutableSurface.keyThumbprint = 'B'.repeat(43);
    expect(invoke).toHaveBeenCalledExactlyOnceWith(
      'station_native_relay_ice_configuration',
      { profileName: 'Home Station', expectedProfileRevision: 12 },
    );
    resolveResponse(response(now + 40_000, mutableScope, mutableSurface));

    await expect(pending).rejects.toThrow('relay_ice_configuration_invalid');

    const expiryRequest = input(new AbortController().signal, now + 50_000);
    let resolveExpiryResponse!: (value: unknown) => void;
    const expiryInvoke = vi.fn(
      () =>
        new Promise<unknown>((resolve) => {
          resolveExpiryResponse = resolve;
        }),
    );
    const expiryBridge = createNativeRelayIceConfigurationBridge(
      expiryInvoke,
      () => now,
    );
    const expiryPending = expiryBridge.get(expiryRequest);
    expiryRequest.peerDeadline = now + 30_000;
    resolveExpiryResponse(response(now + 40_000));
    await expect(expiryPending).rejects.toThrow(
      'native_relay_ice_peer_deadline_uncovered',
    );

    const abortController = new AbortController();
    const abortRequest = input(abortController.signal);
    let resolveAbortResponse!: (value: unknown) => void;
    const abortInvoke = vi.fn(
      () =>
        new Promise<unknown>((resolve) => {
          resolveAbortResponse = resolve;
        }),
    );
    const abortBridge = createNativeRelayIceConfigurationBridge(
      abortInvoke,
      () => now,
    );
    const abortPending = abortBridge.get(abortRequest);
    abortController.abort();
    abortRequest.signal = new AbortController().signal;
    resolveAbortResponse(response());
    await expect(abortPending).rejects.toMatchObject({ name: 'AbortError' });
  });
});
