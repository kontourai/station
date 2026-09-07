/**
 * @vitest-environment jsdom
 */

import {
  ConnectionStore,
  ConnectionsProvider,
} from '@kontourai/station-connect';
import { agentId } from '@kontourai/station-contracts/agent-identity';
import type { ProjectConfig } from '@kontourai/station-contracts/project';
import { paneAdaptationFromLayoutTab } from '@kontourai/station-contracts/workspace-pane-layout-adapter';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { DEGRADED_QUERY_TIMEOUT_MS } from '../hooks/useDegradedQueryState';
import { OPEN_PROJECT_CHATS_EVENT } from '../lib/projectChatEvents';

const sdkMocks = vi.hoisted(() => ({
  project: undefined as ProjectConfig | undefined,
  isLoading: false,
  isError: false,
  error: undefined as Error | undefined,
  refetch: vi.fn(),
  layouts: [] as any[],
  layoutsLoading: false,
  layoutsError: false,
  refetchLayouts: vi.fn(),
  panes: [] as any[],
  paneInstances: [] as any[],
  paneAvailability: [] as any[],
  paneCatalogError: false,
  refetchPanes: vi.fn(),
  sessions: [] as Array<Record<string, unknown>>,
  agents: [] as Array<Record<string, unknown>>,
  engineConnections: [] as Array<Record<string, unknown>>,
}));

// The remote-isolation renderer gate is a PluginRegistry load-status fact.
// One test sets it; the default is the ordinary settled-with-no-failure shape.
const pluginRegistryState = vi.hoisted(() => ({
  loadStatus: {} as { failure?: string },
}));
vi.mock('../core/PluginRegistry', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../core/PluginRegistry')>()),
  pluginRegistry: {
    subscribe: () => () => undefined,
    getLoadStatus: () => pluginRegistryState.loadStatus,
  },
}));

const navigationMocks = vi.hoisted(() => ({
  navigate: vi.fn(),
  setLayout: vi.fn(),
  setConversation: vi.fn(),
  setDockState: vi.fn(),
}));

// `RegionModelProvider` wraps the whole application, so `useShowSurface`
// requires it. This harness mounts a fragment of that tree, and nothing
// here asserts a surface reveal, so the command hook is supplied directly.
const showSurfaceStub = vi.hoisted(() => vi.fn());
vi.mock('../contexts/useShowSurface', () => ({
  useShowSurface: () => showSurfaceStub,
}));

vi.mock('../contexts/ApiBaseContext', () => ({
  useApiBase: () => ({ apiBase: 'http://localhost:3141' }),
}));

vi.mock('../contexts/NavigationContext', () => ({
  useNavigation: () => ({
    setLayout: navigationMocks.setLayout,
    setConversation: navigationMocks.setConversation,
    navigate: navigationMocks.navigate,
    setDockState: navigationMocks.setDockState,
  }),
}));

vi.mock('../hooks/useGitStatus', () => ({
  useGitStatus: () => ({ data: undefined }),
  useGitLog: () => ({ data: [] }),
}));

vi.mock('../hooks/useRecentLayouts', () => ({
  trackRecentLayout: vi.fn(),
}));

vi.mock('@kontourai/station-sdk', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@kontourai/station-sdk')>()),
  useProjectQuery: vi.fn(() => ({
    data: sdkMocks.project,
    isLoading: sdkMocks.isLoading,
    isError: sdkMocks.isError,
    error: sdkMocks.error,
    refetch: sdkMocks.refetch,
  })),
  useProjectLayoutsQuery: vi.fn(() => ({
    data: sdkMocks.layouts,
    isLoading: sdkMocks.layoutsLoading,
    isError: sdkMocks.layoutsError,
    refetch: sdkMocks.refetchLayouts,
  })),
  useKnowledgeDocsQuery: vi.fn(() => ({ data: [] })),
  useKnowledgeStatusQuery: vi.fn(() => ({ data: undefined })),
  useKnowledgeNamespacesQuery: vi.fn(() => ({ data: [] })),
  useProjectConversationsQuery: vi.fn(() => ({ data: [] })),
  useAvailableProjectLayoutsQuery: vi.fn(() => ({
    data: [],
    isLoading: false,
    error: null,
    refetch: vi.fn(),
  })),
  useUpdateProjectMutation: vi.fn(() => ({
    isPending: false,
    mutate: vi.fn(),
  })),
  useApplyProjectLayoutMutation: vi.fn(() => ({
    mutateAsync: vi.fn(),
  })),
  // Keep the new pane deployment query out of this Project Page unit fixture.
  useServerCapabilitiesQuery: vi.fn(() => ({ data: undefined })),
  useOrchestrationSessionsQuery: vi.fn(() => ({ data: sdkMocks.sessions })),
  useAgentsQuery: vi.fn(() => ({
    data: sdkMocks.agents,
    isSuccess: true,
    catalogState: 'live',
  })),
  useEngineConnectionsQuery: vi.fn(() => ({
    data: sdkMocks.engineConnections,
  })),
}));

