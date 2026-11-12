/**
 * @vitest-environment jsdom
 *
 * The Connections IA table, and the `/connections` Overview that reads it.
 *
 * The old resolver carried its OWN attention derivation — `/api/connections`
 * raw for Models and Engines, and no Knowledge case at all — beside the
 * rail's. The Overview's attention list is a claim about the same state the
 * rail's marks describe, so the tests that matter are that they agree on one
 * state, and that access-gated reads are never made for a viewer without
 * access.
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { canonicalConnectionPath } from '../views/connections-hub/connection-sections';

const state: {
  connections: unknown[];
  engines: unknown[];
  tools: unknown[];
  knowledge: unknown;
  savedStations: unknown[];
  ssh: unknown[];
  /** The Engines read's first fetch is still in flight. */
  enginesLoading: boolean;
  /** Live ACP bridge connections and registry entries (managed policy). */
  acpConnections: unknown[];
  acpRegistry: unknown[];
  policy: unknown;
  /** Reads that failed, by section. */
  failed: string[];
  /** The viewer's `access:manage` grant. */
  canManage: boolean;
  /** The host's `usageConnectionFilters` capability. */
  capability: boolean | null;
  rollupRows: unknown[];
} = {
  failed: [],
  canManage: false,
  capability: true,
  rollupRows: [],
  enginesLoading: false,
  acpConnections: [],
  acpRegistry: [],
  policy: undefined,
  connections: [],
  engines: [],
  tools: [],
  knowledge: undefined,
  savedStations: [],
  ssh: [],
};
const navigate = vi.fn();

/** An engine row in the shape `/api/connections/agents` returns. */
function engine(
  id: string,
  name: string,
  overrides: Record<string, unknown> = {},
) {
  return {
    id,
    kind: 'agent',
    type: id,
    name,
    enabled: true,
    status: 'ready',
    capabilities: ['agent-runtime'],
    config: {},
    prerequisites: [],
    setup: { state: 'ready', detected: true, configured: true },
    ...overrides,
  };
}

const refetch = vi.fn();
/** A read in the shape the SDK hooks return, failed when its section is. */
function read(section: string, data: unknown) {
  return state.failed.includes(section)
    ? { data: undefined, isLoading: false, isError: true, refetch }
    : { data, isLoading: false, isError: false, refetch };
}

const fetchAccounts = vi.fn();
const fetchAllowance = vi.fn();
const readCapability = vi.fn(async (_apiBase: string) => state.capability);
const rollupRead = vi.fn();
const SCOPE = { apiBase: 'http://station.test', authorityKey: 'k' };

