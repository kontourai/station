/**
 * @vitest-environment jsdom
 *
 * The Connections IA table, and the `/connections` resolver that reads it.
 *
 * the resolver used to carry its OWN attention
 * derivation — `/api/connections` raw for Models and Engines, and no
 * Knowledge case at all — beside the rail's. A redirect is a claim about the
 * same state the rail's warn dots describe, so the test that matters is that
 * they agree on one state, not that each is individually plausible.
 */

import { act, render, screen } from '@testing-library/react';
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
} = {
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

vi.mock('@kontourai/station-sdk', () => ({
  useConnectionsQuery: () => ({ data: state.connections }),
  useModelConnectionsQuery: () => ({ data: state.connections }),
  useEngineConnectionsQuery: () =>
    state.enginesLoading
      ? { data: undefined, isLoading: true, isPending: true }
      : { data: state.engines, isLoading: false, isPending: false },
  useIntegrationsQuery: () => ({ data: state.tools }),
  useGlobalKnowledgeStatusQuery: () => ({ data: state.knowledge }),
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

import {
  CONNECTIONS_RESOLVE_WAIT_MS,
  ConnectionsHub,
} from '../views/ConnectionsHub';
import { ConnectionsSectionFrame } from '../views/ConnectionsSectionFrame';

/** The section whose tab carries the rail's "needs attention" dot, if any. */
function railAttentionSection(): string | undefined {
  return screen
    .getAllByRole('tab')
    .find((tab) => tab.textContent?.includes('•'))
    ?.textContent?.replace(/[^A-Za-z].*$/, '');
}

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

describe('the /connections resolver', () => {
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
    navigate.mockReset();
    vi.useRealTimers();
  });

  test('lands on Models when nothing needs attention', () => {
    render(<ConnectionsHub />);
    expect(navigate).toHaveBeenCalledWith('/connections/models');
  });

  test('resolves to the SAME section the rail dots, for a state only the rail used to see', () => {
    // Knowledge with no vector store is the case the old resolver was blind
    // to: it had no `knowledge` branch, so it fell through to Models while
    // the rail put a warn dot on Knowledge.
    state.knowledge = {
      vectorDb: null,
      embedding: null,
      stats: { totalDocuments: 0, totalChunks: 0, projectCount: 0 },
    };

    render(
      <ConnectionsSectionFrame sectionId="models">
        <div />
      </ConnectionsSectionFrame>,
    );
    expect(railAttentionSection()).toBe('Knowledge');

    render(<ConnectionsHub />);
    expect(navigate).toHaveBeenCalledWith('/connections/knowledge');
  });

  test('resolves Engines from the engine list, not from every agent-kind connection record', () => {
    // The old resolver read `/api/connections` and filtered `kind: 'agent'`;
    // the rail reads `/api/connections/agents`. A disabled engine present in
    // one and absent from the other made them disagree about whether
    // anything needed attention at all.
    state.engines = [engine('codex', 'Codex', { enabled: false })];

    render(
      <ConnectionsSectionFrame sectionId="models">
        <div />
      </ConnectionsSectionFrame>,
    );
    expect(railAttentionSection()).toBe('Engines');

    render(<ConnectionsHub />);
    expect(navigate).toHaveBeenCalledWith('/connections/engines');
  });

  test('a never-probed tool server sends nobody to Tools; a failed probe does', () => {
    state.tools = [{ id: 'station-docs', connected: false }];
    render(<ConnectionsHub />);
    expect(navigate).toHaveBeenCalledWith('/connections/models');

    navigate.mockReset();
    state.tools = [
      {
        id: 'audit-echo',
        connected: false,
        probe: { ok: false, toolCount: 0 },
      },
    ];
    render(<ConnectionsHub />);
    expect(navigate).toHaveBeenCalledWith('/connections/tools');
  });

  test('waits for the reads before resolving, instead of landing on Models', () => {
    // On first render every read is pending, so "nothing needs attention"
    // was true and the redirect fired for Models before Engines answered.
    state.enginesLoading = true;
    const { rerender } = render(<ConnectionsHub />);
    expect(navigate).not.toHaveBeenCalled();
    expect(
      screen.getByRole('status', { name: 'Loading connections' }),
    ).toBeTruthy();

    state.enginesLoading = false;
    state.engines = [engine('muse', 'Muse Code', { status: 'error' })];
    rerender(<ConnectionsHub />);
    expect(navigate).toHaveBeenCalledTimes(1);
    expect(navigate).toHaveBeenCalledWith('/connections/engines');
  });

  test('an engine the server reports failing needs attention', () => {
    state.engines = [
      engine('muse', 'Muse Code', {
        status: 'error',
        setup: { state: 'configured', detected: true, configured: true },
      }),
    ];
    render(<ConnectionsHub />);
    expect(navigate).toHaveBeenCalledWith('/connections/engines');
  });

  test('a degraded engine needs attention; a supported, never-added one does not', () => {
    state.engines = [
      engine('muse', 'Muse Code', {
        status: 'missing_prerequisites',
        setup: { state: 'available', detected: true, configured: false },
      }),
    ];
    render(<ConnectionsHub />);
    expect(navigate).toHaveBeenCalledWith('/connections/models');

    navigate.mockReset();
    state.engines = [engine('muse', 'Muse Code', { status: 'degraded' })];
    render(<ConnectionsHub />);
    expect(navigate).toHaveBeenCalledWith('/connections/engines');
  });

  test('knowledge with a store and no embedding model is resting, not attention', () => {
    // Semantic search is off, which the Knowledge page says; like an
    // unconnected computer, it is not a fault to send anyone to.
    state.knowledge = {
      vectorDb: { id: 'lancedb-builtin', name: 'Station Built-In' },
      embedding: null,
      stats: { totalDocuments: 0, totalChunks: 0, projectCount: 0 },
    };
    render(
      <ConnectionsSectionFrame sectionId="models">
        <div />
      </ConnectionsSectionFrame>,
    );
    expect(railAttentionSection()).toBeUndefined();
    render(<ConnectionsHub />);
    expect(navigate).toHaveBeenCalledWith('/connections/models');
  });

  test('a model whose check failed puts the dot on Models, ahead of engines', () => {
    state.connections = [
      {
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
      },
    ];
    state.engines = [engine('muse', 'Muse Code', { status: 'degraded' })];
    render(
      <ConnectionsSectionFrame sectionId="engines">
        <div />
      </ConnectionsSectionFrame>,
    );
    expect(railAttentionSection()).toBe('Models');
    render(<ConnectionsHub />);
    expect(navigate).toHaveBeenCalledWith('/connections/models');
  });

  test('resting model states mark nothing: saved-untested, no catalog, retrying', () => {
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
    render(
      <ConnectionsSectionFrame sectionId="engines">
        <div />
      </ConnectionsSectionFrame>,
    );
    expect(railAttentionSection()).toBeUndefined();
  });

  test('engines the policy refuses carry no mark, even when their status is an error', () => {
    state.engines = [
      engine('opencode', 'OpenCode', { type: 'acp', config: {} }),
      // Not allowed by the policy below; its error status alone would mark.
      engine('claude', 'Claude Code', {
        status: 'error',
        config: { engineId: 'claude' },
      }),
    ];
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
    render(
      <ConnectionsSectionFrame sectionId="models">
        <div />
      </ConnectionsSectionFrame>,
    );
    expect(railAttentionSection()).toBeUndefined();
    render(<ConnectionsHub />);
    expect(navigate).toHaveBeenCalledWith('/connections/models');
  });

  test('a read that never answers does not hold the redirect past the wait', () => {
    vi.useFakeTimers();
    state.enginesLoading = true;
    state.tools = [
      {
        id: 'audit-echo',
        connected: false,
        probe: { ok: false, toolCount: 0 },
      },
    ];
    render(<ConnectionsHub />);
    act(() => {
      vi.advanceTimersByTime(CONNECTIONS_RESOLVE_WAIT_MS - 1);
    });
    expect(navigate).not.toHaveBeenCalled();
    act(() => {
      vi.advanceTimersByTime(1);
    });
    // Resolves with what is known: Tools has answered with a failed probe.
    expect(navigate).toHaveBeenCalledTimes(1);
    expect(navigate).toHaveBeenCalledWith('/connections/tools');
  });
});
