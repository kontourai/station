/** @vitest-environment jsdom */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, test, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  profiles: [] as readonly Record<string, unknown>[],
  listeners: new Set<() => void>(),
  remove: vi.fn(),
  save: vi.fn(),
  read: vi.fn(),
  close: vi.fn(),
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

import { RelayRouteProfiles } from '../RelayRouteProfiles';

const stationId = '11111111-1111-4111-8111-111111111111';
const enrollmentId = '22222222-2222-4222-8222-222222222222';

function renderRoutes() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <RelayRouteProfiles />
    </QueryClientProvider>,
  );
}

describe('RelayRouteProfiles', () => {
  beforeEach(() => {
    mocks.listeners.clear();
    mocks.remove.mockReset();
    mocks.save.mockReset();
    mocks.read.mockReset();
    mocks.close.mockReset();
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
      expect(screen.getByText('Station trust approved')).toBeTruthy(),
    );
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
});
