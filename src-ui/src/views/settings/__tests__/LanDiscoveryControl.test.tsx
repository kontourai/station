// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  query: {
    data: {
      lanDiscoveryEnabled: true,
      lanDiscoveryStatus: {
        state: 'loopback-only',
        message: 'Configure a LAN listener.',
      },
    },
    isPending: false,
    isError: false,
    refetch: vi.fn(),
  },
  update: { mutate: vi.fn(), isPending: false, isError: false },
}));
vi.mock('@kontourai/station-sdk', () => ({
  useConfigQuery: () => state.query,
  useUpdateConfigMutation: () => state.update,
}));

import { LanDiscoveryControl } from '../LanDiscoveryControl';

beforeEach(() => {
  vi.clearAllMocks();
  state.query.isPending = false;
});
it('shows saved opt-in separately from loopback-only runtime status and sends only the intended setting', () => {
  render(<LanDiscoveryControl />);
  const toggle = screen.getByRole('switch', {
    name: 'Discover this Station nearby',
  });
  expect(toggle.getAttribute('aria-checked')).toBe('true');
  expect(screen.getByRole('status').textContent).toContain(
    'Configure a LAN listener.',
  );
  expect(screen.getByText(/name and local address visible/)).toBeTruthy();
  fireEvent.click(toggle);
  expect(state.update.mutate).toHaveBeenCalledWith({
    lanDiscoveryEnabled: false,
  });
});

it('keeps discovery disabled while reading the host status', () => {
  state.query.isPending = true;
  render(<LanDiscoveryControl />);
  expect(
    screen.getByRole('status', { name: 'Reading discovery status' }),
  ).toBeTruthy();
  expect(
    screen.getByRole('switch', { name: 'Discover this Station nearby' }),
  ).toHaveProperty('disabled', true);
  expect(state.update.mutate).not.toHaveBeenCalled();
});
