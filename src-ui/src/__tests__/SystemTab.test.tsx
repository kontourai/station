/**
 * @vitest-environment jsdom
 *
 * archive#2642. The System tab is the "why did we disconnect" surface: it
 * must render uptime + restart history from the boot-history query and the
 * device-local connection state, and must NOT fabricate a cause chip for a
 * record that carries none (label-vs-derivation rule).
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import { describe, expect, test, vi } from 'vitest';

const bootHistory = vi.hoisted(() => ({
  data: {
    currentUptimeSeconds: 3_720,
    records: [
      {
        bootTime: new Date(Date.now() - 5 * 60_000).toISOString(),
        shortSha: 'dc92e26',
        source: 'recorded',
      },
      {
        bootTime: new Date(Date.now() - 3 * 3_600_000).toISOString(),
        shortSha: 'abc1234',
        source: 'derived',
      },
    ],
  },
  isLoading: false,
  isError: false,
}));

vi.mock('@kontourai/station-sdk/developer-runtime', () => ({
  useBootHistoryQuery: () => bootHistory,
  useSystemInstanceQuery: () => ({ data: { id: 'default' }, isLoading: false }),
}));

vi.mock('@kontourai/station-sdk', () => ({
  useSystemStatusForApiBaseQuery: () => ({
    data: { build: { shortSha: 'dc92e26' } },
  }),
}));

vi.mock('@kontourai/station-connect', () => ({
  useConnectionStatus: () => ({
    status: 'connected',
    reason: null,
    failureStreak: 0,
    failureWindows: [],
  }),
}));

vi.mock('../lib/serverHealth', () => ({
  checkServerHealth: vi.fn(),
  probeServerConnection: vi.fn(),
}));

vi.mock('../views/settings/BuildProvenance', () => ({
  BuildProvenance: () => null,
}));

import SystemTab from '../views/developer/SystemTab';

function renderTab() {
  return render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      <SystemTab apiBase="http://station.test" />
    </QueryClientProvider>,
  );
}

describe('Developer System tab (station#2642)', () => {
  test('renders uptime, restart rows, and connection state', () => {
    renderTab();
    expect(screen.getByText('1h 2m')).toBeTruthy();
    expect(screen.getByText('5m ago')).toBeTruthy();
    expect(screen.getByText('3h ago')).toBeTruthy();
    expect(screen.getByText('connected', { exact: false })).toBeTruthy();
    expect(
      screen.getByText('No sustained failures in this session'),
    ).toBeTruthy();
  });

  test('a record without a derivable cause renders no cause chip at all', () => {
    renderTab();
    expect(document.querySelector('.system-tab__cause')).toBeNull();
    // The best-effort historical row is honestly labeled.
    expect(screen.getByText('derived from logs')).toBeTruthy();
  });
});