vi.mock('@kontourai/station-sdk/workspace-pane', () => ({
  useProjectWorkspacePanesQuery: () => ({
    data: {
      projectId: sdkMocks.project?.id,
      descriptors: sdkMocks.panes,
      instances: sdkMocks.paneInstances,
      availability: sdkMocks.paneAvailability,
    },
    isLoading: false,
    isError: sdkMocks.paneCatalogError,
    refetch: sdkMocks.refetchPanes,
  }),
}));

import { ProjectPage } from '../views/ProjectPage';

const projectFixture: ProjectConfig = {
  id: 'project-demo',
  slug: 'demo',
  name: 'Demo Project',
  icon: 'D',
  description: 'Demo project description',
  workingDirectory: '/Users/brian/dev/demo',
  defaultModel: 'openai:gpt-5',
  agents: [agentId('codex')],
  createdAt: '2026-07-07T12:00:00.000Z',
  updatedAt: '2026-07-07T12:00:00.000Z',
};

/**
 * One Coding-hosted pane occurrence, exactly as the layout adapter derives it
 * from a built-in layout tab — the shape `/api/projects/:slug/panes` returns.
 */
function codingPaneAdaptation(label: string, layoutSlug: string) {
  const adaptation = paneAdaptationFromLayoutTab(
    {
      id: 'coding',
      label,
      component: { kind: 'builtin-component', name: 'coding' },
    },
    {
      layoutSlug,
      instanceScope: 'project:project-demo:source:builtin:coding',
      modeContextRequirement: { project: true, source: true },
      boundContext: { projectId: 'project-demo', sourceId: 'builtin:coding' },
    },
  );
  if (!adaptation) throw new Error('pane adaptation fixture is invalid');
  return adaptation;
}

/** The server availability projection for a pane nothing is wrong with. */
function availableFor(descriptorId: string) {
  return {
    descriptorId,
    availability: {
      state: 'available',
      reason: { code: 'ready', source: 'resolver' },
    },
    input: {
      rollout: 'available',
      distribution: 'enabled',
      host: { state: 'supported' },
      deployment: { state: 'supported' },
      renderer: 'present',
      context: { project: 'present' },
    },
  };
}

async function renderProjectPage(waitForRenderTick = true) {
  const values = new Map<string, string>();
  const store = new ConnectionStore({
    storage: {
      get: (key) => values.get(key) ?? null,
      set: (key, value) => values.set(key, value),
      remove: (key) => values.delete(key),
    },
  });
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
        refetchOnMount: false,
        refetchOnReconnect: false,
        refetchOnWindowFocus: false,
      },
    },
  });
  queryClient.setQueryData(['config'], {});
  let view!: ReturnType<typeof render>;
  await act(async () => {
    view = render(
      <QueryClientProvider client={queryClient}>
        <ConnectionsProvider store={store}>
          <ProjectPage slug="demo" />
        </ConnectionsProvider>
      </QueryClientProvider>,
    );
    if (waitForRenderTick) {
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 0);
      });
    }
  });
  return view;
}

