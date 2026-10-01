import type { ApprovedStationConnectionTrust } from '@kontourai/station-contracts/connection-proof';
import type { SelfHostedBrokerNativeClientSurfaceV2 } from '@kontourai/station-contracts/self-hosted-broker';
import { beforeEach, describe, expect, test, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  openPeer: vi.fn(),
  createPeerTransport: vi.fn(),
}));

vi.mock(
  '@kontourai/station-connect/native-application',
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import('@kontourai/station-connect/native-application')
      >();
    return {
      ...actual,
      createNativeVerifiedPeerTransport: (input: unknown) => {
        mocks.createPeerTransport(input);
        return {
          openVerifiedPeer: (signal: AbortSignal) =>
            mocks.openPeer(input, signal),
        };
      },
    };
  },
);

import type { NativeVerifiedPeerSignaling } from '@kontourai/station-connect/native-application';
import { createNativeEnrollmentSignalingBridge } from '../nativeEnrollmentSignalingBridge';
import type { NativeRelayBindingDto } from '../nativeRelaySignalingBridge';

let now = 1_800_000_000_000;
const stationId = '11111111-1111-4111-8111-111111111111';
const enrollmentId = '22222222-2222-4222-8222-222222222222';
const scope = { stationId, enrollmentId, routingGeneration: 4 } as const;
const surface: SelfHostedBrokerNativeClientSurfaceV2 = {
  kind: 'station-native',
  appIdentifier: 'io.kontourai.station',
  channel: 'nightly',
  clientInstanceId: '33333333-3333-4333-8333-333333333333',
  keyThumbprint: 'A'.repeat(43),
};
const signingKey = {
  kty: 'EC' as const,
  crv: 'P-256' as const,
  x: 'public-x',
  y: 'public-y',
};
const trust: ApprovedStationConnectionTrust = {
  stationId,
  enrollmentId,
  generation: 7,
  signingKey,
};
const binding: NativeRelayBindingDto = {
  profileName: 'Home Station',
  profileRevision: 12,
  scope,
  surface,
  trustRevision: 5,
  stationId,
  enrollmentId,
  generation: 7,
  signingKey,
};
const peerHandle = 'H'.repeat(43);
const nonce = 'N'.repeat(43);
const audience = 'https://station.example';

function prepared(overrides: Record<string, unknown> = {}) {
  return {
    version: 'station-native-enrollment-peer/v1',
    peerHandle,
    nonce,
    connectionId: surface.clientInstanceId,
    expiresAt: now + 120_000,
    scope: { ...scope },
    surface: { ...surface },
    stationAudience: audience,
    trust: { ...trust, signingKey: { ...signingKey } },
    ...overrides,
  };
}

function iceConfiguration() {
  return {
    version: 'station-relay-ice-configuration/v1',
    scope: { ...scope },
    surface: { ...surface },
    iceTransportPolicy: 'relay',
    issuedAt: now,
    expiresAt: now + 600_000,
    iceServers: [
      {
        urls: ['turns:relay.example:5349?transport=tcp'],
        username: 'short-lived-user',
        credential: 'short-lived-secret',
      },
    ],
  };
}

