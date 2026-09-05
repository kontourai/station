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
    navigationMocks.navigate.mockClear();
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
});
