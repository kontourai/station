/**
 * @vitest-environment jsdom
 *
 * The Connections IA table, and the `/connections` resolver that reads it.
 *
 * sol review finding 6: the resolver used to carry its OWN attention
 * derivation — `/api/connections` raw for Models and Engines, and no
 * Knowledge case at all — beside the rail's. A redirect is a claim about the
 * same state the rail's warn dots describe, so the test that matters is that
 * they agree on one state, not that each is individually plausible.
 */

import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import {
  CONNECTION_SECTIONS,
  canonicalConnectionPath,
} from '../views/connections-hub/connection-sections';

const state: {
  connections: unknown[];
  engines: unknown[];
  tools: unknown[];
  knowledge: unknown;
  savedStations: unknown[];
  ssh: unknown[];
} = {
  connections: [],
  engines: [],
  tools: [],
  knowledge: undefined,
  savedStations: [],
  ssh: [],
};
const navigate = vi.fn();

vi.mock('@kontourai/station-sdk', () => ({
  useConnectionsQuery: () => ({ data: state.connections }),
  useModelConnectionsQuery: () => ({ data: state.connections }),
  useAgentConnectionsQuery: () => ({ data: state.engines }),
  useIntegrationsQuery: () => ({ data: state.tools }),
  useGlobalKnowledgeStatusQuery: () => ({ data: state.knowledge }),
  useSshEnvironmentsQuery: () => ({ data: state.ssh }),
  sshEnvironmentsToKnownEnvironments: () => [],
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

import { ConnectionsHub } from '../views/ConnectionsHub';
import { ConnectionsSectionFrame } from '../views/ConnectionsSectionFrame';

/** The section whose tab carries the rail's "needs attention" dot, if any. */
function railAttentionSection(): string | undefined {
  return screen
    .getAllByRole('tab')
    .find((tab) => tab.textContent?.includes('•'))
    ?.textContent?.replace(/[^A-Za-z].*$/, '');
}

describe('Connections section IA', () => {
  test('one table supplies the five user-facing sections', () => {
    expect(CONNECTION_SECTIONS.map((section) => section.id)).toEqual([
      'models',
      'engines',
      'tools',
      'knowledge',
      'computers',
    ]);
  });

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
    navigate.mockReset();
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
    state.engines = [
      { id: 'codex', name: 'Codex', enabled: false, status: 'ready' },
    ];

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
});
