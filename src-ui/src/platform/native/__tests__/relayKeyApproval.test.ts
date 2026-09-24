import { beforeEach, describe, expect, test, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ invokeTauri: vi.fn() }));

vi.mock('../tauriInvoke', () => ({ invokeTauri: mocks.invokeTauri }));

import { nativeRelayKeyApproval } from '../relayKeyApproval';

const route = {
  profileName: 'Home Station',
  brokerOrigin: 'https://broker.example',
  stationId: '11111111-1111-4111-8111-111111111111',
  enrollmentId: '22222222-2222-4222-8222-222222222222',
};

const candidate = {
  pendingId: 'pending-1',
  ...route,
  generation: 3,
  keyId: 'sha256:station-key',
  confirmationCode: 'ABCD1234EFGH5678',
  expiresAt: 1_900_000_000_000,
  trustRevision: 0,
  status: 'pending',
};

const status = {
  ...route,
  keyId: null,
  generation: null,
  trustRevision: 0,
  status: 'untrusted',
};

describe('native relay key approval adapter', () => {
  beforeEach(() => mocks.invokeTauri.mockReset());

  test('parses invitation JSON into the bounded v2 object before native IPC', async () => {
    const invitation = {
      version: 'station-broker-native-route-invitation/v2',
      brokerOrigin: route.brokerOrigin,
      scope: {
        stationId: route.stationId,
        enrollmentId: route.enrollmentId,
        routingGeneration: 3,
      },
      stationSigningKeyId: 'sha256:station-key',
      stationSigningGeneration: 2,
      surface: {
        kind: 'station-native',
        appIdentifier: 'io.kontourai.station',
        channel: 'stable',
        clientInstanceId: 'install-1',
        keyThumbprint: 'sha256:install-key',
      },
      invitationId: 'invite-1',
      invitationSecret: 'secret-that-must-not-be-logged',
      expiresAt: 1_900_000_000_000,
    };
    mocks.invokeTauri.mockResolvedValue(candidate);

    await expect(
      nativeRelayKeyApproval.begin(
        route.profileName,
        JSON.stringify(invitation),
      ),
    ).resolves.toEqual(candidate);
    expect(mocks.invokeTauri).toHaveBeenCalledWith(
      'station_native_relay_key_approval_begin',
      { profileName: route.profileName, invitation },
    );
    expect(mocks.invokeTauri.mock.calls[0][1].invitation).not.toBe(
      JSON.stringify(invitation),
    );
  });

  test('rejects malformed native replies and unsupported invitation input', async () => {
    mocks.invokeTauri.mockResolvedValue({ ...candidate, generation: -1 });
    await expect(
      nativeRelayKeyApproval.pending(route.profileName),
    ).rejects.toThrow('generation');

    await expect(
      nativeRelayKeyApproval.begin(route.profileName, '{not-json'),
    ).rejects.toThrow('valid JSON');
    expect(mocks.invokeTauri).toHaveBeenCalledTimes(1);
  });

  test('preserves a valid null pending result and validates durable status DTO', async () => {
    mocks.invokeTauri.mockResolvedValueOnce(null).mockResolvedValueOnce(status);
    await expect(
      nativeRelayKeyApproval.pending(route.profileName),
    ).resolves.toBeNull();
    await expect(
      nativeRelayKeyApproval.status(route.profileName),
    ).resolves.toEqual(status);
  });

  test('accepts only the expected public P-256 install-key response', async () => {
    const prepared = {
      ...route,
      appIdentifier: 'io.kontourai.station',
      channel: 'stable',
      clientInstanceId: 'install-1',
      keyThumbprint: 'sha256:install-key',
      publicKey: { kty: 'EC', crv: 'P-256', x: 'public-x', y: 'public-y' },
    };
    mocks.invokeTauri.mockResolvedValueOnce(prepared).mockResolvedValueOnce({
      ...prepared,
      publicKey: { ...prepared.publicKey, crv: 'P-384' },
    });

    await expect(
      nativeRelayKeyApproval.prepare(route.profileName),
    ).resolves.toEqual(prepared);
    await expect(
      nativeRelayKeyApproval.prepare(route.profileName),
    ).rejects.toThrow('public key type');
  });
});
