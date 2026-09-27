import { beforeEach, describe, expect, test, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ invokeTauri: vi.fn() }));

vi.mock('../tauriInvoke', () => ({ invokeTauri: mocks.invokeTauri }));

import {
  createNativeRelayGrantRenewalAdapter,
  NATIVE_RELAY_GRANT_RENEWAL_WINDOW_MS,
  nativeRelayGrantRenewalAdapter,
} from '../nativeRelayGrantRenewalAdapter';
import type { NativeRelayRouteSelection } from '../nativeRelayGrantRenewalSupervisor';

const selection: NativeRelayRouteSelection = {
  profileName: 'Home Station',
  brokerOrigin: 'https://broker.example',
  stationId: '11111111-1111-4111-8111-111111111111',
  enrollmentId: '22222222-2222-4222-8222-222222222222',
};

const route = {
  brokerOrigin: selection.brokerOrigin,
  stationId: selection.stationId,
  enrollmentId: selection.enrollmentId,
  routingGeneration: 4,
  grantId: 'grant-4',
};

const metadata = {
  route,
  stationSigningKeyId: 'sha256:station-key',
  stationSigningGeneration: 3,
  expiresAt: 1_900_086_400_000,
};

const status = {
  profileName: selection.profileName,
  profileRevision: 9,
  stationId: selection.stationId,
  enrollmentId: selection.enrollmentId,
  grants: [{ metadata, expired: false }],
  cleanups: [],
};