vi.mock('@kontourai/station-sdk', () => ({
  useConnectionsQuery: () => ({ data: state.connections }),
  useModelConnectionsQuery: () => read('models', state.connections),
  useEngineConnectionsQuery: () =>
    state.enginesLoading
      ? { data: undefined, isLoading: true, isPending: true }
      : { ...read('engines', state.engines), isPending: false },
  useIntegrationsQuery: () => read('tools', state.tools),
  useGlobalKnowledgeStatusQuery: () => read('knowledge', state.knowledge),
  useSshEnvironmentsQuery: () => ({ data: state.ssh }),
  sshEnvironmentsToKnownEnvironments: () => [],
  useACPConnectionsQuery: () => ({ data: state.acpConnections }),
  useACPConnectionRegistryQuery: () => ({ data: state.acpRegistry }),
  useACPConnectionProbeStatusesQuery: () => ({ data: [] }),
  useACPPublicRegistrySourceQuery: () => ({ data: undefined }),
  useUnregisteredACPConnectionsQuery: () => ({ data: [] }),
  recheckACPConnectionRegistry: vi.fn(),
  refreshACPPublicRegistrySource: vi.fn(),
}));
vi.mock('@kontourai/station-sdk/engine-accounts', () => ({
  useEngineAccountsQuery: (id: string, _scope: unknown, enabled: boolean) => {
    if (!enabled) return { data: undefined };
    fetchAccounts(id);
    return {
      data: {
        engine: id,
        accounts: [
          { ref: null, label: 'Default account', authState: 'ok' },
          { ref: 'work', label: 'Work', authState: 'ok' },
        ],
        activeProfileRef: 'work',
      },
      isError: false,
    };
  },
  useEngineAccountUsageQuery: (
    id: string,
    ref: string | null,
    _scope: unknown,
    enabled: boolean,
  ) => {
    if (!enabled) return { data: undefined };
    fetchAllowance(id, ref);
    return {
      data: {
        status: 'ok',
        fetchedAt: '2026-11-12T10:00:00.000Z',
        exhausted: false,
        windows: [{ id: 'week', label: '7-day limit', usedPercent: 75 }],
      },
      isError: false,
    };
  },
}));
vi.mock('@kontourai/station-sdk/client', () => ({
  readUsageConnectionFiltersCapability: (apiBase: string) =>
    readCapability(apiBase),
}));
vi.mock('@kontourai/station-sdk/usage-rollup-query', () => ({
  useUsageRollupQuery: (query: unknown, config: { enabled?: boolean }) => {
    if (!config.enabled) return { data: undefined };
    rollupRead(query);
    return {
      data: {
        window: { from: '2026-11-05', to: '2026-11-12' },
        rows: state.rollupRows,
        coverage: [],
        receipts: [],
      },
      isError: false,
    };
  },
}));
vi.mock('../views/engine-detail/useEngineAccountAccess', () => ({
  useEngineAccountAccess: () => ({
    scope: SCOPE,
    authority: { isLoading: false, data: {} },
    canManage: state.canManage,
    canLogin: state.canManage,
  }),
}));
vi.mock('../contexts/ManagedPolicyContext', () => ({
  useManagedPolicySummary: () => state.policy,
}));
vi.mock('@kontourai/station-connect', () => ({
  useConnections: () => ({ connections: state.savedStations }),
}));
vi.mock('../contexts/NavigationContext', () => ({
  useNavigation: () => ({ navigate }),
}));
vi.mock('../components/page-frame', () => ({
  PageEyebrowTrail: ({
    segments,
  }: {
    segments: Array<{ label: string; onClick?: () => void }>;
  }) => (
    <>
      {segments.map((segment) => (
        <span key={segment.label}>{segment.label}</span>
      ))}
    </>
  ),
  PageFrameActions: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  PageHeaderScope: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  usePageHeader: vi.fn(),
}));
vi.mock('../views/connections-hub/AddMachineModal', () => ({
  AddMachineModal: () => null,
}));

vi.mock('../views/connections-hub/IntegrationStatusSection', () => ({
  IntegrationStatusSection: () => <div data-testid="integration-status-slot" />,
}));

import { ConnectionsHub } from '../views/ConnectionsHub';
import { ConnectionsSectionFrame } from '../views/ConnectionsSectionFrame';

/** The section whose tab carries the rail's "needs attention" dot, if any. */
function railAttentionSections(): string[] {
  return screen
    .getAllByRole('tab')
    .filter((tab) => tab.textContent?.includes('•'))
    .map((tab) => tab.textContent!.replace(/[^A-Za-z].*$/, ''));
}

function renderRail() {
  return render(
    <ConnectionsSectionFrame sectionId="models">
      <div />
    </ConnectionsSectionFrame>,
  );
}

function renderHub() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <ConnectionsHub />
    </QueryClientProvider>,
  );
}

/** Each attention item's title and badge, in order; [] when none. */
function attentionItems(): string[] {
  const list = screen.queryByRole('list', {
    name: 'Connections needing attention',
  });
  if (!list) return [];
  return within(list)
    .getAllByRole('listitem')
    .map((item) => {
      const title = item.querySelector('strong')?.textContent ?? '';
      const badge =
        item.querySelector('.resource-status')?.getAttribute('title') ?? '';
      return `${title}: ${badge}`;
    });
}

