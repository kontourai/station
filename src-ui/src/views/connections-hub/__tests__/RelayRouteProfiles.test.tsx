/** @vitest-environment jsdom */

import { defaultStorage } from '@kontourai/station-connect';
import {
  emptyStationProfileStore,
  type StationProfileStore,
} from '@kontourai/station-contracts';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import type { NativeStationProfileRepository } from '../../../platform/native/stationProfileStorage';

const mocks = vi.hoisted(() => ({
  isDesktop: true,
  profiles: [] as readonly Record<string, unknown>[],
  repository: null as NativeStationProfileRepository | null,
  listeners: new Set<() => void>(),
  remove: vi.fn(),
  save: vi.fn(),
  read: vi.fn(),
  close: vi.fn(),
  prepareKey: vi.fn(),
  beginKey: vi.fn(),
  cancelKey: vi.fn(),
  pendingKey: vi.fn(),
  approveKey: vi.fn(),
  revokeKey: vi.fn(),
  keyStatus: vi.fn(),
  grantInvoke: vi.fn(),
}));

vi.mock(
  '../../../platform/native/nativeRelayGrantAdapter',
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import('../../../platform/native/nativeRelayGrantAdapter')
      >();
    return {
      ...actual,
      nativeRelayGrantAdapter: actual.createNativeRelayGrantAdapter(
        mocks.grantInvoke,
      ),
    };
  },
);

vi.mock('../../../platform/PlatformProfileContext', () => ({
  usePlatformProfile: () => ({ isTauri: true, isDesktop: mocks.isDesktop }),
  nativeProfileRepository: () =>
    mocks.repository ?? {
      getRelayRouteProfiles: () => mocks.profiles,
      subscribeRelayRouteProfiles: (listener: () => void) => {
        mocks.listeners.add(listener);
        return () => mocks.listeners.delete(listener);
      },
      removeRelayRouteProfile: mocks.remove,
      saveRelayRouteProfile: mocks.save,
    },
}));

vi.mock(
  '@kontourai/station-connect/connection-trust',
  async (importOriginal) => ({
    // The real `stationRelayRouteTrustStatus` runs; only the device store is faked.
    ...(await importOriginal<
      typeof import('@kontourai/station-connect/connection-trust')
    >()),
    openDeviceConnectionTrustStore: async () => ({
      read: mocks.read,
      close: mocks.close,
    }),
  }),
);

vi.mock('../../../platform/native/relayKeyApproval', () => ({
  nativeRelayKeyApproval: {
    prepare: mocks.prepareKey,
    begin: mocks.beginKey,
    cancel: mocks.cancelKey,
    pending: mocks.pendingKey,
    approve: mocks.approveKey,
    revoke: mocks.revokeKey,
    status: mocks.keyStatus,
  },
}));

import { NativeStationProfileStorage } from '../../../platform/native/stationProfileStorage';
import { RelayRouteProfiles } from '../RelayRouteProfiles';

const stationId = '11111111-1111-4111-8111-111111111111';
const enrollmentId = '22222222-2222-4222-8222-222222222222';

function currentProfileStore(revision = 12, updatedAt = 2) {
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
    relayRoute: {
      brokerOrigin: 'https://broker.example',
      stationId,
      enrollmentId,
    },
  });
  return store;
}

function renderRoutes() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const rendered = render(
    <QueryClientProvider client={queryClient}>
      <RelayRouteProfiles />
    </QueryClientProvider>,
  );
  return { ...rendered, queryClient };
}

