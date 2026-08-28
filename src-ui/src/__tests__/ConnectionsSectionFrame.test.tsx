/**
 * @vitest-environment jsdom
 *
 * The section rail's counts and warn dots are claims about the list one click
 * away, so each one is derived from the SAME source that list renders
 * (design P5). Live capture caught both halves of getting this wrong:
 * "Models 1" beside a Models section reading "No model connections yet", and
 * "Engines 0" beside a list of three engines.
 */

import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, test, vi } from 'vitest';

const state: {
  connections: unknown[];
  modelConnections: unknown[];
  engines: unknown[];
  tools: unknown[];
  knowledge: unknown;
  savedStations: unknown[];
  ssh: unknown[];
} = {
  connections: [],
  modelConnections: [],
  engines: [],
  tools: [],
  knowledge: undefined,
  savedStations: [],
  ssh: [],
};
const navigate = vi.fn();

vi.mock('@kontourai/station-sdk', () => ({
  useConnectionsQuery: () => ({ data: state.connections }),
// archive#3747: the Models count reads the model INVENTORY route, the same
// one the Models list reads, rather than the full projection plus a
// client-side membership filter.
  useModelConnectionsQuery: () => ({ data: state.modelConnections }),
  useAgentConnectionsQuery: () => ({ data: state.engines }),
  useIntegrationsQuery: () => ({ data: state.tools }),
  useGlobalKnowledgeStatusQuery: () => ({ data: state.knowledge }),
  useSshEnvironmentsQuery: () => ({ data: state.ssh }),
// The Computers count now comes from the same fold the body renders
 //so the frame reaches this adapter too.
  sshEnvironmentsToKnownEnvironments: (views: { profile: { id: string } }[]) =>
    views.map((view) => ({
      schemaVersion: 1,
      id: `ssh-environment:${view.profile.id}`,
      source: 'ssh',
      endpoints: [],
    })),
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
    <div data-testid="frame-actions">{children}</div>
  ),
  PageHeaderScope: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  usePageHeader: vi.fn(),
}));
vi.mock('../views/connections-hub/AddMachineModal', () => ({
  AddMachineModal: ({ isOpen }: { isOpen: boolean }) =>
    isOpen ? <div data-testid="chooser" /> : null,
}));

import { ConnectionsSectionFrame } from '../views/ConnectionsSectionFrame';

function tab(name: string) {
  return screen
    .getAllByRole('tab')
    .find((element) => element.textContent?.startsWith(name))!;
}

describe('ConnectionsSectionFrame', () => {
  beforeEach(() => {
    state.connections = [];
    state.modelConnections = [];
    state.engines = [];
    state.tools = [];
    state.knowledge = undefined;
    state.savedStations = [];
    state.ssh = [];
    navigate.mockReset();
  });

  test('the Models count is the Models list, read from the same route', () => {
// "Models 1" once appeared beside a Models section reading "No model
// connections yet", because the count read `/api/connections` (which
// carries the built-in vector store) while the list read
// `/api/connections/models`. archive#3747 made that route LLM-capable by
// contract and pointed the count at it, so the two cannot disagree.
    state.connections = [
      {
        id: 'lancedb-builtin',
        kind: 'model',
        name: 'Station Built-In',
        type: 'lancedb',
        capabilities: ['vectordb'],
        enabled: true,
        status: 'ready',
      },
      {
        id: 'openai',
        kind: 'model',
        name: 'OpenAI',
        type: 'openai',
        capabilities: ['llm'],
        enabled: true,
        status: 'ready',
      },
    ];
    state.modelConnections = (
      state.connections as Array<{ capabilities: string[] }>
    ).filter((connection) => connection.capabilities.includes('llm'));
    render(
      <ConnectionsSectionFrame sectionId="models">
        <div />
      </ConnectionsSectionFrame>,
    );
    expect(tab('Models').textContent).toContain('1');
  });

  test('the Engines count comes from the engine list the section renders', () => {
    state.connections = [];
    state.modelConnections = [];
    state.engines = [
      { id: 'claude', name: 'Claude Code', enabled: true, status: 'ready' },
      { id: 'codex', name: 'Codex', enabled: true, status: 'ready' },
      { id: 'muse', name: 'Muse Code', enabled: true, status: 'ready' },
    ];
    render(
      <ConnectionsSectionFrame sectionId="engines">
        <div />
      </ConnectionsSectionFrame>,
    );
    expect(tab('Engines').textContent).toContain('3');
  });

  test('a never-probed tool server is not an attention state; a failed probe is', () => {
// archive#4463: assert the TAB's accessible name, not a
// nested `role="status"` — that role is not reliably exposed as its own
// accessible object inside an interactive `role="tab"` button by real
// assistive tech (jsdom does not model that pruning, so the old
// assertion passed while describing a lie). `Tabs` composes the
// attention text into the tab's own `aria-label` instead.
    state.tools = [{ id: 'station-docs', connected: false }];
    const { rerender } = render(
      <ConnectionsSectionFrame sectionId="tools">
        <div />
      </ConnectionsSectionFrame>,
    );
    expect(screen.queryByRole('tab', { name: /needs attention/i })).toBeNull();

    state.tools = [
      {
        id: 'audit-echo',
        connected: false,
        probe: { ok: false, toolCount: 0 },
      },
    ];
    rerender(
      <ConnectionsSectionFrame sectionId="tools">
        <div />
      </ConnectionsSectionFrame>,
    );
    expect(
      screen.getByRole('tab', { name: /Tools.*needs attention/i }),
    ).toBeTruthy();
  });

  test('the Knowledge count is what the section lists, not indexed documents', () => {
    state.knowledge = {
      vectorDb: { id: 'lancedb-builtin', name: 'Station Built-In' },
      embedding: null,
      stats: { totalDocuments: 0, totalChunks: 0, projectCount: 0 },
    };
    render(
      <ConnectionsSectionFrame sectionId="knowledge">
        <div />
      </ConnectionsSectionFrame>,
    );
    expect(tab('Knowledge').textContent).toContain('1');
  });

  test('every section has exactly one add action, and Computers opens the chooser', () => {
    render(
      <ConnectionsSectionFrame sectionId="computers">
        <div />
      </ConnectionsSectionFrame>,
    );
    const actions = screen.getByTestId('frame-actions');
    expect(actions.querySelectorAll('button')).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: 'Add computer' }));
    expect(screen.getByTestId('chooser')).toBeTruthy();
    expect(navigate).not.toHaveBeenCalled();
  });

  test('the other sections route their add action to their own creator', () => {
    for (const [sectionId, path] of [
      ['models', '/connections/models/new'],
      ['engines', '/connections/engines/new'],
      ['tools', '/connections/tools/new'],
    ] as const) {
      navigate.mockReset();
      const { unmount } = render(
        <ConnectionsSectionFrame sectionId={sectionId}>
          <div />
        </ConnectionsSectionFrame>,
      );
      fireEvent.click(
        screen.getByTestId('frame-actions').querySelector('button')!,
      );
      expect(navigate).toHaveBeenCalledWith(path);
      unmount();
    }
  });
});
