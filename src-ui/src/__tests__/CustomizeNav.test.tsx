/**
 * @vitest-environment jsdom
 *
 * The Customize page's left list: its groups, items, counts and attention
 * dots, rendered from the real registry and the one attention derivation
 * (`useConnectionSectionSignals`) over mocked reads in the shapes the
 * server returns.
 */

import { fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, test, vi } from 'vitest';

const state: {
  connections: unknown[];
  engines: unknown[];
  tools: unknown[] | undefined;
  knowledge: unknown;
  savedStations: unknown[];
  ssh: unknown[];
  /** The Engines read's first fetch is still in flight. */
  enginesLoading: boolean;
  /** Live ACP bridge connections and registry entries (managed policy). */
  acpConnections: unknown[];
  acpRegistry: unknown[];
  policy: unknown;
  agents: unknown[] | undefined;
  skills: unknown[] | undefined;
  /** The Engines read failed and has nothing to show. */
  enginesFailed: boolean;
} = {
  enginesFailed: false,
  agents: undefined,
  skills: undefined,
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
  useAgentsQuery: () => ({ data: state.agents }),
  useSkillsQuery: () => ({ data: state.skills }),
  useConnectionsQuery: () => ({ data: state.connections }),
  useModelConnectionsQuery: () => ({ data: state.connections }),
  useEngineConnectionsQuery: () =>
    state.enginesLoading
      ? { data: undefined, isLoading: true, isPending: true }
      : state.enginesFailed
        ? { data: undefined, isError: true, error: new Error('refused') }
        : { data: state.engines, isLoading: false, isPending: false },
  // `undefined` stands for a read that has not answered.
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
vi.mock('../hooks/useSurfaceVisibilityFlags', () => ({
  useSurfaceVisibilityFlags: () => new Set<string>(),
}));

import { CustomizeNav } from '../views/customize/CustomizeNav';

/** The items whose link carries the "needs attention" mark. */
function attentionItems(): string[] {
  return screen
    .getAllByRole('link')
    .filter((link) => link.textContent?.includes('needs attention'))
    .map((link) => link.querySelector('.customize-item__label')!.textContent!);
}

function renderNav(activeId: string | null = null) {
  return render(<CustomizeNav activeId={activeId} />);
}

describe('the Customize list', () => {
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
    state.agents = undefined;
    state.skills = undefined;
    state.enginesFailed = false;
    navigate.mockReset();
  });

  test('lists Overview, then the three groups with their six items in order', () => {
    renderNav();
    const nav = screen.getByRole('navigation', { name: 'Customize' });
    expect(
      within(nav)
        .getAllByRole('heading')
        .map((heading) => heading.textContent),
    ).toEqual(['Your agents', 'What they run on', 'What they can reach']);
    expect(
      within(nav)
        .getAllByRole('link')
        .map((link) => [
          link.querySelector('.customize-item__label')?.textContent,
          link.getAttribute('href'),
        ]),
    ).toEqual([
      ['Overview', '/customize'],
      ['Agents', '/agents'],
      ['Skills', '/guidance?tab=skills'],
      ['Engines', '/customize/engines'],
      ['Providers', '/customize/providers'],
      ['Tools', '/customize/tools'],
      ['Knowledge', '/customize/knowledge'],
    ]);
    // Plugins, Appearance, Developer and Settings left the list.
    for (const gone of ['Plugins', 'Appearance', 'Developer', 'Settings']) {
      expect(within(nav).queryByText(gone)).toBeNull();
    }
  });

  test('marks the current item and navigates in place on a plain click', () => {
    renderNav('engines');
    const engines = screen.getByRole('link', { name: /^Engines/ });
    expect(engines.getAttribute('aria-current')).toBe('page');
    expect(
      screen
        .getByRole('link', { name: /^Overview/ })
        .getAttribute('aria-current'),
    ).toBeNull();
    fireEvent.click(screen.getByRole('link', { name: /^Tools/ }));
    expect(navigate).toHaveBeenCalledWith('/customize/tools');
    navigate.mockReset();
    // A modified click is the browser's: open in a new tab, not in place.
    fireEvent.click(screen.getByRole('link', { name: /^Tools/ }), {
      metaKey: true,
    });
    expect(navigate).not.toHaveBeenCalled();
  });

  test('counts what each item holds, and shows no number before it loads', () => {
    renderNav();
    const count = (name: string) =>
      screen
        .getByRole('link', { name: new RegExp(`^${name}`) })
        .querySelector('.customize-item__count')?.textContent ?? null;
    expect(count('Agents')).toBeNull();
    expect(count('Skills')).toBeNull();
  });

  test('a read that is pending or failed shows no number, never 0', () => {
    const count = (name: string) =>
      screen
        .getByRole('link', { name: new RegExp(`^${name}`) })
        .querySelector('.customize-item__count')?.textContent ?? null;
    state.enginesLoading = true;
    state.tools = undefined;
    const { unmount } = renderNav();
    expect(count('Engines')).toBeNull();
    expect(count('Tools')).toBeNull();
    unmount();
    state.enginesLoading = false;
    state.enginesFailed = true;
    renderNav();
    expect(count('Engines')).toBeNull();
  });

  test('counts agents, skills, engines and tools; never providers or knowledge', () => {
    state.agents = [{ slug: 'a' }, { slug: 'b' }];
    state.skills = [{ name: 's' }];
    state.engines = [engine('codex', 'Codex'), engine('claude', 'Claude')];
    state.tools = [{ id: 'station-docs', connected: false }];
    state.knowledge = {
      vectorDb: { id: 'lancedb-builtin', name: 'Station Built-In' },
      embedding: { id: 'embed', name: 'Embed' },
      stats: { totalDocuments: 0, totalChunks: 0, projectCount: 0 },
    };
    renderNav();
    const count = (name: string) =>
      screen
        .getByRole('link', { name: new RegExp(`^${name}`) })
        .querySelector('.customize-item__count')?.textContent ?? null;
    expect(count('Agents')).toBe('2');
    expect(count('Skills')).toBe('1');
    expect(count('Engines')).toBe('2');
    // Providers counts model connections today, which would read as "0
    // providers" beside signed-in engines; no number until it has a meaning.
    expect(count('Providers')).toBeNull();
    expect(count('Tools')).toBe('1');
    expect(count('Knowledge')).toBeNull();
  });

  test('nothing is marked on a quiet Station', () => {
    renderNav();
    expect(attentionItems()).toEqual([]);
  });

  test('knowledge with no store needs attention', () => {
    state.knowledge = {
      vectorDb: null,
      embedding: null,
      stats: { totalDocuments: 0, totalChunks: 0, projectCount: 0 },
    };
    renderNav();
    expect(attentionItems()).toEqual(['Knowledge']);
  });

  test('a disabled engine in the engine list needs attention', () => {
    state.engines = [engine('codex', 'Codex', { enabled: false })];
    renderNav();
    expect(attentionItems()).toEqual(['Engines']);
  });

  test('a never-probed tool server marks nothing', () => {
    state.tools = [{ id: 'station-docs', connected: false }];
    renderNav();
    expect(attentionItems()).toEqual([]);
  });

  test('a failed tool probe marks Tools', () => {
    state.tools = [
      {
        id: 'audit-echo',
        connected: false,
        probe: { ok: false, toolCount: 0 },
      },
    ];
    renderNav();
    expect(attentionItems()).toEqual(['Tools']);
  });

  test('an engine the server reports failing needs attention', () => {
    state.engines = [
      engine('muse', 'Muse Code', {
        status: 'error',
        setup: { state: 'configured', detected: true, configured: true },
      }),
    ];
    renderNav();
    expect(attentionItems()).toEqual(['Engines']);
  });

  test('a supported, never-added engine marks nothing; a degraded one does', () => {
    state.engines = [
      engine('muse', 'Muse Code', {
        status: 'missing_prerequisites',
        setup: { state: 'available', detected: true, configured: false },
      }),
    ];
    const { unmount } = renderNav();
    expect(attentionItems()).toEqual([]);
    unmount();
    state.engines = [engine('muse', 'Muse Code', { status: 'degraded' })];
    renderNav();
    expect(attentionItems()).toEqual(['Engines']);
  });

  test('knowledge with a store and no embedding model is resting, not attention', () => {
    state.knowledge = {
      vectorDb: { id: 'lancedb-builtin', name: 'Station Built-In' },
      embedding: null,
      stats: { totalDocuments: 0, totalChunks: 0, projectCount: 0 },
    };
    renderNav();
    expect(attentionItems()).toEqual([]);
  });

  test('a model whose check failed marks Providers', () => {
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
    renderNav();
    expect(attentionItems()).toEqual(['Engines', 'Providers']);
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
    renderNav();
    expect(attentionItems()).toEqual([]);
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
    renderNav();
    expect(attentionItems()).toEqual([]);
  });
});
