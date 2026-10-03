// @vitest-environment jsdom
import type { PairedDevice } from '@kontourai/station-contracts/environment-security';
import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, expect, test, vi } from 'vitest';

const state = vi.hoisted(() => ({
  devices: [] as PairedDevice[],
  error: null as Error | null,
}));
vi.mock('@kontourai/station-sdk', async () => ({
  StationHttpError: (
    await vi.importActual<typeof import('@kontourai/station-sdk')>(
      '@kontourai/station-sdk',
    )
  ).StationHttpError,
  usePairedDevicesQuery: () => ({
    data: state.devices,
    error: state.error,
    isLoading: false,
    refetch: vi.fn(),
  }),
}));
vi.mock('../../contexts/ApiBaseContext', () => ({
  useHostRequestAuthorityScope: () => ({
    apiBase: 'http://station.test',
    authorityKey: 'operator',
  }),
}));

import { StationPeoplePanel } from './StationPeoplePanel';

function device(
  id: string,
  overrides: Partial<PairedDevice> = {},
): PairedDevice {
  return {
    id,
    name: id,
    kind: 'device',
    scope: 'view',
    createdAt: 0,
    revokedAt: null,
    activityTracking: 'tracked-since-issued',
    lastSeenFrom: null,
    usageCount: 0,
    lastActiveDay: null,
    revocation: { state: 'not-revoked' },
    principalBinding: {
      kind: 'account',
      issuer: 'https://identity.example',
      subject: 'casey-1',
      displayName: 'Casey',
      approvedAt: 0,
      approvalId: 'approval-1',
      approvedBy: 'operator',
    },
    ...overrides,
  };
}
beforeEach(() => {
  state.devices = [];
  state.error = null;
});

test('groups approved devices by person and removes revoked or unbound devices', () => {
  state.devices = [
    device('Laptop'),
    device('Phone'),
    device('Revoked', { revokedAt: 1 }),
    device('Unbound', { principalBinding: undefined }),
  ];
  const { rerender } = render(<StationPeoplePanel />);
  expect(screen.getAllByRole('button', { name: 'Casey' })).toHaveLength(1);
  expect(screen.getByText('2 paired devices')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Casey' }));
  expect(
    screen.getByRole('dialog', { name: 'Casey paired profile' }),
  ).toBeTruthy();
  expect(screen.getByText('Laptop')).toBeTruthy();
  expect(screen.getByText('Phone')).toBeTruthy();
  expect(screen.queryByText('Revoked')).toBeNull();
  expect(screen.queryByText('Unbound')).toBeNull();
  state.devices = [];
  rerender(<StationPeoplePanel />);
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(screen.getByText('No approved person profiles')).toBeTruthy();
});

test('does not group equal subjects from different identity issuers', () => {
  const other = device('Other', {
    principalBinding: {
      kind: 'account',
      issuer: 'https://other.example',
      subject: 'casey-1',
      displayName: 'Other Casey',
      approvedAt: 0,
      approvalId: 'approval-2',
      approvedBy: 'operator',
    },
  });
  state.devices = [device('Laptop'), other];
  render(<StationPeoplePanel />);
  expect(screen.getByRole('button', { name: 'Casey' })).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Other Casey' })).toBeTruthy();
});

test('hides cached people and the open profile when the registry read fails', () => {
  state.devices = [device('Laptop')];
  const { rerender } = render(<StationPeoplePanel />);
  fireEvent.click(screen.getByRole('button', { name: 'Casey' }));
  state.error = new Error('HTTP 403');
  rerender(<StationPeoplePanel />);
  expect(screen.getByText('Paired profiles unavailable')).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Casey' })).toBeNull();
  expect(screen.queryByRole('dialog')).toBeNull();
});