describe('RelayRouteProfiles', () => {
  beforeEach(() => {
    mocks.isDesktop = true;
    mocks.repository = null;
    mocks.listeners.clear();
    mocks.remove.mockReset();
    mocks.save.mockReset();
    mocks.read.mockReset();
    mocks.close.mockReset();
    mocks.prepareKey.mockReset();
    mocks.beginKey.mockReset();
    mocks.cancelKey.mockReset();
    mocks.cancelKey.mockResolvedValue(undefined);
    mocks.pendingKey.mockReset();
    mocks.approveKey.mockReset();
    mocks.revokeKey.mockReset();
    mocks.keyStatus.mockReset();
    mocks.grantInvoke.mockReset();
    mocks.keyStatus.mockResolvedValue({
      status: 'untrusted',
      trustRevision: 0,
      profileName: 'Home Station',
      brokerOrigin: 'https://broker.example',
      stationId,
      enrollmentId,
      generation: null,
      keyId: null,
    });
    mocks.pendingKey.mockResolvedValue(null);
    const profile = {
      schemaVersion: 1,
      name: 'Home Station',
      endpoint: 'https://station.example',
      setupSource: 'manual',
      configurationState: 'unconfigured',
      createdAt: 1,
      updatedAt: 2,
      relayRoute: {
        brokerOrigin: 'https://broker.example',
        stationId,
        enrollmentId,
      },
    };
    mocks.profiles = [profile];
    mocks.read.mockResolvedValue({
      schemaVersion: 1,
      revision: 1,
      status: 'approved',
      trust: {
        stationId,
        enrollmentId,
        generation: 1,
        signingKey: { kty: 'EC', crv: 'P-256', x: 'x', y: 'y' },
      },
    });
    mocks.remove.mockImplementation(async () => {
      mocks.profiles = [];
      for (const listener of mocks.listeners) listener();
    });
  });

  test('lists an unconnected route, offers edit, and removes it without revoking trust', async () => {
    renderRoutes();
    expect(screen.getByText('Saved broker routes')).toBeTruthy();
    expect(screen.getByText('Not connected')).toBeTruthy();
    await waitFor(() =>
      expect(screen.getByText('Station key untrusted')).toBeTruthy(),
    );
    expect(
      screen.getByRole('button', { name: 'Prepare native Station identity' }),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    expect(
      screen.getByRole('heading', { name: 'Edit broker route' }),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    fireEvent.click(screen.getByRole('button', { name: 'Remove this route' }));
    expect(
      screen.getByRole('heading', { name: 'Remove broker route?' }),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Remove route' }));
    await waitFor(() =>
      expect(mocks.remove).toHaveBeenCalledWith(
        'station-profile:home station',
        2,
      ),
    );
    expect(
      screen.getByText(
        'No broker routes are saved on this device yet. Save the Station and broker details provided by the Station operator to begin setup.',
      ),
    ).toBeTruthy();
    expect(
      screen.getByRole('button', { name: 'Add broker route' }),
    ).toBeTruthy();
  });

  test('redeems only from the explicit mounted route action and invalidates host grant status', async () => {
    const invitation = {
      version: 'station-broker-native-route-invitation/v2',
      brokerOrigin: 'https://broker.example',
      scope: { stationId, enrollmentId, routingGeneration: 4 },
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
    const grant = {
      route: {
        brokerOrigin: 'https://broker.example',
        stationId,
        enrollmentId,
        routingGeneration: 4,
        grantId: 'abcdefghijklmnopqrstuv',
      },
      stationSigningKeyId: 'sha256:station-signing-key',
      stationSigningGeneration: 3,
      expiresAt: Date.now() + 3_600_000,
    };
    let redeemed = false;
    const liveProfileStore = currentProfileStore();
    mocks.grantInvoke.mockImplementation(
      async (command: string, args?: Record<string, unknown>) => {
        if (command === 'station_profile_store_read') return liveProfileStore;
        if (command === 'station_native_relay_grant_status') {
          expect(args).toEqual({ profileName: 'Home Station' });
          return {
            profileName: 'Home Station',
            profileRevision: 12,
            stationId,
            enrollmentId,
            grants: redeemed ? [{ metadata: grant, expired: false }] : [],
            cleanups: [],
          };
        }
        if (command === 'station_native_relay_grant_redeem') {
          expect(args).toEqual({
            profileName: 'Home Station',
            expectedProfileRevision: 12,
            invitation,
          });
          redeemed = true;
          return { status: 'redeemed', grant };
        }
        throw new Error(`Unexpected native grant command: ${command}`);
      },
    );
    mocks.keyStatus.mockResolvedValue({
      status: 'approved',
      trustRevision: 4,
      profileName: 'Home Station',
      brokerOrigin: 'https://broker.example',
      stationId,
      enrollmentId,
      generation: 3,
      keyId: 'sha256:station-signing-key',
    });
    mocks.pendingKey.mockResolvedValue(null);

    const { queryClient } = renderRoutes();
    await screen.findByText(
      'A routing grant has not been saved on this device.',
    );
    expect(screen.getByText('Not connected')).toBeTruthy();
    expect(mocks.grantInvoke).toHaveBeenCalledTimes(1);

    fireEvent.change(screen.getByLabelText('One-time routing invitation'), {
      target: { value: JSON.stringify(invitation) },
    });
    fireEvent.click(
      screen.getByRole('button', { name: 'Redeem routing grant' }),
    );

    await screen.findByText(/Routing grant active · expires/);
    expect(mocks.grantInvoke).toHaveBeenCalledWith(
      'station_native_relay_grant_redeem',
      expect.objectContaining({
        profileName: 'Home Station',
        expectedProfileRevision: 12,
        invitation,
      }),
    );
    expect(mocks.grantInvoke).toHaveBeenCalledTimes(5);
    expect(screen.getByText('Not connected')).toBeTruthy();
    expect(
      screen.getByText(
        /account access, device approval, and Project access remain separate/,
      ),
    ).toBeTruthy();
    expect(
      queryClient.getQueryData([
        'native-relay-grant',
        'home station',
        2,
        'https://broker.example',
        stationId,
        enrollmentId,
      ]),
    ).toMatchObject({ grants: [{ metadata: grant }] });
  });

  test('does not redeem from an old mounted row after the live public row is replaced', async () => {
    const invitation = {
      version: 'station-broker-native-route-invitation/v2',
      brokerOrigin: 'https://broker.example',
      scope: { stationId, enrollmentId, routingGeneration: 4 },
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
    const liveProfileStore = currentProfileStore(13, 3);
    mocks.grantInvoke.mockImplementation(async (command: string) => {
      if (command === 'station_profile_store_read') return liveProfileStore;
      if (command === 'station_native_relay_grant_status')
        return {
          profileName: 'Home Station',
          profileRevision: 12,
          stationId,
          enrollmentId,
          grants: [],
          cleanups: [],
        };
      throw new Error(`Unexpected native grant command: ${command}`);
    });
    mocks.keyStatus.mockResolvedValue({
      status: 'approved',
      trustRevision: 4,
      profileName: 'Home Station',
      brokerOrigin: 'https://broker.example',
      stationId,
      enrollmentId,
      generation: 3,
      keyId: 'sha256:station-signing-key',
    });

    renderRoutes();
    await screen.findByText(
      'A routing grant has not been saved on this device.',
    );
    fireEvent.change(screen.getByLabelText('One-time routing invitation'), {
      target: { value: JSON.stringify(invitation) },
    });
    fireEvent.click(
      screen.getByRole('button', { name: 'Redeem routing grant' }),
    );

    await screen.findByText(
      'The saved route changed. Review it and try again.',
    );
    expect(mocks.grantInvoke).toHaveBeenCalledWith(
      'station_profile_store_read',
    );
    expect(mocks.grantInvoke).not.toHaveBeenCalledWith(
      'station_native_relay_grant_redeem',
      expect.anything(),
    );
  });

  test('creates a route from the empty state and persists it through the native repository', async () => {
    window.localStorage.clear();
    const persisted = { store: emptyStationProfileStore() };
    const bridge = {
      invoke: async <T,>(command: string, args?: Record<string, unknown>) => {
        if (command === 'station_profile_store_read')
          return structuredClone(persisted.store) as T;
        if (command === 'station_profile_store_write') {
          if (args?.expectedRevision !== persisted.store.revision)
            throw new Error('profile store revision conflict');
          persisted.store = JSON.parse(
            String(args.contents),
          ) as StationProfileStore;
          return undefined as T;
        }
        throw new Error(`Unexpected native profile command: ${command}`);
      },
    };
    const repository = new NativeStationProfileStorage(
      bridge,
      defaultStorage,
      true,
    );
    await repository.hydrate();
    mocks.repository = repository;

    renderRoutes();
    expect(
      screen.getByText(
        'No broker routes are saved on this device yet. Save the Station and broker details provided by the Station operator to begin setup.',
      ),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Add broker route' }));

    fireEvent.change(screen.getByLabelText(/Station application address/), {
      target: { value: 'https://station.example' },
    });
    fireEvent.change(screen.getByLabelText(/Broker address/), {
      target: { value: 'https://broker.example' },
    });
    fireEvent.change(screen.getByLabelText('Station ID'), {
      target: { value: stationId },
    });
    fireEvent.change(screen.getByLabelText('Enrollment ID'), {
      target: { value: enrollmentId },
    });
    fireEvent.change(screen.getByLabelText(/Name/), {
      target: { value: 'Zach Station' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save route' }));

    await screen.findByText('Zach Station');
    expect(screen.getByText('Not connected')).toBeTruthy();
    expect(repository.getRelayRouteProfiles()).toHaveLength(1);
    expect(persisted.store.profiles[0]).toMatchObject({
      name: 'Zach Station',
      endpoint: 'https://station.example',
      relayRoute: {
        brokerOrigin: 'https://broker.example',
        stationId,
        enrollmentId,
      },
    });
    expect(persisted.store.profiles[0]).not.toHaveProperty('credentialRef');

    const restoredRepository = new NativeStationProfileStorage(
      bridge,
      defaultStorage,
      true,
    );
    await restoredRepository.hydrate();
    expect(restoredRepository.getRelayRouteProfiles()).toMatchObject([
      {
        name: 'Zach Station',
        relayRoute: {
          brokerOrigin: 'https://broker.example',
          stationId,
          enrollmentId,
        },
      },
    ]);
  });

  test('explains when the saved-route limit pauses automatic renewal', () => {
    const template = mocks.profiles[0];
    mocks.profiles = Array.from({ length: 65 }, (_, index) => ({
      ...template,
      name: `Saved route ${index}`,
    }));
    renderRoutes();
    expect(screen.getByRole('alert').textContent).toMatch(
      /renewal is paused for all saved routes/i,
    );
  });

  test('does not promise automatic renewal on mobile', () => {
    mocks.isDesktop = false;
    const template = mocks.profiles[0];
    mocks.profiles = Array.from({ length: 65 }, (_, index) => ({
      ...template,
      name: `Saved route ${index}`,
    }));
    renderRoutes();
    expect(
      screen.queryByText(
        /approved routing grants renew while this desktop app/i,
      ),
    ).toBeNull();
    expect(screen.queryByText(/automatic grant renewal is paused/i)).toBeNull();
  });

  test('hides cached approved trust and disables revocation after a native status refetch fails', async () => {
    mocks.keyStatus.mockResolvedValue({
      status: 'approved',
      trustRevision: 4,
      profileName: 'Home Station',
      brokerOrigin: 'https://broker.example',
      stationId,
      enrollmentId,
      generation: 3,
      keyId: 'sha256:cached-approved-key',
    });
    mocks.pendingKey.mockResolvedValue(null);
    const { queryClient } = renderRoutes();

    await screen.findByText('Station key approved');
    expect(screen.getByText('sha256:cached-approved-key')).toBeTruthy();
    mocks.keyStatus.mockRejectedValueOnce(
      new Error('native keyring unavailable'),
    );
    await act(async () => {
      await queryClient.invalidateQueries({
        queryKey: ['native-relay-key-approval', 'Home Station', 'status'],
      });
    });

    await screen.findByText('Native key trust unavailable');
    expect(screen.queryByText('sha256:cached-approved-key')).toBeNull();
    expect(
      screen.queryByRole('button', { name: 'Revoke Station key trust' }),
    ).toBeNull();
  });

  test('reveals rotation setup only on request and keeps the current key trusted until a new key is approved', async () => {
    const rotatedCandidate = {
      pendingId: 'pending-rotation',
      profileName: 'Home Station',
      brokerOrigin: 'https://broker.example',
      stationId,
      enrollmentId,
      generation: 8,
      keyId: 'sha256:rotated-station-key',
      confirmationCode: 'ABCD1234EFGH5678',
      expiresAt: Date.now() + 60_000,
      trustRevision: 1,
      status: 'pending' as const,
    };
    const approvedOldKey = {
      status: 'approved',
      trustRevision: 1,
      profileName: 'Home Station',
      brokerOrigin: 'https://broker.example',
      stationId,
      enrollmentId,
      generation: 7,
      keyId: 'sha256:old-station-key',
    };
    const approvedNewKey = {
      ...approvedOldKey,
      trustRevision: 2,
      generation: 8,
      keyId: rotatedCandidate.keyId,
    };
    mocks.keyStatus.mockResolvedValue(approvedOldKey);
    mocks.pendingKey.mockResolvedValue(null);
    mocks.prepareKey.mockResolvedValue({
      profileName: 'Home Station',
      brokerOrigin: 'https://broker.example',
      stationId,
      enrollmentId,
      appIdentifier: 'io.kontourai.station',
      channel: 'stable',
      clientInstanceId: 'install-1',
      keyThumbprint: 'sha256:install-proof',
      publicKey: { kty: 'EC', crv: 'P-256', x: 'x', y: 'y' },
    });
    mocks.beginKey.mockImplementation(async () => {
      mocks.pendingKey.mockResolvedValue(rotatedCandidate);
      return rotatedCandidate;
    });
    mocks.approveKey.mockImplementation(async () => {
      mocks.pendingKey.mockResolvedValue(null);
      mocks.keyStatus.mockResolvedValue(approvedNewKey);
      return approvedNewKey;
    });

    renderRoutes();
    await screen.findByText('Station key approved');
    expect(screen.getByText('sha256:old-station-key')).toBeTruthy();
    expect(
      screen.getByRole('button', { name: 'Review new Station key' }),
    ).toBeTruthy();
    expect(
      screen.queryByRole('button', { name: 'Prepare native Station identity' }),
    ).toBeNull();
    expect(screen.queryByLabelText('One-time Station invitation')).toBeNull();

    fireEvent.click(
      screen.getByRole('button', { name: 'Review new Station key' }),
    );
    fireEvent.click(
      screen.getByRole('button', { name: 'Prepare native Station identity' }),
    );
    await screen.findByRole('region', {
      name: 'Public install proof metadata',
    });
    fireEvent.click(screen.getByRole('button', { name: 'Cancel key review' }));
    await screen.findByRole('button', { name: 'Review new Station key' });
    expect(
      screen.queryByRole('region', { name: 'Public install proof metadata' }),
    ).toBeNull();
    expect(screen.getByText('sha256:old-station-key')).toBeTruthy();

    fireEvent.click(
      screen.getByRole('button', { name: 'Review new Station key' }),
    );
    fireEvent.click(
      screen.getByRole('button', { name: 'Prepare native Station identity' }),
    );
    await screen.findByRole('region', {
      name: 'Public install proof metadata',
    });
    fireEvent.change(screen.getByLabelText('One-time Station invitation'), {
      target: {
        value: '{"version":"station-broker-native-route-invitation/v2"}',
      },
    });
    fireEvent.click(
      screen.getByRole('button', { name: 'Discover Station key' }),
    );
    await screen.findByRole('region', {
      name: 'Candidate from native verification',
    });
    expect(screen.getByText('Station key approved')).toBeTruthy();
    expect(screen.getByText('sha256:old-station-key')).toBeTruthy();

    fireEvent.change(screen.getByLabelText('Operator comparison code'), {
      target: { value: 'ABCD-1234-EFGH-5678' },
    });
    fireEvent.change(
      screen.getByLabelText('Full key ID confirmed by operator'),
      {
        target: { value: rotatedCandidate.keyId },
      },
    );
    fireEvent.click(
      screen.getByLabelText(
        /I got these values from the Station operator through a separate channel/,
      ),
    );
    fireEvent.click(
      screen.getByRole('button', { name: 'Approve Station key' }),
    );
    await waitFor(() =>
      expect(mocks.approveKey).toHaveBeenCalledWith({
        pendingId: rotatedCandidate.pendingId,
        confirmationCode: 'ABCD1234EFGH5678',
        fullKeyId: rotatedCandidate.keyId,
      }),
    );
    await waitFor(() =>
      expect(screen.getByText('sha256:rotated-station-key')).toBeTruthy(),
    );
    expect(
      screen.getByRole('button', { name: 'Review new Station key' }),
    ).toBeTruthy();
    expect(screen.queryByLabelText('One-time Station invitation')).toBeNull();
  });

  test('requires native surface preparation, a pasted invitation, and separately entered operator values', async () => {
    const candidate = {
      pendingId: 'pending-1',
      profileName: 'Home Station',
      brokerOrigin: 'https://broker.example',
      stationId,
      enrollmentId,
      generation: 7,
      keyId: 'sha256:full-station-key-id',
      confirmationCode: 'ABCD1234EFGH5678',
      expiresAt: Date.now() + 60_000,
      trustRevision: 0,
      status: 'pending' as const,
    };
    const invitationJson = JSON.stringify({
      version: 'station-broker-native-route-invitation/v2',
      brokerOrigin: 'https://broker.example',
      scope: { stationId, enrollmentId, routingGeneration: 7 },
      stationSigningKeyId: 'sha256:station-key',
      stationSigningGeneration: 4,
      surface: {
        kind: 'station-native',
        appIdentifier: 'io.kontourai.station',
        channel: 'stable',
        clientInstanceId: 'install-1',
        keyThumbprint: 'sha256:install-proof',
      },
      invitationId: 'invite-1',
      invitationSecret: 'one-time-invitation-secret',
      expiresAt: Date.now() + 60_000,
    });
    mocks.prepareKey.mockResolvedValue({
      profileName: 'Home Station',
      brokerOrigin: 'https://broker.example',
      stationId,
      enrollmentId,
      appIdentifier: 'io.kontourai.station',
      channel: 'stable',
      clientInstanceId: 'install-1',
      keyThumbprint: 'sha256:install-proof',
      publicKey: { kty: 'EC', crv: 'P-256', x: 'x', y: 'y' },
    });
    mocks.beginKey.mockImplementation(
      async (_profileName: string, invitation: string) => {
        expect(invitation).toBe(invitationJson);
        mocks.pendingKey.mockResolvedValue(candidate);
        return candidate;
      },
    );
    mocks.approveKey.mockImplementation(async () => {
      mocks.pendingKey.mockResolvedValue(null);
      const status = {
        status: 'approved',
        trustRevision: 1,
        profileName: 'Home Station',
        brokerOrigin: 'https://broker.example',
        stationId,
        enrollmentId,
        generation: 7,
        keyId: candidate.keyId,
      };
      mocks.keyStatus.mockResolvedValue(status);
      return status;
    });
    mocks.revokeKey.mockImplementation(async () => {
      const status = {
        status: 'revoked',
        trustRevision: 2,
        profileName: 'Home Station',
        brokerOrigin: 'https://broker.example',
        stationId,
        enrollmentId,
        generation: 7,
        keyId: candidate.keyId,
      };
      mocks.keyStatus.mockResolvedValue(status);
      return status;
    });

    renderRoutes();
    await screen.findByText('Station key untrusted');
    fireEvent.click(
      screen.getByRole('button', { name: 'Prepare native Station identity' }),
    );
    await screen.findByText('sha256:install-proof');
    expect(screen.getByText('io.kontourai.station')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('One-time Station invitation'), {
      target: { value: invitationJson },
    });
    fireEvent.click(
      screen.getByRole('button', { name: 'Discover Station key' }),
    );
    await screen.findByText('sha256:full-station-key-id');
    expect(screen.getByText('ABCD-1234-EFGH-5678')).toBeTruthy();
    expect(
      screen
        .getByRole('button', { name: 'Approve Station key' })
        .hasAttribute('disabled'),
    ).toBe(true);

    fireEvent.change(screen.getByLabelText('Operator comparison code'), {
      target: { value: 'ABCD-1234-EFGH-567I' },
    });
    fireEvent.change(
      screen.getByLabelText('Full key ID confirmed by operator'),
      {
        target: { value: candidate.keyId },
      },
    );
    fireEvent.click(
      screen.getByLabelText(
        /I got these values from the Station operator through a separate channel/,
      ),
    );
    expect(
      screen
        .getByRole('button', { name: 'Approve Station key' })
        .hasAttribute('disabled'),
    ).toBe(true);
    expect(mocks.approveKey).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText('Operator comparison code'), {
      target: { value: 'abcd-1234-efgh-5678' },
    });
    expect(
      screen
        .getByRole('button', { name: 'Approve Station key' })
        .hasAttribute('disabled'),
    ).toBe(false);
    fireEvent.click(
      screen.getByRole('button', { name: 'Approve Station key' }),
    );
    await waitFor(() =>
      expect(mocks.approveKey).toHaveBeenCalledWith({
        pendingId: 'pending-1',
        confirmationCode: 'ABCD1234EFGH5678',
        fullKeyId: candidate.keyId,
      }),
    );
    await screen.findByText('Station key approved');
    expect(screen.getByText(/Route remains disconnected/)).toBeTruthy();
    expect(
      screen.queryByRole('button', { name: 'Prepare native Station identity' }),
    ).toBeNull();
    expect(
      screen.queryByRole('region', { name: 'Public install proof metadata' }),
    ).toBeNull();
    expect(screen.queryByLabelText('One-time Station invitation')).toBeNull();
    expect(
      screen.getByRole('button', { name: 'Revoke Station key trust' }),
    ).toBeTruthy();
    fireEvent.change(
      screen.getByLabelText(
        'Type the current full key ID to confirm revocation',
      ),
      {
        target: { value: candidate.keyId },
      },
    );
    fireEvent.click(
      screen.getByRole('button', { name: 'Revoke Station key trust' }),
    );
    await waitFor(() =>
      expect(mocks.revokeKey).toHaveBeenCalledWith({
        profileName: 'Home Station',
        expectedTrustRevision: 1,
        fullKeyId: candidate.keyId,
      }),
    );
    await screen.findByText('Station key trust revoked');
    expect(
      screen.getByRole('button', { name: 'Prepare native Station identity' }),
    ).toBeTruthy();
  });
});
