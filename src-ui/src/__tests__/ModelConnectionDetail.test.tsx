/**
 * @vitest-environment jsdom
 *
 * A saved model connection's detail through the real `ProviderSettingsView`:
 * Overview (status, one fix, used-by from the server projection), Usage (read
 * by model connection on this Station), and the Settings unsaved bar.
 */

import type { ConnectionUsedBy } from '@kontourai/station-contracts/connection-used-by';
import type { AuthorityObservation } from '@kontourai/station-sdk/authority-observation';
import { setClientCredentialResolver } from '@kontourai/station-sdk/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  fireEvent,
  render as renderView,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import type { ReactElement, ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

const operatorScope = {
  apiBase: 'https://operator.example.test',
  authorityKey: 'view-operator',
  isCurrent: () => true,
};
const operatorAuthority: AuthorityObservation = {
  schemaVersion: 'station.authority-observation/v1',
  environmentId: 'view-host',
  principal: { kind: 'human', id: 'human:local:operator' },
  grant: { kind: 'operator' },
};
vi.mock('../contexts/ApiBaseContext', () => ({
  useHostRequestAuthorityScope: () => operatorScope,
}));
const usageFilters = vi.hoisted(() => ({ supported: true as boolean | null }));
vi.mock('@kontourai/station-sdk/client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@kontourai/station-sdk/client')>()),
  readUsageConnectionFiltersCapability: async () => usageFilters.supported,
}));

const saveMutate = vi.fn();
const testMutate = vi.fn();
const sdk = vi.hoisted(() => ({
  modelConnections: [] as unknown[],
  usedBy: {
    data: undefined as ConnectionUsedBy | undefined,
    error: null as unknown,
    isError: false,
  },
}));

vi.mock('@kontourai/station-sdk', () => {
  class ConnectionUsedByWithheldError extends Error {}
  return {
    ConnectionModelSelectionError: class extends Error {},
    ConnectionUsedByWithheldError,
    useConnectionUsedByQuery: () => ({ ...sdk.usedBy, refetch: vi.fn() }),
    useModelConnectionsQuery: () => ({
      data: sdk.modelConnections,
      isLoading: false,
      error: null,
      refetch: vi.fn(),
    }),
    useConnectionsQuery: () => ({ data: [] }),
    useSystemStatusQuery: () => ({ data: undefined }),
    useSaveModelConnectionMutation: () => ({
      mutate: saveMutate,
      isPending: false,
    }),
    useDeleteModelConnectionMutation: () => ({
      mutate: vi.fn(),
      isPending: false,
    }),
    useTestModelConnectionMutation: () => ({
      mutate: testMutate,
      isPending: false,
    }),
    useAwsProfilesQuery: () => ({ data: undefined, isLoading: false }),
  };
});
vi.mock('../hooks/useACPConnections', () => ({
  useACPConnections: () => ({ data: [] }),
  useACPConnectionRegistry: () => ({ data: [] }),
}));
vi.mock('../contexts/NavigationContext', () => {
  const navigation = () => ({ navigate: vi.fn() });
  return {
    useNavigation: (
      selector?: (state: ReturnType<typeof navigation>) => unknown,
    ) => (selector ? selector(navigation()) : navigation()),
    useNavigationActions: navigation,
  };
});
vi.mock('../hooks/useDevicePresentation', () => ({
  useDevicePresentation: () => undefined,
}));

import { ConnectionUsedByWithheldError } from '@kontourai/station-sdk';
import { ProviderSettingsView } from '../views/ProviderSettingsView';

let queryClient: QueryClient;
let stationRequests: string[] = [];
async function render(view: ReactElement) {
  const mounted = renderView(view, {
    wrapper: ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    ),
  });
  await waitFor(() => expect(queryClient.isFetching()).toBe(0));
  return mounted;
}

const ollama = {
  id: 'ollama-local',
  kind: 'model',
  type: 'ollama',
  name: 'Local Ollama',
  config: { baseUrl: 'http://localhost:11434', defaultModel: 'llama3' },
  enabled: true,
  capabilities: ['llm'],
  status: 'ready',
  prerequisites: [],
  lastCheckedAt: null,
};

beforeEach(() => {
  queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  stationRequests = [];
  usageFilters.supported = true;
  saveMutate.mockReset();
  testMutate.mockReset();
  sdk.modelConnections = [ollama];
  sdk.usedBy = { data: undefined, error: null, isError: false };
  setClientCredentialResolver(() => ({
    origin: operatorScope.apiBase,
    requestAuthority: operatorScope,
    transport: async (url) => {
      const parsed = new URL(String(url));
      stationRequests.push(parsed.pathname + parsed.search);
      const reply = (data: unknown) =>
        new Response(JSON.stringify(data), {
          headers: { 'Content-Type': 'application/json' },
        });
      if (parsed.pathname.endsWith('/usage-rollup'))
        return reply({
          success: true,
          data: {
            window: { from: '2026-11-01', to: '2026-11-07' },
            rows: [],
            receipts: [],
            coverage: [],
          },
        });
      if (parsed.pathname === '/api/auth/authority')
        return reply(operatorAuthority);
      throw new Error(`Unexpected request ${parsed.pathname}`);
    },
  }));
});
afterEach(() => {
  queryClient.clear();
  setClientCredentialResolver(undefined);
});

