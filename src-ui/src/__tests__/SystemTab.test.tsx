/**
 * @vitest-environment jsdom
 *
 * archive#2642. The System tab is the "why did we disconnect" surface: it
 * must render uptime + restart history from the boot-history query and the
 * device-local connection state, and must NOT fabricate a cause chip for a
 * record that carries none (label-vs-derivation rule).
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
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
      {
        bootTime: new Date(Date.now() - 2 * 86_400_000).toISOString(),
        shortSha: 'fed4321',
        source: 'recorded',
        cause: 'crash',
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
    data: {
      build: { shortSha: 'dc92e26' },
      prerequisitesState: 'stale',
      externalEngines: [
        {
          engineId: 'claude-code',
          name: 'Claude Code',
          ready: false,
          reason: 'sign_in_required',
        },
      ],
      capabilities: { terminal: { ready: false, reason: 'PTY unavailable' } },
      developerServices: [
        { id: 'git', name: 'Git', state: 'ready', detail: 'Git available' },
      ],
    },
  }),
}));

const resourceObservation = vi.hoisted(() => ({
  data: {
    kind: 'critical',
    busyPercent: 99,
    cpuCount: 12,
    ageMs: 1500,
    sampledAt: 12345,
    sampleMs: 500,
    source: 'test',
    thresholdPercent: 85,
    resources: {
      sampledAt: 100,
      memory: { totalBytes: 1000, freeBytes: 100 },
      process: {
        pid: 42,
        uptimeSeconds: 100,
        rssBytes: 500,
        heapUsedBytes: 200,
        heapTotalBytes: 300,
      },
    },
  },
}));
vi.mock('@kontourai/station-sdk/resource-posture', () => ({
  useResourcePostureForApiBaseQuery: (apiBase: string) => ({
    data: apiBase.includes('station-b') ? undefined : resourceObservation.data,
  }),
}));

vi.mock('../contexts/NavigationContext', () => ({
  useNavigation: () => ({ navigate: vi.fn() }),
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
    expect(screen.getByText('CPU diagnostics')).toBeTruthy();
    expect(screen.getByText('99%')).toBeTruthy();
    expect(screen.getByText('12')).toBeTruthy();
    expect(
      screen.getByText('Station never gates work on host CPU load.', {
        exact: false,
      }),
    ).toBeTruthy();
  });

  test('only a record carrying a cause renders a cause chip', () => {
    renderTab();
    const rows = Array.from(document.querySelectorAll('.system-tab__rows li'));
    expect(rows).toHaveLength(3);
    const chips = rows.map((row) =>
      Array.from(row.querySelectorAll('.system-tab__cause')).map(
        (chip) => chip.textContent,
      ),
    );
    expect(chips).toEqual([[], [], ['crash']]);
    // The best-effort historical row is honestly labeled.
    expect(screen.getByText('derived from logs')).toBeTruthy();
  });
});

test('Services reports readiness reasons and discovery freshness', () => {
  renderTab();
  fireEvent.click(screen.getByRole('tab', { name: 'Services' }));
  expect(screen.getByText('sign in required')).toBeTruthy();
  expect(screen.getByText('PTY unavailable')).toBeTruthy();
  expect(
    screen.getByText('Showing the previous discovery snapshot', {
      exact: false,
    }),
  ).toBeTruthy();
  expect(screen.queryByText('No boot records yet')).toBeNull();
});

test('Performance discards another Station host’s chart on connection switch', async () => {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const tab = (apiBase: string) => (
    <QueryClientProvider client={client}>
      <SystemTab apiBase={apiBase} />
    </QueryClientProvider>
  );
  const mounted = render(tab('http://station-a.test'));
  fireEvent.click(screen.getByRole('tab', { name: 'Performance' }));
  resourceObservation.data = {
    ...resourceObservation.data,
    resources: { ...resourceObservation.data.resources, sampledAt: 200 },
  };
  mounted.rerender(tab('http://station-a.test'));
  await waitFor(() =>
    expect(
      screen.getByRole('img', {
        name: 'CPU busy percentage across 2 received samples',
      }),
    ).toBeTruthy(),
  );
  mounted.rerender(tab('http://station-b.test'));
  expect(screen.queryByRole('img')).toBeNull();
});
