/**
 * @vitest-environment jsdom
 *
 * archive#1089 — the rendered surface, not just the pure resolver.
 *
 * The new-chat picker's workspace control printed "~ (defaults to home)" for
 * any project with no `workingDirectory`. Measured on origin/main (1e5b45d2):
 * a chat in such a project, on an engine connection whose Working Directory
 * was `/tmp/s1089-elsewhere`, started with `session.cwd =
 * /tmp/s1089-elsewhere` and the engine CLI's own `getcwd` read back
 * `/private/tmp/s1089-elsewhere`. The control was describing a directory the
 * agent was never going to be in.
 *
 * The selection-model hook is mocked (as the sibling picker suite does) so the
 * ACP connection list and the selected project can be varied directly; the
 * component under test — NewChatModal's own render of the hint — is real.
 */
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, test, vi } from 'vitest';
import type { AgentData } from '../contexts/AgentsContext';

const ACP_AGENT: AgentData = {
  slug: 'oc-elsewhere',
  name: 'OpenCode',
  execution: { agentConnectionId: 'oc-elsewhere' },
} as AgentData;

const selectionModelState = {
  isGlobal: false as boolean,
  selectedProject: undefined as any,
  acpConnections: [] as Array<{
    id: string;
    cwd?: string;
    currentModel: string | null;
  }>,
};

// NewChatModal's Enable posts to `/agents/materialize-engine` through this
// SDK mutation; a minimal mock keeps react-query's provider requirement out
// of this render tree.
vi.mock('../contexts/ApiBaseContext', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../contexts/ApiBaseContext')>()),
  useHostRequestAuthorityScope: () => undefined,
}));

vi.mock('@kontourai/station-sdk', () => ({
  useSkillExperienceInventoryQuery: () => ({
    data: { experiences: [], diagnostics: [] },
    refetch: vi.fn(),
  }),
  useMaterializeEngineAgentMutation: () => ({ mutateAsync: vi.fn() }),
}));

vi.mock('../hooks/useIsMobile', () => ({ useIsMobile: () => false }));
vi.mock('../hooks/useDevicePresentation', () => ({
  useDevicePresentation: () => undefined,
}));

vi.mock('../hooks/useNewChatSelectionModel', () => ({
  useNewChatSelectionModel: () => ({
    viewModel: {
      isGlobal: selectionModelState.isGlobal,
      selectedProject: selectionModelState.selectedProject,
      contextOptions: [],
      filteredContextOptions: [],
      currentContextOption: {
        value: selectionModelState.selectedProject?.slug ?? '__global__',
        label: selectionModelState.selectedProject?.name ?? 'No workspace',
        glyph: 'folder',
      },
      groups: [{ label: 'OpenCode', glyph: 'engine', agents: [ACP_AGENT] }],
      flatList: [ACP_AGENT],
      compatibilityMessage: undefined,
    },
    acpConnections: selectionModelState.acpConnections,
    runtimeLoading: false,
    modelsLoading: false,
    modelPickerAgent: null,
    setModelPickerAgent: vi.fn(),
    modelChoices: {},
    setModelChoices: vi.fn(),
    modelsForAgent: () => [],
    executionModelsForAgent: () => [],
    modelChoiceKey: (agent: AgentData) => agent.slug,
    defaultEffectiveModelForAgent: () => ({
      id: undefined,
      source: 'agent default',
    }),
  }),
}));

const { NewChatModal } = await import('../components/modals/NewChatModal');

afterEach(cleanup);
beforeAll(() => {
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: vi.fn().mockReturnValue({
      matches: false,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    }),
  });
  Element.prototype.scrollIntoView = vi.fn();
});

function renderModal() {
  render(
    <NewChatModal
      projectIconBySlug={new Map()}
      agents={[ACP_AGENT]}
      projects={[]}
      onSelect={vi.fn()}
      onClose={vi.fn()}
    />,
  );
}

describe('NewChatModal workspace hint (#1089)', () => {
  test("shows the engine connection's directory, not 'Home folder', for a directoryless project", () => {
    selectionModelState.isGlobal = false;
    selectionModelState.selectedProject = {
      slug: 'scope-only',
      name: 'Scope Only',
    };
    selectionModelState.acpConnections = [
      { id: 'oc-elsewhere', cwd: '/tmp/s1089-elsewhere', currentModel: null },
    ];

    renderModal();

    expect(screen.queryByText('Home folder')).toBe(null);
    const breadcrumb = screen.getByLabelText(
      'Working directory: /tmp/s1089-elsewhere',
    );
    expect(breadcrumb.tagName).toBe('OUTPUT');
  });

  test('still says home when the connection states no directory either', () => {
    selectionModelState.isGlobal = false;
    selectionModelState.selectedProject = {
      slug: 'scope-only',
      name: 'Scope Only',
    };
    selectionModelState.acpConnections = [
      { id: 'oc-elsewhere', currentModel: null },
    ];

    renderModal();

    // #765 F8: plain copy, with the tilde answer preserved as the tooltip.
    const fallback = screen.getByText('Home folder');
    expect(fallback).toBeDefined();
    expect(fallback.getAttribute('title')).toContain('~');
  });

  test('a folder the server did not check says so beside the stored folder (#3391)', () => {
    selectionModelState.isGlobal = false;
    selectionModelState.selectedProject = {
      slug: 'slow',
      name: 'Slow',
      workingDirectory: '/work/slow',
      runsAt: { kind: 'unchecked', reason: 'busy' },
    };
    selectionModelState.acpConnections = [];

    renderModal();

    expect(
      screen.getByLabelText('Working directory: /work/slow'),
    ).toBeDefined();
    expect(screen.getByText('(not checked yet)')).toBeDefined();
  });

  test('an unbound chat names the connection directory rather than claiming the home directory', () => {
    selectionModelState.isGlobal = true;
    selectionModelState.selectedProject = undefined;
    selectionModelState.acpConnections = [
      { id: 'oc-elsewhere', cwd: '/tmp/s1089-elsewhere', currentModel: null },
    ];

    renderModal();

    expect(screen.queryByText('Home folder')).toBe(null);
    expect(
      screen.getByLabelText('Working directory: /tmp/s1089-elsewhere'),
    ).toBeDefined();
  });
});
