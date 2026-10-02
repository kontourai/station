import { emptyStationProfileStore } from '@kontourai/station-contracts';
import type { SelfHostedBrokerNativeRouteInvitationV2 } from '@kontourai/station-contracts/self-hosted-broker';
import { describe, expect, test, vi } from 'vitest';
import { createNativeRelayGrantAdapter } from '../nativeRelayGrantAdapter';

const route = {
  brokerOrigin: 'https://broker.example',
  stationId: '11111111-1111-4111-8111-111111111111',
  enrollmentId: '22222222-2222-4222-8222-222222222222',
  routingGeneration: 4,
  grantId: 'abcdefghijklmnopqrstuv',
};
const expectedRoute = {
  brokerOrigin: route.brokerOrigin,
  stationId: route.stationId,
  enrollmentId: route.enrollmentId,
};
const metadata = {
  route,
  stationSigningKeyId: 'sha256:station-signing-key',
  stationSigningGeneration: 3,
  expiresAt: Date.now() + 60_000,
};
const status = {
  profileName: 'Home Station',
  profileRevision: 12,
  stationId: route.stationId,
  enrollmentId: route.enrollmentId,
  grants: [{ metadata, expired: false }],
  cleanups: [],
};
const invitation: SelfHostedBrokerNativeRouteInvitationV2 = {
  version: 'station-broker-native-route-invitation/v2',
  brokerOrigin: route.brokerOrigin,
  scope: {
    stationId: route.stationId,
    enrollmentId: route.enrollmentId,
    routingGeneration: 4,
  },
  stationSigningKeyId: 'sha256:station-signing-key',
  stationSigningGeneration: 3,
  surface: {
    kind: 'station-native',
    appIdentifier: 'io.kontourai.station',
    channel: 'nightly',
    clientInstanceId: '33333333-3333-4333-8333-333333333333',
    keyThumbprint: 'sha256:install-proof',
  },
  invitationId: 'abcdefghijklmnopqrstuv',
  invitationSecret: 'a'.repeat(43),
  expiresAt: Date.now() + 60_000,
};

function profileStore(
  revision = 12,
  updatedAt = 2,
  selectedRoute = expectedRoute,
) {
  const store = emptyStationProfileStore();
  store.revision = revision;
  store.profiles.push({
    schemaVersion: 1,
    name: 'Home Station',
    endpoint: 'https://station.example',
    setupSource: 'manual',
    configurationState: 'unconfigured',
    createdAt: 1,
    updatedAt,
    clientInstanceId: '33333333-3333-4333-8333-333333333333',
    relayRoute: selectedRoute,
  });
  return store;
}

function hostInvoker(
  handler: (command: string, args?: Record<string, unknown>) => unknown,
) {
  return async <T>(command: string, args?: Record<string, unknown>) =>
    (await handler(command, args)) as T;
}

describe('native relay grant adapter', () => {
  test('reads secret-free status only for the selected saved route', async () => {
    const handler = vi.fn(async () => status);
    const adapter = createNativeRelayGrantAdapter(hostInvoker(handler));

    await expect(
      adapter.status({ profileName: 'Home Station', expectedRoute }),
    ).resolves.toMatchObject(status);
    expect(handler).toHaveBeenCalledWith('station_native_relay_grant_status', {
      profileName: 'Home Station',
    });
    expect(JSON.stringify(status)).not.toContain('credential');
  });

  test('refuses unknown secret-bearing fields and mismatched route metadata', async () => {
    const handler = vi.fn(
      async (): Promise<unknown> => ({
        ...status,
        grants: [
          { metadata, expired: false, credential: 'should-never-render' },
        ],
      }),
    );
    const adapter = createNativeRelayGrantAdapter(hostInvoker(handler));
    await expect(
      adapter.status({ profileName: 'Home Station', expectedRoute }),
    ).rejects.toMatchObject({ code: 'metadata' });

    handler.mockResolvedValueOnce({
      ...status,
      grants: [
        {
          metadata: { ...metadata, route: { ...route, stationId: 'other' } },
          expired: false,
        },
      ],
    });
    await expect(
      adapter.status({ profileName: 'Home Station', expectedRoute }),
    ).rejects.toMatchObject({ code: 'metadata' });
  });

  test('submits the parsed invitation with the host CAS revision and validates secret-free result', async () => {
    const handler = vi.fn(
      async (command: string): Promise<unknown> =>
        command === 'station_profile_store_read'
          ? profileStore()
          : { status: 'redeemed', grant: metadata },
    );
    const adapter = createNativeRelayGrantAdapter(hostInvoker(handler));
    const result = await adapter.redeem({
      profileName: 'Home Station',
      expectedProfileRevision: 12,
      expectedUpdatedAt: 2,
      invitationJson: JSON.stringify(invitation),
      expectedRoute,
    });
    expect(result).toEqual({ status: 'redeemed', grant: metadata });
    expect(handler).toHaveBeenCalledWith(
      'station_profile_store_read',
      undefined,
    );
    expect(handler).toHaveBeenCalledWith('station_native_relay_grant_redeem', {
      profileName: 'Home Station',
      expectedProfileRevision: 12,
      invitation,
    });
    expect(JSON.stringify(result)).not.toContain(invitation.invitationSecret);
  });

  test('maps only known failure enums and rejects malformed expiry values', async () => {
    const handler = vi.fn(
      async (command: string): Promise<unknown> =>
        command === 'station_profile_store_read'
          ? profileStore()
          : {
              status: 'failed',
              failure: {
                primary: 'stationTrustRequired',
                cleanup: 'notAttempted',
                recovery: null,
              },
            },
    );
    const adapter = createNativeRelayGrantAdapter(hostInvoker(handler));
    await expect(
      adapter.redeem({
        profileName: 'Home Station',
        expectedProfileRevision: 12,
        expectedUpdatedAt: 2,
        invitationJson: JSON.stringify(invitation),
        expectedRoute,
      }),
    ).resolves.toEqual({
      status: 'failed',
      failure: {
        primary: 'stationTrustRequired',
        cleanup: 'notAttempted',
        recovery: null,
      },
    });

    handler.mockResolvedValueOnce(profileStore()).mockResolvedValueOnce({
      status: 'redeemed',
      grant: { ...metadata, expiresAt: Number.MAX_SAFE_INTEGER },
    });
    await expect(
      adapter.redeem({
        profileName: 'Home Station',
        expectedProfileRevision: 12,
        expectedUpdatedAt: 2,
        invitationJson: JSON.stringify(invitation),
        expectedRoute,
      }),
    ).rejects.toThrow(/expiresAt/);
  });

  test('blocks redemption if public store revision or selected row changed after status', async () => {
    const handler = vi.fn(async () => profileStore(13, 3));
    const adapter = createNativeRelayGrantAdapter(hostInvoker(handler));
    await expect(
      adapter.redeem({
        profileName: 'Home Station',
        expectedProfileRevision: 12,
        expectedUpdatedAt: 2,
        invitationJson: JSON.stringify(invitation),
        expectedRoute,
      }),
    ).rejects.toThrow('staleProfile');
    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).not.toHaveBeenCalledWith(
      'station_native_relay_grant_redeem',
      expect.anything(),
    );
  });
});
