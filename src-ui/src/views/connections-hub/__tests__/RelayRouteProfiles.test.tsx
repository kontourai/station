/** @vitest-environment jsdom */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { beforeEach, describe, expect, test, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  profiles: [] as readonly Record<string, unknown>[],
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
}));

vi.mock('../../../platform/PlatformProfileContext', () => ({
  usePlatformProfile: () => ({ isTauri: true }),
  nativeProfileRepository: () => ({
    getRelayRouteProfiles: () => mocks.profiles,
    subscribeRelayRouteProfiles: (listener: () => void) => {
      mocks.listeners.add(listener);
      return () => mocks.listeners.delete(listener);
    },
    removeRelayRouteProfile: mocks.remove,
    saveRelayRouteProfile: mocks.save,
  }),
}));

vi.mock('@kontourai/station-connect/connection-trust', () => ({
  openDeviceConnectionTrustStore: async () => ({
    read: mocks.read,
    close: mocks.close,
  }),
  stationRelayRouteTrustStatus: (
    record: {
      status: 'approved' | 'revoked';
      trust: { stationId: string; enrollmentId: string };
    } | null,
    route: { stationId: string; enrollmentId: string },
  ) => {
    if (!record) return 'untrusted';
    if (
      record.trust.stationId !== route.stationId ||
      record.trust.enrollmentId !== route.enrollmentId
    )
      return 'mismatch';
    return record.status;
  },
}));

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

import { RelayRouteProfiles } from '../RelayRouteProfiles';

const stationId = '11111111-1111-4111-8111-111111111111';
const enrollmentId = '22222222-2222-4222-8222-222222222222';

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
    expect(screen.queryByText('Saved broker routes')).toBeNull();
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