const failedModel = {
  id: 'anthropic-1',
  kind: 'model',
  type: 'anthropic',
  name: 'Anthropic',
  enabled: true,
  status: 'ready',
  capabilities: ['llm'],
  config: {},
  prerequisites: [],
  readinessEvidence: {
    evidenceVersion: 1,
    level: 'catalog-ready',
    observedAt: '2026-08-20T10:00:00.000Z',
    freshness: 'fresh',
    summary: '',
    smoke: { status: 'not-tested', freshness: 'unknown', turnLimit: 1 },
    check: { status: 'failed', checkedAt: '2026-08-20T10:00:00.000Z' },
  },
};

describe('Connections section IA', () => {
  test.each([
    ['/connections/providers', '/connections/models'],
    ['/connections/acp', '/connections/engines'],
    ['/connections/agents', '/connections/engines'],
    ['/connections/agent-apps', '/connections/engines'],
    ['/connections/environments', '/connections/computers'],
  ])('redirects %s through the section table', (legacy, canonical) => {
    expect(canonicalConnectionPath(legacy)).toBe(canonical);
  });
});

describe('the /connections Overview', () => {
  beforeEach(() => {
    state.connections = [];
    state.engines = [];
    state.tools = [];
    state.knowledge = undefined;
    state.savedStations = [];
    state.ssh = [];
    state.enginesLoading = false;
    state.acpConnections = [];
    state.acpRegistry = [];
    state.policy = undefined;
    state.failed = [];
    state.canManage = false;
    state.capability = true;
    state.rollupRows = [];
    navigate.mockReset();
    refetch.mockReset();
    fetchAccounts.mockReset();
    fetchAllowance.mockReset();
    readCapability.mockClear();
    rollupRead.mockReset();
  });

  test('is a page: it stays on /connections and says when nothing needs attention', () => {
    renderHub();
    expect(navigate).not.toHaveBeenCalled();
    expect(screen.getByText('Nothing needs attention')).toBeTruthy();
    expect(attentionItems()).toEqual([]);
  });

  test('lists every connection needing attention, across sections, in the words its own page uses', () => {
    state.connections = [failedModel];
    state.engines = [engine('muse', 'Muse Code', { status: 'degraded' })];
    state.tools = [
      { id: 'station-docs', connected: false },
      {
        id: 'audit-echo',
        displayName: 'Audit Echo',
        connected: false,
        probe: { ok: false, toolCount: 0, error: 'spawn ENOENT' },
      },
    ];
    state.knowledge = {
      vectorDb: null,
      embedding: null,
      stats: { totalDocuments: 0, totalChunks: 0, projectCount: 0 },
    };
    renderHub();
    expect(attentionItems()).toEqual([
      'Anthropic: Check failed',
      'Muse Code: Limited',
      'Audit Echo: Check failed',
      'Knowledge store: Setup required',
    ]);
    // One sentence each: the tool server's own failure, not a generic one.
    expect(screen.getByText('spawn ENOENT')).toBeTruthy();
    expect(screen.queryByText('Nothing needs attention')).toBeNull();

    // The rail marks exactly the sections the list names.
    renderRail();
    expect(railAttentionSections()).toEqual([
      'Models',
      'Engines',
      'Tools',
      'Knowledge',
    ]);
  });

  test("each item's one action is the fix its status names, opening the page that performs it", () => {
    state.engines = [
      engine('codex', 'Codex', { enabled: false }),
      engine('claude', 'Claude Code', {
        status: 'missing_prerequisites',
        prerequisites: [
          {
            id: 'claude-auth',
            name: 'Claude login',
            category: 'required',
            status: 'missing',
          },
        ],
      }),
    ];
    state.connections = [failedModel];
    renderHub();
    fireEvent.click(screen.getByRole('button', { name: 'Enable: Codex' }));
    expect(navigate).toHaveBeenLastCalledWith('/connections/engines/codex');
    // Claude Code signs in on its Accounts tab, as its own header does.
    fireEvent.click(
      screen.getByRole('button', { name: 'Sign in: Claude Code' }),
    );
    expect(navigate).toHaveBeenLastCalledWith(
      '/connections/engines/claude/accounts',
    );
    fireEvent.click(screen.getByRole('button', { name: /^.+: Anthropic$/ }));
    expect(navigate).toHaveBeenLastCalledWith(
      '/connections/models/anthropic-1',
    );
  });

  test('resting states and policy refusals list nothing and mark nothing', () => {
    const evidence = (
      check: Record<string, unknown>,
      level = 'catalog-ready',
    ) => ({
      evidenceVersion: 1,
      level,
      observedAt: '2026-08-20T10:00:00.000Z',
      freshness: 'fresh',
      summary: '',
      smoke: { status: 'not-tested', freshness: 'unknown', turnLimit: 1 },
      check,
    });
    const at = '2026-08-20T10:00:00.000Z';
    state.connections = [
      evidence({ status: 'not-checked' }, 'prerequisite-ready'),
      evidence({ status: 'catalog-unavailable', checkedAt: at }),
      evidence({ status: 'unreachable', retrying: true, checkedAt: at }),
    ].map((readinessEvidence, index) => ({
      id: `model-${index}`,
      kind: 'model',
      type: 'openai-compat',
      name: `Model ${index}`,
      enabled: true,
      status: 'ready',
      capabilities: ['llm'],
      config: {},
      prerequisites: [],
      readinessEvidence,
    }));
    // Knowledge with a store and no embedding model: semantic search is off,
    // which the Knowledge page says; it is not a fault.
    state.knowledge = {
      vectorDb: { id: 'lancedb-builtin', name: 'Station Built-In' },
      embedding: null,
      stats: { totalDocuments: 0, totalChunks: 0, projectCount: 0 },
    };
    state.engines = [
      engine('opencode', 'OpenCode', { type: 'acp', config: {} }),
      // Not allowed by the policy below; its error status alone would mark.
      engine('claude', 'Claude Code', {
        status: 'error',
        config: { engineId: 'claude' },
      }),
      // Supported, never added: the Engines list does not show it.
      engine('muse', 'Muse Code', {
        status: 'missing_prerequisites',
        setup: { state: 'available', detected: true, configured: false },
      }),
    ];
    state.tools = [{ id: 'station-docs', connected: false }];
    state.acpConnections = [{ id: 'opencode', name: 'OpenCode' }];
    state.acpRegistry = [
      { id: 'opencode', installed: true, source: 'registry' },
    ];
    state.policy = {
      organization: 'Acme',
      supportUrl: null,
      lockedSettings: [],
      limits: {},
      engines: { allowed: ['acp'], acpRegistryAgents: false, pinned: [] },
    };
    renderHub();
    expect(attentionItems()).toEqual([]);
    expect(screen.getByText('Nothing needs attention')).toBeTruthy();
    renderRail();
    expect(railAttentionSections()).toEqual([]);
  });

  test('an engine the server reports failing is listed even when setup placed it', () => {
    state.engines = [
      engine('muse', 'Muse Code', {
        status: 'error',
        setup: { state: 'configured', detected: true, configured: true },
      }),
    ];
    renderHub();
    expect(attentionItems()).toEqual(['Muse Code: Unreachable']);
  });

  test('waits for the reads before saying nothing needs attention', () => {
    state.enginesLoading = true;
    const { rerender } = renderHub();
    expect(
      screen.getByRole('status', { name: 'Loading connections' }),
    ).toBeTruthy();
    expect(screen.queryByText('Nothing needs attention')).toBeNull();

    state.enginesLoading = false;
    state.engines = [engine('muse', 'Muse Code', { status: 'error' })];
    rerender(
      <QueryClientProvider client={new QueryClient()}>
        <ConnectionsHub />
      </QueryClientProvider>,
    );
    expect(
      screen.queryByRole('status', { name: 'Loading connections' }),
    ).toBeNull();
    expect(attentionItems()).toEqual(['Muse Code: Unreachable']);
  });

  test('a failed read is stated with a retry, never as nothing to fix', () => {
    state.failed = ['engines'];
    state.tools = [
      {
        id: 'audit-echo',
        connected: false,
        probe: { ok: false, toolCount: 0 },
      },
    ];
    renderHub();
    expect(
      screen.getByText('Some connections could not be loaded'),
    ).toBeTruthy();
    expect(screen.queryByText('Nothing needs attention')).toBeNull();
    // What did answer is still listed.
    expect(attentionItems()).toEqual(['audit-echo: Check failed']);
    const engines = screen.getByRole('button', { name: /^Engines/ });
    expect(engines.textContent).toContain('Not loaded');
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(refetch).toHaveBeenCalledTimes(1);
  });

  test('section tiles show each count and mark, and open their section', () => {
    state.connections = [failedModel];
    state.engines = [
      engine('codex', 'Codex'),
      engine('claude', 'Claude Code', { type: 'claude' }),
    ];
    renderHub();
    const models = screen.getByRole('button', { name: /^Models/ });
    expect(models.textContent).toBe('Models1Needs attention');
    const engines = screen.getByRole('button', { name: /^Engines/ });
    expect(engines.textContent).toBe('Engines2');
    fireEvent.click(engines);
    expect(navigate).toHaveBeenCalledWith('/connections/engines');
  });

  test('without access:manage there is no allowance or usage, and nothing is asked for', async () => {
    state.engines = [engine('claude', 'Claude Code')];
    renderHub();
    expect(screen.queryByRole('heading', { name: 'Allowance' })).toBeNull();
    expect(
      screen.queryByRole('heading', { name: 'Usage, last 7 days' }),
    ).toBeNull();
    await Promise.resolve();
    expect(fetchAccounts).not.toHaveBeenCalled();
    expect(fetchAllowance).not.toHaveBeenCalled();
    expect(readCapability).not.toHaveBeenCalled();
    expect(rollupRead).not.toHaveBeenCalled();
  });

  test('with access:manage: allowance for engines with accounts, and 7 days of usage by connection', async () => {
    state.canManage = true;
    state.engines = [
      engine('claude', 'Claude Code'),
      engine('muse', 'Muse Code'),
    ];
    state.rollupRows = [
      {
        key: 'connection:"muse"',
        stationId: 'local',
        provider: 'muse',
        connectionId: 'muse',
        inputTokens: 100,
        outputTokens: 20,
        pricingStatus: 'unpriced',
        receiptCount: 2,
      },
      {
        key: 'connection:null',
        stationId: 'local',
        provider: 'claude',
        inputTokens: 1000,
        outputTokens: 500,
        pricingStatus: 'unpriced',
        receiptCount: 4,
      },
    ];
    renderHub();
    // Only the engine that holds accounts, read for the account runs use.
    expect(fetchAccounts.mock.calls).toEqual([['claude']]);
    expect(fetchAllowance.mock.calls).toEqual([['claude', 'work']]);
    const allowance = screen.getByRole('region', {
      name: 'Claude Code allowance',
    });
    expect(within(allowance).getByText('25% left')).toBeTruthy();

    const table = await screen.findByRole('table');
    expect(rollupRead).toHaveBeenCalledWith({
      days: 7,
      localOnly: true,
      groupBy: 'connection',
      pageSize: 100,
    });
    expect(
      within(table)
        .getAllByRole('row')
        .slice(1)
        .map((row) => row.textContent),
    ).toEqual(['Not attributed1,500', 'Muse Code120']);
  });

  test('a host without connection filters is never asked to group by connection', async () => {
    state.canManage = true;
    state.capability = false;
    renderHub();
    await waitFor(() =>
      expect(
        screen.getByText('Update Station to see usage by connection'),
      ).toBeTruthy(),
    );
    expect(readCapability).toHaveBeenCalledWith(SCOPE.apiBase);
    expect(rollupRead).not.toHaveBeenCalled();
  });
});