describe('native relay grant renewal adapter', () => {
  beforeEach(() => mocks.invokeTauri.mockReset());

  test('validates host status, selects the single saved-route grant, and maps the 24h window', async () => {
    mocks.invokeTauri.mockResolvedValue(status);

    await expect(
      nativeRelayGrantRenewalAdapter.status(selection),
    ).resolves.toEqual({
      profileName: selection.profileName,
      brokerOrigin: selection.brokerOrigin,
      stationId: selection.stationId,
      enrollmentId: selection.enrollmentId,
      profileRevision: 9,
      grant: {
        expiresAt: metadata.expiresAt,
        lifetimeMs: NATIVE_RELAY_GRANT_RENEWAL_WINDOW_MS,
      },
    });
    expect(mocks.invokeTauri).toHaveBeenCalledWith(
      'station_native_relay_grant_status',
      { profileName: selection.profileName },
    );
  });

  test('rejects malformed, stale, unknown-field, and mismatched status replies', async () => {
    mocks.invokeTauri
      .mockResolvedValueOnce({ ...status, profileRevision: 0 })
      .mockResolvedValueOnce({ ...status, credential: 'must-not-cross' })
      .mockResolvedValueOnce({ ...status, stationId: 'other-station' })
      .mockResolvedValueOnce({
        ...status,
        grants: [
          {
            metadata: { ...metadata, expiresAt: Number.MAX_SAFE_INTEGER + 1 },
            expired: false,
          },
        ],
      });

    await expect(
      nativeRelayGrantRenewalAdapter.status(selection),
    ).rejects.toThrow('profileRevision');
    await expect(
      nativeRelayGrantRenewalAdapter.status(selection),
    ).rejects.toThrow('status fields');
    await expect(
      nativeRelayGrantRenewalAdapter.status(selection),
    ).rejects.toThrow('does not match the selected profile');
    await expect(
      nativeRelayGrantRenewalAdapter.status(selection),
    ).rejects.toThrow('expiresAt');
  });

  test('rejects ambiguous grants and any grant from a different saved route', async () => {
    mocks.invokeTauri
      .mockResolvedValueOnce({
        ...status,
        grants: [
          { metadata, expired: false },
          {
            metadata: { ...metadata, route: { ...route, grantId: 'grant-5' } },
            expired: false,
          },
        ],
      })
      .mockResolvedValueOnce({
        ...status,
        grants: [
          {
            metadata: {
              ...metadata,
              route: { ...route, brokerOrigin: 'https://other-broker.example' },
            },
            expired: false,
          },
        ],
      });

    await expect(
      nativeRelayGrantRenewalAdapter.status(selection),
    ).rejects.toThrow('ambiguous');
    await expect(
      nativeRelayGrantRenewalAdapter.status(selection),
    ).rejects.toThrow('does not match the saved route');
  });

  test('refuses pending local or broker cleanup and accepts completed cleanup receipts', async () => {
    const cleanup = {
      cleanupId: 'cleanup-1',
      route,
      stagedAt: 1_900_000_000_000,
      recordPresent: true,
      brokerRetired: false,
      localCleanupRequired: true,
      localCleanupComplete: false,
    };
    mocks.invokeTauri
      .mockResolvedValueOnce({ ...status, cleanups: [cleanup] })
      .mockResolvedValueOnce({
        ...status,
        cleanups: [
          {
            ...cleanup,
            recordPresent: false,
            brokerRetired: true,
            localCleanupComplete: true,
          },
        ],
      });

    await expect(
      nativeRelayGrantRenewalAdapter.status(selection),
    ).rejects.toThrow('cleanup pending');
    await expect(
      nativeRelayGrantRenewalAdapter.status(selection),
    ).resolves.toMatchObject({
      grant: { expiresAt: metadata.expiresAt },
    });
  });

  test('returns no grant for an empty clean status so callers can refresh after redemption', async () => {
    mocks.invokeTauri.mockResolvedValue({ ...status, grants: [] });

    await expect(
      nativeRelayGrantRenewalAdapter.status(selection),
    ).resolves.toMatchObject({
      profileRevision: 9,
      grant: null,
    });
  });

  test('renews with only profile name and expected revision, returning secret-free expiry', async () => {
    mocks.invokeTauri.mockResolvedValue(metadata);

    await expect(
      nativeRelayGrantRenewalAdapter.renew({
        selection,
        expectedProfileRevision: 9,
      }),
    ).resolves.toEqual({
      expiresAt: metadata.expiresAt,
      lifetimeMs: NATIVE_RELAY_GRANT_RENEWAL_WINDOW_MS,
    });
    expect(mocks.invokeTauri).toHaveBeenCalledWith(
      'station_native_relay_grant_renew',
      {
        profileName: selection.profileName,
        expectedProfileRevision: 9,
      },
    );
    expect(JSON.stringify(mocks.invokeTauri.mock.calls[0][1])).not.toContain(
      'brokerOrigin',
    );
  });

  test('rejects stale renew inputs and malformed or mismatched renewal receipts', async () => {
    mocks.invokeTauri
      .mockResolvedValueOnce({
        ...metadata,
        route: { ...route, stationId: 'other' },
      })
      .mockResolvedValueOnce({ ...metadata, credential: 'unexpected-secret' });

    await expect(
      nativeRelayGrantRenewalAdapter.renew({
        selection,
        expectedProfileRevision: 0,
      }),
    ).rejects.toThrow('expectedProfileRevision');
    expect(mocks.invokeTauri).not.toHaveBeenCalled();
    await expect(
      nativeRelayGrantRenewalAdapter.renew({
        selection,
        expectedProfileRevision: 9,
      }),
    ).rejects.toThrow('does not match the saved route');
    await expect(
      nativeRelayGrantRenewalAdapter.renew({
        selection,
        expectedProfileRevision: 9,
      }),
    ).rejects.toThrow('renewal metadata fields');
  });

  test('surfaces the host stale-profile refusal without broadening the renewal request', async () => {
    const rejectingAdapter = createNativeRelayGrantRenewalAdapter(
      async <T>(
        command: string,
        args?: Record<string, unknown>,
      ): Promise<T> => {
        expect(command).toBe('station_native_relay_grant_renew');
        expect(args).toEqual({
          profileName: selection.profileName,
          expectedProfileRevision: 9,
        });
        throw new Error('The selected saved Station changed.');
      },
    );
    await expect(
      rejectingAdapter.renew({
        selection,
        expectedProfileRevision: 9,
      }),
    ).rejects.toThrow('saved Station changed');
  });
});