function createBridge(
  overrides: {
    prepared?: unknown | (() => unknown);
    close?: () => unknown | Promise<unknown>;
  } = {},
) {
  const invoke = vi.fn(
    async (
      command: string,
      _args?: Record<string, unknown>,
    ): Promise<unknown> => {
      if (command === 'station_native_relay_enrollment_binding') return binding;
      if (command === 'station_native_relay_ice_configuration')
        return iceConfiguration();
      if (command === 'station_native_enrollment_peer_prepare')
        return typeof overrides.prepared === 'function'
          ? overrides.prepared()
          : (overrides.prepared ?? prepared());
      if (command === 'station_native_enrollment_peer_open')
        return { expiresAt: now + 100_000 };
      if (command === 'station_native_enrollment_peer_read')
        return {
          version: 'station-broker-native-connection-answer/v2',
          answerSdp: 'verified-answer-sdp',
          stationProof: 'verified-station-proof',
          expiresAt: now + 90_000,
        };
      if (command === 'station_native_enrollment_peer_close')
        return overrides.close?.();
      throw new Error(`Unexpected native enrollment command: ${command}`);
    },
  );
  const channel = {
    send: vi.fn(),
    close: vi.fn(),
    subscribe: vi.fn(() => () => {}),
  };
  mocks.openPeer.mockImplementation(
    async (
      transportInput: {
        signaling: NativeVerifiedPeerSignaling;
        origin: string;
        trust: {
          current(): ApprovedStationConnectionTrust | null;
          recheck(
            value: ApprovedStationConnectionTrust,
            stage: 'checkpoint' | 'before-remote-description',
          ): Promise<boolean>;
        };
      },
      signal: AbortSignal,
    ) => {
      const peer = await transportInput.signaling.prepare(signal);
      await transportInput.signaling.open(peer.peerHandle, 'offer-sdp', signal);
      await transportInput.signaling.read(peer.peerHandle, signal);
      return {
        peer,
        stationAudience: transportInput.origin,
        channel,
        assertCurrent: async () => {
          const current = transportInput.trust.current();
          if (
            !current ||
            !(await transportInput.trust.recheck(current, 'checkpoint'))
          )
            throw new Error('test_binding_stale');
        },
        close: () => transportInput.signaling.close(peer.peerHandle),
      };
    },
  );
  mocks.createPeerTransport.mockClear();
  return {
    invoke,
    channel,
    create: (signal: AbortSignal) =>
      createNativeEnrollmentSignalingBridge({
        profileName: 'Home Station',
        expectedProfileRevision: 12,
        stationAudience: audience,
        signal,
        invoke: { invoke },
        now: () => now,
      }),
  };
}

beforeEach(() => {
  now = 1_800_000_000_000;
});