describe('Model connection detail', () => {
  test('Overview lists what the server says names this connection, and opens it', async () => {
    sdk.usedBy.data = {
      dependents: [
        {
          connectionId: 'ollama-local',
          kind: 'agent',
          slug: 'reviewer',
          name: 'Reviewer',
          via: 'model',
        },
        {
          connectionId: 'ollama-local',
          kind: 'project',
          slug: 'site',
          name: 'Site',
          via: 'project-default-model',
        },
        // Another connection's dependent is not this one's.
        {
          connectionId: 'openai',
          kind: 'agent',
          slug: 'writer',
          name: 'Writer',
          via: 'model',
        },
      ],
    };
    const onNavigate = vi.fn();
    await render(
      <ProviderSettingsView
        selectedProviderId="ollama-local"
        onNavigate={onNavigate}
      />,
    );
    expect(
      screen.getByRole('tab', { name: 'Overview', selected: true }),
    ).toBeTruthy();
    const usedBy = screen.getByRole('region', { name: 'Used by' });
    expect(within(usedBy).queryByText('Writer')).toBeNull();
    expect(within(usedBy).getByText('Project · chat default')).toBeTruthy();
    fireEvent.click(within(usedBy).getByRole('button', { name: 'Reviewer' }));
    expect(onNavigate).toHaveBeenCalledWith({
      type: 'agent-edit',
      slug: 'reviewer',
    });
    fireEvent.click(within(usedBy).getByRole('button', { name: 'Site' }));
    expect(onNavigate).toHaveBeenCalledWith({
      type: 'project-edit',
      slug: 'site',
    });
  });

  test('a withheld used-by read says so instead of claiming nothing uses it', async () => {
    sdk.usedBy = {
      data: undefined,
      error: new ConnectionUsedByWithheldError('operator only'),
      isError: true,
    };
    await render(
      <ProviderSettingsView
        selectedProviderId="ollama-local"
        onNavigate={vi.fn()}
      />,
    );
    const usedBy = screen.getByRole('region', { name: 'Used by' });
    expect(within(usedBy).getByText('Not shown')).toBeTruthy();
    expect(within(usedBy).queryByText('Not used yet')).toBeNull();
  });

  test('the header offers the one fix, and a failed check is a failed check', async () => {
    sdk.modelConnections = [
      {
        ...ollama,
        readinessEvidence: {
          evidenceVersion: 1,
          level: 'refused',
          observedAt: '2026-11-07T10:00:00.000Z',
          freshness: 'fresh',
          summary: 'The provider refused the request.',
        },
      },
    ];
    const { container } = await render(
      <ProviderSettingsView
        selectedProviderId="ollama-local"
        onNavigate={vi.fn()}
      />,
    );
    const header = container.querySelector('.detail-header') as HTMLElement;
    const badge = header.querySelector('.resource-status__badge')?.textContent;
    expect(badge).not.toBe('Ready');
    const fixes = within(header).getAllByRole('button');
    expect(fixes).toHaveLength(1);
  });

  test('Usage reads this model connection on this Station only', async () => {
    await render(
      <ProviderSettingsView
        selectedProviderId="ollama-local"
        selectedTab="usage"
        onNavigate={vi.fn()}
      />,
    );
    await waitFor(() =>
      expect(
        stationRequests.some((path) => path.includes('usage-rollup')),
      ).toBe(true),
    );
    const rollup = stationRequests.find((path) =>
      path.startsWith('/api/analytics/usage-rollup'),
    );
    const query = new URLSearchParams(rollup?.split('?')[1]);
    expect(query.get('modelConnectionId')).toBe('ollama-local');
    expect(query.get('localOnly')).toBe('1');
    expect(query.has('connectionId')).toBe(false);
    expect(query.has('provider')).toBe(false);
  });

  test('Usage on a host without connection filters reads nothing', async () => {
    usageFilters.supported = false;
    await render(
      <ProviderSettingsView
        selectedProviderId="ollama-local"
        selectedTab="usage"
        onNavigate={vi.fn()}
      />,
    );
    expect(stationRequests.some((path) => path.includes('usage-rollup'))).toBe(
      false,
    );
  });

  test('choosing a tab routes to it', async () => {
    const onNavigate = vi.fn();
    await render(
      <ProviderSettingsView
        selectedProviderId="ollama-local"
        onNavigate={onNavigate}
      />,
    );
    fireEvent.click(screen.getByRole('tab', { name: 'Usage' }));
    expect(onNavigate).toHaveBeenCalledWith({
      type: 'connections-model-edit',
      id: 'ollama-local',
      tab: 'usage',
    });
  });

  test('Settings edits open the unsaved bar; Discard returns to the saved copy', async () => {
    await render(
      <ProviderSettingsView
        selectedProviderId="ollama-local"
        selectedTab="settings"
        onNavigate={vi.fn()}
      />,
    );
    expect(
      screen.queryByRole('region', { name: 'Unsaved changes' }),
    ).toBeNull();
    // A ready connection can still be checked again from Settings.
    fireEvent.click(screen.getByRole('button', { name: 'Test Connection' }));
    expect(testMutate).toHaveBeenCalledWith('ollama-local');
    fireEvent.change(screen.getByLabelText('Name'), {
      target: { value: 'Renamed' },
    });
    const bar = screen.getByRole('region', { name: 'Unsaved changes' });
    fireEvent.click(within(bar).getByRole('button', { name: 'Discard' }));
    expect(
      screen.queryByRole('region', { name: 'Unsaved changes' }),
    ).toBeNull();
    expect((screen.getByLabelText('Name') as HTMLInputElement).value).toBe(
      'Local Ollama',
    );
    expect(saveMutate).not.toHaveBeenCalled();
  });
});
