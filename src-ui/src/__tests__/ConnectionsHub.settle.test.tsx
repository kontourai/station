/**
 * @vitest-environment jsdom
 *
 * The `/connections` Overview shows a loading state until its first reads
 * answer, so what counts as "still reading" has to be React Query's own
 * answer, not a stub. A read that is disabled (nothing to ask) or paused
 * (offline) is not fetching, and must not hold the loading state forever.
 */

import {
  onlineManager,
  QueryClient,
  QueryClientProvider,
  useQuery,
} from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';

const navigate = vi.fn();
const mode = vi.hoisted(() => ({
  engines: 'disabled' as 'disabled' | 'paused',
}));

function answered<T>(key: string, data: T) {
  return () =>
    useQuery({ queryKey: [key], queryFn: async () => data, retry: false });
}

vi.mock('@kontourai/station-sdk', () => ({
  useModelConnectionsQuery: answered('models', []),
  useIntegrationsQuery: answered('tools', [
    { id: 'audit-echo', connected: false, probe: { ok: false, toolCount: 0 } },
  ]),
  useGlobalKnowledgeStatusQuery: answered('knowledge', null),
  useEngineConnectionsQuery: () =>
    useQuery({
      queryKey: ['engines', mode.engines],
      queryFn: async () => [],
      enabled: mode.engines !== 'disabled',
      networkMode: 'online',
      retry: false,
    }),
  useSshEnvironmentsQuery: () => ({ data: [] }),
  sshEnvironmentsToKnownEnvironments: () => [],
  useACPConnectionsQuery: () => ({ data: [] }),
  useACPConnectionRegistryQuery: () => ({ data: [] }),
  useACPConnectionProbeStatusesQuery: () => ({ data: [] }),
  useACPPublicRegistrySourceQuery: () => ({ data: undefined }),
  useUnregisteredACPConnectionsQuery: () => ({ data: [] }),
  recheckACPConnectionRegistry: vi.fn(),
  refreshACPPublicRegistrySource: vi.fn(),
}));
vi.mock('../contexts/ManagedPolicyContext', () => ({
  useManagedPolicySummary: () => undefined,
}));
vi.mock('@kontourai/station-connect', () => ({
  useConnections: () => ({ connections: [] }),
}));
vi.mock('../contexts/NavigationContext', () => ({
  useNavigation: () => ({ navigate }),
}));
vi.mock('../components/page-frame', () => ({ usePageHeader: vi.fn() }));
vi.mock('../views/engine-detail/useEngineAccountAccess', () => ({
  useEngineAccountAccess: () => ({ scope: null, canManage: false }),
}));

import { ConnectionsHub } from '../views/ConnectionsHub';

afterEach(() => {
  navigate.mockReset();
  onlineManager.setOnline(true);
});

test.each(['disabled', 'paused'] as const)(
  'a %s read does not hold the page on loading',
  async (engines) => {
    mode.engines = engines;
    // Paused: React Query holds an online-mode fetch while offline. The
    // other reads below are offline-first in effect (they resolve locally),
    // so set the mode per query rather than globally where possible.
    const client = new QueryClient({
      defaultOptions: { queries: { networkMode: 'always', retry: false } },
    });
    if (engines === 'paused') onlineManager.setOnline(false);
    render(
      <QueryClientProvider client={client}>
        <ConnectionsHub />
      </QueryClientProvider>,
    );
    // There is no timer: settling comes from the reads alone.
    await waitFor(
      () =>
        expect(
          screen.getByRole('button', { name: 'Details: audit-echo' }),
        ).toBeTruthy(),
      { timeout: 500 },
    );
    expect(
      screen.queryByRole('status', { name: 'Loading connections' }),
    ).toBeNull();
    expect(navigate).not.toHaveBeenCalled();
    expect(client.getQueryState(['engines', engines])?.status).toBe('pending');
    client.clear();
  },
);