describe('native enrollment signaling bridge', () => {
  test('uses the enrollment peer version, bound ICE config, fixed commands and awaited host close', async () => {
    let releaseClose!: () => void;
    const closePromise = new Promise<void>((resolve) => {
      releaseClose = resolve;
    });
    const fixture = createBridge({ close: () => closePromise });
    const signal = new AbortController().signal;
    const bridge = fixture.create(signal);
    const opened = await bridge.open(signal);

    expect(mocks.createPeerTransport).toHaveBeenCalledWith(
      expect.objectContaining({
        peerVersion: 'station-native-enrollment-peer/v1',
        origin: audience,
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
      }),
    );
    expect(opened.peer).toEqual({
      peerHandle,
      stationAudience: audience,
      expiresAt: now + 120_000,
    });
    expect(fixture.invoke).toHaveBeenCalledWith(
      'station_native_relay_enrollment_binding',
      { profileName: 'Home Station', expectedProfileRevision: 12 },
    );
    expect(fixture.invoke).toHaveBeenCalledWith(
      'station_native_enrollment_peer_prepare',
      { profileName: 'Home Station', expectedProfileRevision: 12 },
    );
    expect(fixture.invoke).toHaveBeenCalledWith(
      'station_native_enrollment_peer_open',
      { peerHandle, offerSdp: 'offer-sdp' },
    );
    expect(fixture.invoke).toHaveBeenCalledWith(
      'station_native_enrollment_peer_read',
      { peerHandle },
    );
    const commands = fixture.invoke.mock.calls.map(([command]) => command);
    expect(
      commands.indexOf('station_native_relay_ice_configuration'),
    ).toBeLessThan(commands.indexOf('station_native_enrollment_peer_prepare'));
    const bindingReadbacks = fixture.invoke.mock.calls.filter(
      ([command]) => command === 'station_native_relay_enrollment_binding',
    ).length;
    await opened.assertCurrent();
    expect(
      fixture.invoke.mock.calls.filter(
        ([command]) => command === 'station_native_relay_enrollment_binding',
      ),
    ).toHaveLength(bindingReadbacks + 1);

    let closed = false;
    const closing = opened.close().then(() => {
      closed = true;
    });
    await vi.waitFor(() =>
      expect(fixture.invoke).toHaveBeenCalledWith(
        'station_native_enrollment_peer_close',
        { peerHandle },
      ),
    );
    expect(closed).toBe(false);
    releaseClose();
    await closing;
    expect(closed).toBe(true);
  });

  test('rejects a prepared peer from a replacement scope and closes its actual handle', async () => {
    const fixture = createBridge({
      prepared: prepared({
        scope: {
          ...scope,
          stationId: '44444444-4444-4444-8444-444444444444',
        },
      }),
    });
    const signal = new AbortController().signal;
    const bridge = fixture.create(signal);

    await expect(bridge.open(signal)).rejects.toThrow(
      'native_enrollment_peer_binding_mismatch',
    );
    expect(fixture.invoke).toHaveBeenCalledWith(
      'station_native_enrollment_peer_close',
      { peerHandle },
    );
    expect(fixture.invoke).not.toHaveBeenCalledWith(
      'station_native_enrollment_peer_open',
      expect.anything(),
    );
  });

  test('closes the real handle returned by an aborted late prepare', async () => {
    let resolvePrepare!: (value: unknown) => void;
    const fixture = createBridge();
    fixture.invoke.mockImplementation(async (command, args) => {
      if (command === 'station_native_enrollment_peer_prepare')
        return new Promise<unknown>((resolve) => {
          resolvePrepare = resolve;
        });
      return createBridgeResponse(command, args);
    });
    const controller = new AbortController();
    const bridge = fixture.create(controller.signal);
    const opening = bridge.open(controller.signal);
    await vi.waitFor(() =>
      expect(fixture.invoke).toHaveBeenCalledWith(
        'station_native_enrollment_peer_prepare',
        { profileName: 'Home Station', expectedProfileRevision: 12 },
      ),
    );
    controller.abort();
    await expect(opening).rejects.toMatchObject({ name: 'AbortError' });
    resolvePrepare(prepared());
    await vi.waitFor(() =>
      expect(fixture.invoke).toHaveBeenCalledWith(
        'station_native_enrollment_peer_close',
        { peerHandle },
      ),
    );
  });

  test('retains failed-close handles through host expiry, then reclaims capacity', async () => {
    const startTime = now;
    const handles = ['A', 'B', 'C', 'D', 'E'].map((letter) =>
      letter.repeat(43),
    );
    let nextPeer = 0;
    let allowClose = false;
    const fixture = createBridge({
      prepared: () => {
        const handle = handles[nextPeer++];
        return prepared({
          peerHandle: handle,
          nonce: `${handle.slice(0, 42)}N`,
          expiresAt: now + 120_000,
        });
      },
      close: () => {
        if (!allowClose) throw new Error('host close unavailable');
      },
    });
    const signal = new AbortController().signal;
    const bridge = fixture.create(signal);
    const peers = [await bridge.open(signal)];

    await expect(peers[0].close()).rejects.toThrow();
    for (let index = 0; index < 3; index += 1)
      peers.push(await bridge.open(signal));

    await expect(bridge.open(signal)).rejects.toThrow(
      'native_enrollment_peer_capacity_reached',
    );
    expect(nextPeer).toBe(4);

    now = startTime + 120_001;
    const recovered = await bridge.open(signal);
    expect(recovered.peer.peerHandle).toBe(handles[4]);
    allowClose = true;
    await Promise.all([...peers, recovered].map((peer) => peer.close()));
  });
});

function createBridgeResponse(
  command: string,
  _args?: Record<string, unknown>,
) {
  if (command === 'station_native_relay_enrollment_binding') return binding;
  if (command === 'station_native_relay_ice_configuration')
    return iceConfiguration();
  if (command === 'station_native_enrollment_peer_open')
    return { expiresAt: now + 100_000 };
  if (command === 'station_native_enrollment_peer_read')
    return {
      version: 'station-broker-native-connection-answer/v2',
      answerSdp: 'verified-answer-sdp',
      stationProof: 'verified-station-proof',
      expiresAt: now + 90_000,
    };
  if (command === 'station_native_enrollment_peer_close') return undefined;
  throw new Error(`Unexpected native enrollment command: ${command}`);
}