describe('ProjectPage (#762 query-failure regression)', () => {
  afterEach(() => vi.useRealTimers());
  beforeEach(() => {
    pluginRegistryState.loadStatus = {};
    sdkMocks.project = projectFixture;
    sdkMocks.isLoading = false;
    sdkMocks.isError = false;
    sdkMocks.error = undefined;
    sdkMocks.refetch.mockClear();
    sdkMocks.layouts = [];
    sdkMocks.layoutsLoading = false;
    sdkMocks.layoutsError = false;
    sdkMocks.refetchLayouts.mockClear();
    sdkMocks.panes = [];
    sdkMocks.paneInstances = [];
    sdkMocks.paneAvailability = [];
    sdkMocks.paneCatalogError = false;
    sdkMocks.refetchPanes.mockClear();
    sdkMocks.sessions = [];
    sdkMocks.agents = [];
    sdkMocks.engineConnections = [];
    navigationMocks.navigate.mockClear();
    navigationMocks.setDockState.mockClear();
    navigationMocks.setLayout.mockClear();
  });

  /**
   * archive#3202. The sidebar badge is attached to the PROJECT, so the project
   * page has to be able to discharge it — the page used to surface none of the
   * sessions its own badge counted. "At the top" is the requirement, not a
   * preference: it is the first thing the reader was sent here for.
   */
  test('leads the page with the live sessions the sidebar badge counts', async () => {
    sdkMocks.sessions = [
      {
        threadId: 'waiting',
        provider: 'claude',
        controlMode: 'managed',
        status: 'open',
        projectSlug: 'demo',
        assignedAgentSlug: 'codex',
        displayTitle: 'Reply needed on the migration',
        createdAt: '2026-08-02T19:00:00.000Z',
        updatedAt: '2026-08-02T20:00:00.000Z',
        lifecycleState: 'needs_input',
        pendingReview: true,
        answerability: { answerable: true },
      },
    ];

    const { container } = await renderProjectPage();

    const liveWork = container.querySelector('.project-page__live-work');
    expect(liveWork).toBeTruthy();
    expect(screen.getByText('Needs you · 1')).toBeTruthy();
    expect(screen.getByText('Reply needed on the migration')).toBeTruthy();
    // Above the existing content, not appended below it.
    const open = container.querySelector('.project-page__layouts');
    expect(open).toBeTruthy();
    const position = (liveWork as Element).compareDocumentPosition(
      open as Node,
    );
    expect(position & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  test('shows no live-work section when nothing is in flight', async () => {
    sdkMocks.sessions = [
      {
        threadId: 'finished',
        provider: 'claude',
        controlMode: 'managed',
        status: 'open',
        projectSlug: 'demo',
        assignedAgentSlug: 'codex',
        displayTitle: 'Finished and filed',
        createdAt: '2026-08-02T19:00:00.000Z',
        updatedAt: '2026-08-02T20:00:00.000Z',
        lifecycleState: 'completed',
        answerability: { answerable: true },
      },
    ];

    const { container } = await renderProjectPage();

    expect(container.querySelector('.project-page__live-work')).toBeNull();
  });

  test('renders the loading placeholder while the project query is in flight', async () => {
    sdkMocks.project = undefined;
    sdkMocks.isLoading = true;

    const { container } = await renderProjectPage();

    expect(container.querySelector('.skeleton-block')).toBeTruthy();
    expect(screen.getByLabelText('Loading project')).toBeTruthy();
  });

  test('renders ErrorState with retry instead of an infinite loading placeholder when the project query fails (#762)', async () => {
    sdkMocks.project = undefined;
    sdkMocks.isLoading = false;
    sdkMocks.isError = true;
    sdkMocks.error = new Error('Project not found');

    const { container } = await renderProjectPage();

    expect(screen.getByRole('alert')).toBeTruthy();
    expect(screen.getByText('Could not load project')).toBeTruthy();
    expect(screen.getByText('Project not found')).toBeTruthy();
    expect(container.querySelector('.project-page__loading')).toBeNull();
    expect(screen.queryByText('Loading…')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(sdkMocks.refetch).toHaveBeenCalledTimes(1);
  });

  test('degrades a still-pending project query to ErrorState with retry', async () => {
    vi.useFakeTimers();
    sdkMocks.project = undefined;
    sdkMocks.isLoading = true;
    await renderProjectPage(false);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(DEGRADED_QUERY_TIMEOUT_MS);
    });
    expect(
      screen.getByText('Project is taking longer than expected'),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(sdkMocks.refetch).toHaveBeenCalledTimes(1);
  });

  test('offers both add actions under one Open section', async () => {
    await renderProjectPage();

    expect(
      screen.queryByRole('heading', { name: 'Workspace panes' }),
    ).toBeNull();
    expect(screen.getByText('Open')).toBeTruthy();
    expect(screen.getByRole('button', { name: '+ Add layout' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '+ Add pane' })).toBeTruthy();
    // #765 F4: plain copy — no internal migration narrative in product copy.
    expect(
      screen.getByText('Workspace views open in this project.'),
    ).toBeTruthy();
  });

  // #1536 E8: the page carried a second grid listing every pane the
  // distribution installs — a catalog rendered as this project's state, and a
  // duplicate of the "+ Add pane" picker. The picker is now the only place the
  // catalog is presented, and it lists strictly more than the grid could (the
  // grid filtered the same entries down to placed occurrences).
  test('lists no pane catalog on the page, and reaches every catalog pane through the picker', async () => {
    const placed = codingPaneAdaptation('Files', 'placed');
    sdkMocks.panes = [placed.descriptor];
    sdkMocks.paneInstances = [placed.instance];
    sdkMocks.paneAvailability = [availableFor(placed.descriptor.id)];

    await renderProjectPage();

    // Not on the page: no card, no subsection label, no "Open Files" action.
    expect(screen.queryByText('Workspace panes')).toBeNull();
    expect(screen.queryByText('Files')).toBeNull();
    expect(screen.queryByRole('button', { name: /^Open Files$/ })).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: '+ Add pane' }));

    expect(
      screen.getByRole('heading', { name: 'Add workspace pane' }),
    ).toBeTruthy();
    expect(screen.getByRole('button', { name: /^Open Files$/ })).toBeTruthy();
  });

  // #1536 E4: with no layouts the section must say so once and keep the two
  // actions that fix it, rather than render an empty band.
  test('states the empty case once and keeps both add actions when the project has no layouts', async () => {
    sdkMocks.layouts = [];

    await renderProjectPage();

    expect(screen.getByText('Nothing here yet')).toBeTruthy();
    expect(
      screen.getByText('Add a layout or a pane to open one in this project.'),
    ).toBeTruthy();
    expect(screen.getByRole('button', { name: '+ Add layout' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '+ Add pane' })).toBeTruthy();
    // One affordance per action: the empty card does not repeat the header's.
    expect(screen.queryByRole('button', { name: 'Add layout' })).toBeNull();
  });

  // archive#801 kept this shape: a layouts FAILURE is not emptiness, and it
  // must not take the pane catalog down with it. The catalog now lives in the
  // picker, so that is where the pane has to stay reachable from.
  test('states a layouts failure as a failure and leaves panes reachable through the picker', async () => {
    sdkMocks.layoutsError = true;
    const healthy = codingPaneAdaptation('Healthy pane', 'healthy');
    sdkMocks.panes = [healthy.descriptor];
    sdkMocks.paneAvailability = [availableFor(healthy.descriptor.id)];
    sdkMocks.paneInstances = [healthy.instance];

    await renderProjectPage();

    expect(screen.getByText('Could not load layouts')).toBeTruthy();
    expect(
      screen.queryByRole('button', { name: /^Open Healthy pane$/ }),
    ).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: '+ Add pane' }));

    expect(
      screen.getByRole('button', { name: /^Open Healthy pane$/ }),
    ).toBeTruthy();
  });

  test('opens a layout-bound pane through its Coding host, not another installed layout', async () => {
    sdkMocks.layouts = [
      {
        id: 'tasks',
        slug: 'tasks',
        name: 'Tasks',
        type: 'tasks',
      },
      {
        id: 'coding',
        slug: 'coding',
        name: 'Coding',
        type: 'coding',
      },
    ];
    const pane = codingPaneAdaptation('Terminal', 'coding');
    sdkMocks.panes = [pane.descriptor];
    sdkMocks.paneAvailability = [availableFor(pane.descriptor.id)];
    sdkMocks.paneInstances = [pane.instance];

    await renderProjectPage();
    fireEvent.click(screen.getByRole('button', { name: '+ Add pane' }));
    fireEvent.click(screen.getByRole('button', { name: /^Open Terminal$/ }));

    expect(navigationMocks.setLayout).toHaveBeenCalledWith('demo', 'coding');
    expect(navigationMocks.navigate).toHaveBeenCalledWith(
      `/projects/demo/layouts/coding/panes/${encodeURIComponent(pane.descriptor.id)}/${encodeURIComponent(pane.instance.instanceId)}`,
    );
  });

  test('does not present a positively unavailable pane as healthy', async () => {
    const unavailable = codingPaneAdaptation('Coding', 'unavailable');
    sdkMocks.panes = [unavailable.descriptor];
    sdkMocks.paneAvailability = [
      {
        descriptorId: unavailable.descriptor.id,
        availability: {
          state: 'temporarily-unavailable',
          reason: { code: 'health-unavailable', source: 'health' },
        },
        input: {
          rollout: 'available',
          distribution: 'enabled',
          host: { state: 'supported' },
          deployment: { state: 'supported' },
          renderer: 'present',
          context: { project: 'present' },
          health: 'unavailable',
        },
      },
    ];
    sdkMocks.paneInstances = [unavailable.instance];
    await renderProjectPage();
    fireEvent.click(screen.getByRole('button', { name: '+ Add pane' }));
    expect(screen.getByText('Temporarily unavailable')).toBeTruthy();
    fireEvent.click(
      screen.getByRole('button', {
        name: 'Coding Temporarily unavailable',
      }),
    );
    expect(
      screen.getByText(
        'The pane is temporarily unavailable. Try again shortly.',
      ),
    ).toBeTruthy();
    expect(screen.queryByRole('button', { name: /^Open Coding$/ })).toBeNull();
  });

  // #1536 E8: the removed page grid was the ONLY surface that passed
  // `onReviewInRegistry`. Without it a card whose availability names the
  // Registry silently falls back to a bounded action
  // (`WorkspacePaneAvailabilityList.tsx` `actionPresentation`), so the remedy
  // the copy promises has no affordance. The gate here is derived, not stated:
  // a plugin-hosted descriptor plus a remote-isolation registry load failure is
  // what makes `reviewInRegistry` true.
  test('the picker can reach the Registry for a pane whose remedy is there', async () => {
    pluginRegistryState.loadStatus = { failure: 'remote-isolation' };
    const contributed = paneAdaptationFromLayoutTab(
      {
        id: 'starter',
        label: 'SDK Patterns',
        component: { kind: 'plugin-component', name: 'sdk-patterns' },
      },
      {
        layoutSlug: 'starter',
        instanceScope: 'project:project-demo:source:plugin:starter',
        pluginId: 'getting-started-starter',
        modeContextRequirement: { project: true, source: true },
        boundContext: { projectId: 'project-demo', sourceId: 'plugin:starter' },
      },
    );
    if (!contributed) throw new Error('plugin pane fixture is invalid');
    sdkMocks.panes = [contributed.descriptor];
    sdkMocks.paneInstances = [contributed.instance];
    sdkMocks.paneAvailability = [availableFor(contributed.descriptor.id)];

    await renderProjectPage();
    fireEvent.click(screen.getByRole('button', { name: '+ Add pane' }));

    const review = screen.getByRole('button', { name: 'Review in Registry' });
    fireEvent.click(review);
    expect(navigationMocks.navigate).toHaveBeenCalledWith('/registry');
  });

  test('keeps layout cards visible when the panes catalog fails, and reports the failure in the picker', async () => {
    sdkMocks.layouts = [
      {
        id: 'coding',
        slug: 'coding',
        name: 'Coding',
        type: 'coding',
      },
    ];
    sdkMocks.paneCatalogError = true;

    await renderProjectPage();

    expect(screen.getByRole('button', { name: /Coding/ })).toBeTruthy();
    // A pane-catalog failure is not the project page's failure any more.
    expect(screen.queryByText('Could not load workspace panes')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: '+ Add pane' }));

    expect(screen.getByText('Could not load workspace panes')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(sdkMocks.refetchPanes).toHaveBeenCalledTimes(1);
  });

  /**
   * The banner used to read "Chat with Station … no setup required"
   * unconditionally, and "Start a chat" called `setDockState(true)`, which
   * revealed whatever conversation was last active — on a fresh install, a
   * chat in no project at all, on the one Agent that still needed setup.
   */
  describe('"New here?" chat CTA', () => {
    const readyCodex = () => {
      sdkMocks.agents = [
        {
          slug: 'station',
          name: 'Station',
          available: false,
          unavailableReason: 'No model resolves yet.',
        },
        {
          slug: 'codex',
          name: 'Codex',
          execution: { agentConnectionId: 'codex-connection' },
        },
      ];
      sdkMocks.engineConnections = [
        {
          id: 'codex-connection',
          kind: 'agent',
          enabled: true,
          status: 'ready',
          capabilities: ['agent-runtime'],
        },
      ];
    };

    test('names the Agent that can actually start the chat', async () => {
      readyCodex();

      await renderProjectPage();

      expect(
        screen.getByText('New here? Chat with Codex to get started.'),
      ).toBeTruthy();
      expect(screen.queryByText(/Chat with Station/)).toBeNull();
    });

    test('#1582 C4: it is the shared page callout, with its copy unchanged', async () => {
      // It used to be an inline card with its own border, its own text ramp
      // and a hand-rolled accent button — one of the three visual systems
      // Home and this page used for the same kind of offer.
      readyCodex();

      await renderProjectPage();

      const callout = document.querySelector(
        '[data-callout-id="project-chat-cta"]',
      );
      expect(
        callout,
        'the CTA does not render through PageCallout',
      ).toBeTruthy();
      expect(callout?.className).toContain('page-callout--info');
      expect(callout?.querySelector('.page-callout__title')?.textContent).toBe(
        'New here? Chat with Codex to get started.',
      );
      expect(callout?.querySelector('.page-callout__body')?.textContent).toBe(
        'Ask a question or describe a task — no setup required.',
      );
      expect(
        callout?.querySelector('.page-callout__action .button--primary')
          ?.textContent,
      ).toBe('Start a chat');
    });

    test('withholds the banner, and its no-setup promise, when nothing can start a chat', async () => {
      readyCodex();
      sdkMocks.engineConnections = [
        {
          id: 'codex-connection',
          kind: 'agent',
          enabled: true,
          status: 'connecting',
          capabilities: ['agent-runtime'],
        },
      ];

      await renderProjectPage();

      expect(screen.queryByText(/no setup required/)).toBeNull();
      expect(screen.queryByRole('button', { name: 'Start a chat' })).toBeNull();
    });

    test('asks the dock for a chat bound to this project, not just an open dock', async () => {
      readyCodex();
      const requests: Array<{
        projectSlug?: string;
        projectName?: string;
        source?: string;
      }> = [];
      const listener = (event: Event) => {
        requests.push(
          (event as CustomEvent<{ projectSlug?: string }>).detail as {
            projectSlug?: string;
            projectName?: string;
            source?: string;
          },
        );
      };
      window.addEventListener(OPEN_PROJECT_CHATS_EVENT, listener);
      try {
        await renderProjectPage();
        fireEvent.click(screen.getByRole('button', { name: 'Start a chat' }));
      } finally {
        window.removeEventListener(OPEN_PROJECT_CHATS_EVENT, listener);
      }

      // #1536 M6/D4: the dispatcher names itself, so the source is observable
      // right here rather than asserted as a constant against its own literal
      // (D3). The dock reports what it is told; nothing in it hardcodes a
      // caller that can outlive its only dispatcher.
      expect(requests).toEqual([
        {
          projectSlug: 'demo',
          projectName: 'Demo Project',
          source: 'project-page-cta',
        },
      ]);
      // The dock has to be revealed too: its New Chat dialog renders inside
      // the dock shell, which is collapsed while closed.
      expect(navigationMocks.setDockState).toHaveBeenCalledWith(true);
    });
  });
});
