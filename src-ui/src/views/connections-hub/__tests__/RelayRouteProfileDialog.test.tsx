/** @vitest-environment jsdom */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, test, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  save: vi.fn(),
  read: vi.fn(),
  close: vi.fn(),
  onClose: vi.fn(),
}));

vi.mock('../../../platform/PlatformProfileContext', () => ({
  nativeProfileRepository: () => ({ saveRelayRouteProfile: mocks.save }),
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

import { RelayRouteProfileDialog } from '../RelayRouteProfileDialog';

function renderDialog() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <RelayRouteProfileDialog onClose={mocks.onClose} />
    </QueryClientProvider>,
  );
}

describe('RelayRouteProfileDialog', () => {
  beforeEach(() => {
    mocks.save.mockReset();
    mocks.read.mockReset();
    mocks.close.mockReset();
    mocks.onClose.mockReset();
    mocks.save.mockResolvedValue('station-profile:relay-home');
    mocks.read.mockResolvedValue({
      schemaVersion: 1,
      revision: 1,
      status: 'approved',
      trust: {
        stationId: '11111111-1111-4111-8111-111111111111',
        enrollmentId: '22222222-2222-4222-8222-222222222222',
        generation: 2,
        signingKey: { kty: 'EC', crv: 'P-256', x: 'x', y: 'y' },
      },
    });
  });

  test('shows trust only when the separate local record matches and saves no key', async () => {
    renderDialog();
    fireEvent.change(screen.getByLabelText(/Station application address/), {
      target: { value: 'https://station.example' },
    });
    fireEvent.change(screen.getByLabelText(/Broker address/), {
      target: { value: 'https://broker.example' },
    });
    fireEvent.change(screen.getByLabelText('Station ID'), {
      target: { value: '11111111-1111-4111-8111-111111111111' },
    });
    fireEvent.change(screen.getByLabelText('Enrollment ID'), {
      target: { value: '22222222-2222-4222-8222-222222222222' },
    });
    fireEvent.change(screen.getByLabelText(/Name/), {
      target: { value: 'Relay Home' },
    });

    await waitFor(() =>
      expect(screen.getByText('Station trust approved')).toBeTruthy(),
    );
    expect(screen.queryByLabelText(/signing key/i)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Save route' }));
    await waitFor(() => expect(mocks.onClose).toHaveBeenCalled());
    expect(mocks.save).toHaveBeenCalledWith({
      name: 'Relay Home',
      endpoint: 'https://station.example',
      relayRoute: {
        brokerOrigin: 'https://broker.example',
        stationId: '11111111-1111-4111-8111-111111111111',
        enrollmentId: '22222222-2222-4222-8222-222222222222',
      },
    });
    expect(mocks.close).toHaveBeenCalled();
  });

  test('shows a mismatch when the saved route does not match approved enrollment', async () => {
    mocks.read.mockResolvedValue({
      schemaVersion: 1,
      revision: 1,
      status: 'approved',
      trust: {
        stationId: '11111111-1111-4111-8111-111111111111',
        enrollmentId: '33333333-3333-4333-8333-333333333333',
        generation: 2,
        signingKey: { kty: 'EC', crv: 'P-256', x: 'x', y: 'y' },
      },
    });
    renderDialog();
    fireEvent.change(screen.getByLabelText('Station ID'), {
      target: { value: '11111111-1111-4111-8111-111111111111' },
    });
    fireEvent.change(screen.getByLabelText('Enrollment ID'), {
      target: { value: '22222222-2222-4222-8222-222222222222' },
    });
    await waitFor(() =>
      expect(screen.getByText('Station identity mismatch')).toBeTruthy(),
    );
    expect(mocks.save).not.toHaveBeenCalled();
  });
});
