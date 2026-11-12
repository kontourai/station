/**
 * @vitest-environment jsdom
 *
 * `useManagedPolicyPending` through the real `ManagedPolicyProvider`. The
 * Overview's own tests stub the hook, so they cannot see the provider stop
 * reporting a read in flight. Here only the network is stubbed: the policy
 * status is a React Query read whose fetch the test resolves or fails, so
 * "pending" is React Query's own answer.
 */

import {
  QueryClient,
  QueryClientProvider,
  useQuery,
} from '@tanstack/react-query';
import {
  act,
  render,
  renderHook,
  screen,
  waitFor,
} from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, test, vi } from 'vitest';

const policy = vi.hoisted(() => ({
  enabled: true,
  resolve: undefined as undefined | ((value: unknown) => void),
  reject: undefined as undefined | ((error: Error) => void),
}));

/** `GET /api/settings/managed-policy`, held until the test answers it. */
function policyRequest() {
  return new Promise((resolve, reject) => {
    policy.resolve = resolve;
    policy.reject = reject;
  });
}

function answered<T>(key: string, data: T) {
  return () =>
    useQuery({ queryKey: [key], queryFn: async () => data, retry: false });
}

/** An engine the policy below refuses, which the server reports failing. */
const refusedEngine = vi.hoisted(() => ({
  id: 'claude',
  kind: 'agent',
  type: 'claude',
  name: 'Claude Code',
  enabled: true,
  status: 'error',
  capabilities: ['agent-runtime'],
  config: { engineId: 'claude' },
  prerequisites: [],
  setup: { state: 'ready', detected: true, configured: true },
}));

/** A loaded status, as the SDK decodes it. */
const loaded = {
  state: 'loaded',
  summary: {
    organization: 'Acme',
    supportUrl: null,
    lockedSettings: [],
    limits: {},
    engines: { allowed: ['acp'], acpRegistryAgents: false, pinned: [] },
  },
};

vi.mock('@kontourai/station-sdk', () => ({
  useManagedPolicyStatusQuery: (apiBase: string) =>
    useQuery({
      queryKey: ['managed-policy', apiBase],
      queryFn: policyRequest,
      enabled: policy.enabled,
      retry: false,
    }),
  useModelConnectionsQuery: answered('models', []),
  useEngineConnectionsQuery: answered('engines', [refusedEngine]),
  useIntegrationsQuery: answered('tools', []),
  // No store: listed, so the list is proven to render once settled.
  useGlobalKnowledgeStatusQuery: answered('knowledge', {
    vectorDb: null,
    embedding: null,
  }),
  useSshEnvironmentsQuery: answered('ssh', []),
  sshEnvironmentsToKnownEnvironments: () => [],
  useACPConnectionsQuery: () => ({ data: [] }),
  useACPConnectionRegistryQuery: () => ({ data: [] }),
  useACPConnectionProbeStatusesQuery: () => ({ data: [] }),
  useACPPublicRegistrySourceQuery: () => ({ data: undefined }),
  useUnregisteredACPConnectionsQuery: () => ({ data: [] }),
  recheckACPConnectionRegistry: vi.fn(),
  refreshACPPublicRegistrySource: vi.fn(),
}));
vi.mock('../contexts/ApiBaseContext', () => ({
  useApiBase: () => ({ apiBase: 'http://station.test' }),
}));
vi.mock('@kontourai/station-connect', () => ({
  useConnections: () => ({ connections: [] }),
}));
vi.mock('../contexts/NavigationContext', () => ({
  useNavigation: () => ({ navigate: vi.fn() }),
}));
vi.mock('../components/page-frame', () => ({ usePageHeader: vi.fn() }));
vi.mock('../views/engine-detail/useEngineAccountAccess', () => ({
  useEngineAccountAccess: () => ({ scope: null, canManage: false }),
}));

import {
  ManagedPolicyProvider,
  useManagedPolicyPending,
  useManagedPolicySummary,
} from '../contexts/ManagedPolicyContext';
import { ConnectionsHub } from '../views/ConnectionsHub';

const TARGET = {
  targetApiBase: 'http://other.test',
} as unknown as Parameters<typeof ManagedPolicyProvider>[0]['target'];

function wrapperFor(client: QueryClient, target?: typeof TARGET) {
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>
      <ManagedPolicyProvider {...(target ? { target } : {})}>
        {children}
      </ManagedPolicyProvider>
    </QueryClientProvider>
  );
}

function readPending(target?: typeof TARGET) {
  const client = new QueryClient();
  const hook = renderHook(
    () => ({
      pending: useManagedPolicyPending(),
      summary: useManagedPolicySummary(),
    }),
    { wrapper: wrapperFor(client, target) },
  );
  return { ...hook, client };
}

afterEach(() => {
  policy.enabled = true;
  policy.resolve = undefined;
  policy.reject = undefined;
});

describe.each([
  ['the host', undefined],
  ['a target Station', TARGET],
] as const)('the managed policy read for %s', (_name, target) => {
  test('is pending while in flight, and not once it answers', async () => {
    const { result, client } = readPending(target);
    expect(result.current.pending).toBe(true);
    expect(result.current.summary).toBeUndefined();
    await act(async () => policy.resolve?.(loaded));
    await waitFor(() => expect(result.current.pending).toBe(false));
    expect(result.current.summary).toEqual(loaded.summary);
    client.clear();
  });

  test('is not pending once it fails', async () => {
    const { result, client } = readPending(target);
    expect(result.current.pending).toBe(true);
    await act(async () => policy.reject?.(new Error('HTTP 500')));
    await waitFor(() => expect(result.current.pending).toBe(false));
    expect(result.current.summary).toBeUndefined();
    client.clear();
  });

  test('is not pending when there is nothing to ask', () => {
    policy.enabled = false;
    const { result, client } = readPending(target);
    expect(result.current.pending).toBe(false);
    expect(policy.resolve).toBeUndefined();
    client.clear();
  });
});

test('the Overview never lists a policy-refused engine during the first policy read', async () => {
  const client = new QueryClient();
  render(<ConnectionsHub />, { wrapper: wrapperFor(client) });
  // Every other read answers first, the engines read included, while the
  // policy is still in flight.
  await waitFor(() =>
    expect(client.getQueryState(['engines'])?.status).toBe('success'),
  );
  await waitFor(() =>
    expect(screen.getByRole('button', { name: /^Models/ }).textContent).toBe(
      'Models0',
    ),
  );
  expect(
    client.getQueryState(['managed-policy', 'http://station.test'])?.status,
  ).toBe('pending');
  expect(screen.queryByText('Claude Code')).toBeNull();
  expect(screen.getByRole('status', { name: 'Loading Engines' })).toBeTruthy();

  await act(async () => policy.resolve?.(loaded));
  await waitFor(() =>
    expect(screen.getByRole('button', { name: /^Engines/ }).textContent).toBe(
      'Engines1',
    ),
  );
  // Refused by the policy: not something the reader can fix.
  expect(screen.queryByText('Claude Code')).toBeNull();
  expect(screen.getByRole('link', { name: 'Knowledge store' })).toBeTruthy();
  client.clear();
});
