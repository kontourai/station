/**
 * @vitest-environment jsdom
 */

import {
  ConnectionStore,
  ConnectionsProvider,
} from '@kontourai/station-connect';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, test, vi } from 'vitest';

const sdkMocks = vi.hoisted(() => ({
  available: [] as unknown[],
  projectLayouts: [] as unknown[],
  mutateAsync: vi.fn(),
  removeMutate: vi.fn(),
  removeOptions: null as null | {
    onSuccess?: (value: undefined, slug: string) => void;
    onError?: (error: Error, slug: string) => void;
  },
  queryConfig: null as null | {
    enabled?: boolean;
  },
  refetch: vi.fn(),
  telemetry: { track: vi.fn() },
  StationHttpError: class StationHttpError extends Error {
    readonly status: number;

    constructor(status: number) {
      super(`HTTP ${status}`);
      this.name = 'StationHttpError';
      this.status = status;
    }
  },
}));

// `RegionModelProvider` wraps the whole application, so `useShowSurface`
// requires it. This harness mounts a fragment of that tree, and nothing
// here asserts a surface reveal, so the command hook is supplied directly.
const showSurfaceStub = vi.hoisted(() => vi.fn());
vi.mock('../contexts/useShowSurface', () => ({
  useShowSurface: () => showSurfaceStub,
}));

vi.mock('@kontourai/station-sdk', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@kontourai/station-sdk')>()),
  useApplyProjectLayoutMutation: () => ({
    mutateAsync: sdkMocks.mutateAsync,
  }),
  useAvailableProjectLayoutsQuery: (config: typeof sdkMocks.queryConfig) => {
    sdkMocks.queryConfig = config;
    return {
      data: sdkMocks.available,
      isLoading: false,
      isError: false,
      refetch: sdkMocks.refetch,
    };
  },
  useDeleteProjectLayoutMutation: (
    _slug: string,
    options?: typeof sdkMocks.removeOptions,
  ) => {
    sdkMocks.removeOptions = options ?? null;
    return { mutate: sdkMocks.removeMutate };
  },
  useProjectQuery: () => ({
    data: {
      workingDirectory: '/tmp/demo',
      agents: [],
    },
    isLoading: false,
  }),
  useProjectLayoutsQuery: () => ({ data: sdkMocks.projectLayouts }),
  useKnowledgeDocsQuery: () => ({ data: [] }),
  useKnowledgeNamespacesQuery: () => ({ data: [] }),
  useKnowledgeStatusQuery: () => ({ data: undefined }),
  useProjectConversationsQuery: () => ({ data: [] }),
  useUpdateProjectMutation: () => ({ mutate: vi.fn() }),
  telemetry: sdkMocks.telemetry,
  layoutCatalogErrorReason: (error: unknown) => {
    if (error instanceof sdkMocks.StationHttpError) {
      if ([401, 403].includes(error.status)) return 'authentication';
      if (error.status >= 500) return 'server';
    }
    if (error instanceof TypeError) return 'connection';
    return 'unknown';
  },
  StationHttpError: sdkMocks.StationHttpError,
  // Project Page embeds the pane catalog; its capability query is outside
  // this layout-selection fixture's scope.
  useServerCapabilitiesQuery: () => ({ data: undefined }),
}));

vi.mock('../contexts/ApiBaseContext', () => ({
  useApiBase: () => ({ apiBase: 'http://localhost:3141' }),
}));

vi.mock('../contexts/NavigationContext', () => ({
  useNavigation: () => ({
    setLayout: vi.fn(),
    setConversation: vi.fn(),
    navigate: vi.fn(),
    setDockState: vi.fn(),
  }),
}));

vi.mock('../hooks/useGitStatus', () => ({
  useGitStatus: () => ({ data: undefined }),
  useGitLog: () => ({ data: [] }),
}));

vi.mock('../views/project-page/ProjectPageHeader', () => ({
  ProjectPageHeader: () => <div />,
}));

vi.mock('../views/project-page/ProjectTasksSection', () => ({
  ProjectTasksSection: () => <div />,
}));

vi.mock('../views/project-page/ProjectKnowledgeSection', () => ({
  ProjectKnowledgeSection: () => <div />,
}));

vi.mock('../views/project-page/ProjectConversationsSection', () => ({
  ProjectConversationsSection: () => <div />,
}));

import {
  mergeAvailableProjectLayouts,
  ProjectLayoutCatalog,
} from '../components/registry/ProjectLayoutCatalog';
import {
  ProjectAddLayoutModal,
  ProjectLayoutsSection,
} from '../views/project-page/ProjectLayoutsSection';
import { LayoutsSection } from '../views/project-settings/LayoutsSection';

const eligibleLayout = {
  id: 'builtin:coding',
  source: 'builtin' as const,
  name: 'Coding',
  slug: 'coding',
  icon: '🔧',
  description: 'Files, changes, terminal, and chat',
  type: 'coding',
  sourceIdentity: { id: 'builtin', kind: 'builtin' as const },
  contribution: {
    id: 'builtin:coding',
    version: '1.0.0',
    sourceIdentity: { id: 'builtin', kind: 'builtin' as const },
    provenance: { origin: 'builtin' as const },
  },
  lifecycle: {
    itemId: 'builtin:coding',
    state: 'installed' as const,
    source: 'builtin',
  },
  visible: true,
  installable: false,
  enabled: true,
  policy: {},
};

beforeEach(() => {
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: vi.fn().mockReturnValue({
      matches: false,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    }),
  });
  sdkMocks.available = [eligibleLayout];
  sdkMocks.projectLayouts = [];
  sdkMocks.mutateAsync.mockReset();
  sdkMocks.mutateAsync.mockResolvedValue(undefined);
  sdkMocks.queryConfig = null;
  sdkMocks.removeMutate.mockReset();
  sdkMocks.removeOptions = null;
  sdkMocks.refetch.mockClear();
  sdkMocks.telemetry.track.mockClear();
  localStorage.clear();
});

/**
 * ProjectPage resolves the real pane catalog. Seed that catalog and Config
 * query in the same fresh client that supplies its React Query boundary, so
 * this focused MRU fixture stays deterministic without mocking that hook.
 */
async function renderProjectPageWithConnections(children: ReactNode) {
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
        gcTime: 0,
        retry: false,
        refetchOnMount: false,
        refetchOnReconnect: false,
        refetchOnWindowFocus: false,
      },
    },
  });
  queryClient.setQueryData(['config'], {});
  queryClient.setQueryData(['projects', 'demo', 'panes'], {
    projectId: 'demo',
    descriptors: [],
    instances: [],
    availability: [],
  });

  await act(async () => {
    render(
      <QueryClientProvider client={queryClient}>
        <ConnectionsProvider store={store}>{children}</ConnectionsProvider>
      </QueryClientProvider>,
    );
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 0);
    });
  });
}

describe('ProjectAddLayoutModal', () => {
  test('does not invent starters while the authoritative catalog loads', () => {
    render(
      <ProjectAddLayoutModal
        show
        available={[]}
        adding={null}
        loading
        catalogError={false}
        onClose={vi.fn()}
        onRetry={vi.fn()}
        onAddLayout={vi.fn()}
      />,
    );

    expect(screen.getByRole('dialog', { name: 'Add Layout' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Coding/ })).toBeNull();
    expect(
      screen.getByRole('status', { name: 'Loading more layouts' }),
    ).toBeTruthy();
  });

  test('retries a catalog failure without claiming an unavailable starter', () => {
    const onRetry = vi.fn();
    const onAddLayout = vi.fn();
    render(
      <ProjectAddLayoutModal
        show
        available={[]}
        adding={null}
        loading={false}
        catalogError
        onClose={vi.fn()}
        onRetry={onRetry}
        onAddLayout={onAddLayout}
      />,
    );

    expect(screen.getByRole('alert')).toBeTruthy();
    expect(screen.getByText("Couldn't load layouts")).toBeTruthy();
    expect(
      screen.getByText(
        'Layouts are unavailable right now. Check your connection, then retry.',
      ),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Retry now' }));
    expect(onRetry).toHaveBeenCalledOnce();
    expect(sdkMocks.telemetry.track).toHaveBeenLastCalledWith(
      'ui.layout_catalog.state',
      { outcome: 'manual_retry', reason: 'unknown', cached: 0 },
    );
    expect(onAddLayout).not.toHaveBeenCalled();
  });

  test('keeps installed built-ins selectable while a refresh is failing', () => {
    const onAddLayout = vi.fn();
    render(
      <ProjectAddLayoutModal
        show
        available={[eligibleLayout]}
        adding={null}
        loading={false}
        catalogError
        onClose={vi.fn()}
        onRetry={vi.fn()}
        onAddLayout={onAddLayout}
      />,
    );

    expect(screen.getByRole('alert')).toBeTruthy();
    expect(screen.getByText("Some layouts couldn't be refreshed")).toBeTruthy();
    expect(
      screen.getByText(
        'Showing installed layouts. Retry when your connection is available.',
      ),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /Coding/ }));
    expect(onAddLayout).toHaveBeenCalledWith(eligibleLayout);
  });

  test('uses the canonical empty state when a successful catalog has no eligible layouts', () => {
    render(
      <ProjectAddLayoutModal
        show
        available={[]}
        adding={null}
        loading={false}
        catalogError={false}
        onClose={vi.fn()}
        onRetry={vi.fn()}
        onAddLayout={vi.fn()}
      />,
    );

    expect(screen.getByText('Install a layout to continue')).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(
      screen.queryByRole('status', { name: 'Loading more layouts' }),
    ).toBeNull();
  });

  test('deduplicates the built-in starter and retains plugin layouts', () => {
    expect(
      mergeAvailableProjectLayouts([
        {
          id: 'builtin:coding',
          source: 'builtin',
          name: 'Coding',
          slug: 'coding',
          type: 'coding',
          sourceIdentity: { id: 'builtin', kind: 'builtin' },
          contribution: {
            id: 'builtin:coding',
            version: '1.0.0',
            sourceIdentity: { id: 'builtin', kind: 'builtin' },
            provenance: { origin: 'builtin' },
          },
          lifecycle: {
            itemId: 'builtin:coding',
            state: 'installed',
            source: 'builtin',
          },
          visible: true,
          installable: false,
          enabled: true,
          policy: {},
        },
        {
          id: 'plugin:notes:notes',
          source: 'plugin',
          plugin: 'notes',
          name: 'Notes',
          slug: 'notes',
          type: 'chat',
          sourceIdentity: { id: 'notes', kind: 'local' },
          contribution: {
            id: 'plugin:notes:notes',
            version: '1.0.0',
            sourceIdentity: { id: 'notes', kind: 'local' },
            provenance: { origin: 'plugin', pluginId: 'notes' },
          },
          lifecycle: {
            itemId: 'plugin:notes:notes',
            state: 'installed',
            source: 'notes',
          },
          visible: true,
          installable: false,
          enabled: true,
          policy: {},
        },
      ]).map((item) => item.slug),
    ).toEqual(['coding', 'notes']);
  });

  test('renders canonical metadata and selection state for eligible catalog items', () => {
    const onSelect = vi.fn();
    const organizationLayout = {
      ...eligibleLayout,
      id: 'plugin:acme-layouts:review',
      source: 'plugin' as const,
      plugin: 'acme-layouts',
      name: 'Review board',
      slug: 'review',
      description: 'Track an organization review flow',
      type: 'review',
      sourceIdentity: {
        id: 'acme-layouts',
        kind: 'remote' as const,
        source: 'https://registry.example.test/acme',
      },
      contribution: {
        id: 'plugin:acme-layouts:review',
        version: '1.0.0',
        sourceIdentity: {
          id: 'acme-layouts',
          kind: 'remote' as const,
          source: 'https://registry.example.test/acme',
        },
        provenance: { origin: 'plugin' as const, pluginId: 'acme-layouts' },
      },
      lifecycle: {
        itemId: 'plugin:acme-layouts:review',
        state: 'installed' as const,
        source: 'acme-layouts',
      },
      tabCount: 3,
    };

    render(
      <ProjectLayoutCatalog
        available={[eligibleLayout, organizationLayout]}
        adding={null}
        loading={false}
        catalogError={false}
        onRetry={vi.fn()}
        onSelect={onSelect}
        selectedId={organizationLayout.id}
      />,
    );

    const review = screen.getByRole('button', { name: /Review board/ });
    expect(review.getAttribute('aria-pressed')).toBe('true');
    expect(review.className).toContain(
      'project-layout-catalog__item--selected',
    );
    expect(review.textContent).toContain('Plugin: acme-layouts');
    expect(review.textContent).toContain('review');
    expect(review.textContent).toContain('3 tabs');
    expect(
      screen
        .getByRole('button', { name: /Coding/ })
        .getAttribute('aria-pressed'),
    ).toBe('false');

    fireEvent.click(review);
    expect(onSelect).toHaveBeenCalledWith(organizationLayout);
  });

  test('marks already-applied layouts without merging built-ins and plugin layouts that share a slug', () => {
    const pluginCoding = {
      ...eligibleLayout,
      id: 'plugin:coding-starter:coding',
      source: 'plugin' as const,
      plugin: 'coding-starter',
      name: 'Coding Starter',
      slug: 'coding',
      icon: '💻',
      type: 'chat',
      sourceIdentity: {
        id: 'coding-starter',
        kind: 'local' as const,
        source: 'plugins/coding-starter',
      },
      contribution: {
        id: 'plugin:coding-starter:coding',
        version: '1.0.0',
        sourceIdentity: {
          id: 'coding-starter',
          kind: 'local' as const,
          source: 'plugins/coding-starter',
        },
        provenance: { origin: 'plugin' as const, pluginId: 'coding-starter' },
      },
      lifecycle: {
        itemId: 'plugin:coding-starter:coding',
        state: 'installed' as const,
        source: 'coding-starter',
      },
      tabCount: 2,
    };

    render(
      <ProjectLayoutCatalog
        available={[eligibleLayout, pluginCoding]}
        appliedLayouts={[
          {
            id: 'layout-1',
            slug: 'coding',
            projectSlug: 'default',
            name: 'Coding Starter',
            type: 'chat',
            plugin: 'coding-starter',
            tabCount: 2,
          },
        ]}
        adding={null}
        loading={false}
        catalogError={false}
        onRetry={vi.fn()}
        onSelect={vi.fn()}
      />,
    );

    const codingButtons = screen.getAllByRole('button', { name: /Coding/ });
    expect(codingButtons[0].textContent).toContain('Built in');
    expect(codingButtons[0].textContent).not.toContain('Added');
    const starter = screen.getByRole('button', {
      name: /Coding Starter/,
    });
    expect(starter.textContent).toContain('Plugin: coding-starter');
    expect(starter.textContent).toContain('2 tabs');
    expect(starter.textContent).toContain('Added');
  });

  test('filters unavailable items and preserves immediate-add pending semantics', () => {
    const onSelect = vi.fn();
    render(
      <ProjectLayoutCatalog
        available={[
          eligibleLayout,
          {
            ...eligibleLayout,
            id: 'builtin:hidden',
            slug: 'hidden',
            contribution: {
              ...eligibleLayout.contribution,
              id: 'builtin:hidden',
            },
            visible: false,
          },
          {
            ...eligibleLayout,
            id: 'builtin:disabled',
            slug: 'disabled',
            contribution: {
              ...eligibleLayout.contribution,
              id: 'builtin:disabled',
            },
            enabled: false,
          },
          {
            ...eligibleLayout,
            id: 'builtin:installable',
            slug: 'installable',
            contribution: {
              ...eligibleLayout.contribution,
              id: 'builtin:installable',
            },
            lifecycle: {
              itemId: 'builtin:installable',
              state: 'installable' as const,
              source: 'builtin',
            },
          },
        ]}
        adding="coding"
        loading={false}
        catalogError={false}
        onRetry={vi.fn()}
        onSelect={onSelect}
      />,
    );

    const coding = screen.getByRole('button', { name: /Coding/ });
    expect((coding as HTMLButtonElement).disabled).toBe(true);
    expect(coding.getAttribute('aria-busy')).toBe('true');
    expect(coding.getAttribute('aria-pressed')).toBeNull();
    expect(
      screen.queryByRole('button', { name: /hidden|disabled|installable/i }),
    ).toBeNull();
    fireEvent.click(coding);
    expect(onSelect).not.toHaveBeenCalled();
  });

  test('marks an already applied plugin layout without hiding duplicate-add behavior', () => {
    const onSelect = vi.fn();
    const pluginLayout = {
      ...eligibleLayout,
      id: 'plugin:coding-starter:coding',
      source: 'plugin' as const,
      plugin: 'coding-starter',
      sourceIdentity: {
        id: 'coding-starter',
        kind: 'local' as const,
        source: 'plugins/coding-starter',
      },
      contribution: {
        id: 'plugin:coding-starter:coding',
        version: '1.0.0',
        sourceIdentity: {
          id: 'coding-starter',
          kind: 'local' as const,
          source: 'plugins/coding-starter',
        },
        provenance: { origin: 'plugin' as const, pluginId: 'coding-starter' },
      },
    };
    render(
      <ProjectLayoutCatalog
        available={[pluginLayout]}
        appliedLayouts={[
          {
            id: 'layout-1',
            projectSlug: 'demo',
            slug: 'coding',
            name: 'Coding',
            type: 'chat',
            plugin: 'coding-starter',
          },
        ]}
        adding={null}
        loading={false}
        catalogError={false}
        onRetry={vi.fn()}
        onSelect={onSelect}
      />,
    );

    const coding = screen.getByRole('button', { name: /Coding/ });
    expect(coding.textContent).toContain('Added');
    expect((coding as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(coding);
    expect(onSelect).toHaveBeenCalledWith(pluginLayout);
  });

  test('routes authentication failures to the existing Review Stations action', () => {
    const openConnections = vi.fn();
    window.addEventListener('station:open-connections-modal', openConnections);
    render(
      <ProjectLayoutCatalog
        available={[]}
        adding={null}
        loading={false}
        catalogError={new sdkMocks.StationHttpError(401)}
        onRetry={vi.fn()}
        onSelect={vi.fn()}
      />,
    );

    expect(screen.getByText('Station needs review')).toBeTruthy();
    expect(
      screen.getByText(
        'Your saved Station needs review before layouts can load.',
      ),
    ).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Retry now' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Review Stations' }));
    expect(openConnections).toHaveBeenCalledOnce();
    window.removeEventListener(
      'station:open-connections-modal',
      openConnections,
    );
  });
});

describe('catalog application MRU tracking', () => {
  test('tracks the canonical catalog ID only after Project Page application succeeds', async () => {
    const { ProjectPage } = await import('../views/ProjectPage');
    await renderProjectPageWithConnections(<ProjectPage slug="demo" />);

    fireEvent.click(screen.getByRole('button', { name: '+ Add layout' }));
    expect(sdkMocks.queryConfig).toEqual({ enabled: true });
    fireEvent.click(screen.getByRole('button', { name: /Coding/ }));

    await waitFor(() => {
      expect(sdkMocks.mutateAsync).toHaveBeenCalledWith('builtin:coding');
      expect(JSON.parse(localStorage.getItem('recentLayouts') ?? '[]')).toEqual(
        ['builtin:coding'],
      );
      expect(screen.queryByRole('dialog', { name: 'Add Layout' })).toBeNull();
    });
  });

  test('does not track or close the Project Page picker when application fails', async () => {
    const { ProjectPage } = await import('../views/ProjectPage');
    sdkMocks.mutateAsync.mockRejectedValueOnce(new Error('apply failed'));
    await renderProjectPageWithConnections(<ProjectPage slug="demo" />);

    fireEvent.click(screen.getByRole('button', { name: '+ Add layout' }));
    fireEvent.click(screen.getByRole('button', { name: /Coding/ }));

    await waitFor(() => {
      expect(sdkMocks.mutateAsync).toHaveBeenCalledWith('builtin:coding');
      expect(localStorage.getItem('recentLayouts')).toBeNull();
      expect(screen.getByRole('dialog', { name: 'Add Layout' })).toBeTruthy();
      expect(
        screen
          .getByRole('button', { name: /Coding/ })
          .getAttribute('aria-busy'),
      ).not.toBe('true');
    });
  });
  test('tracks the canonical catalog ID only after Settings application succeeds', async () => {
    render(<LayoutsSection slug="demo" />);

    fireEvent.click(screen.getByRole('button', { name: '+ Add Layout' }));
    expect(sdkMocks.queryConfig).toEqual({ enabled: true });
    fireEvent.click(screen.getByRole('button', { name: /Coding/ }));

    await waitFor(() => {
      expect(sdkMocks.mutateAsync).toHaveBeenCalledWith('builtin:coding');
      expect(JSON.parse(localStorage.getItem('recentLayouts') ?? '[]')).toEqual(
        ['builtin:coding'],
      );
      expect(screen.queryByRole('dialog', { name: 'Add Layout' })).toBeNull();
    });
  });

  test('does not track or close the Settings picker when application fails', async () => {
    sdkMocks.mutateAsync.mockRejectedValueOnce(new Error('apply failed'));
    render(<LayoutsSection slug="demo" />);

    fireEvent.click(screen.getByRole('button', { name: '+ Add Layout' }));
    fireEvent.click(screen.getByRole('button', { name: /Coding/ }));

    await waitFor(() => {
      expect(sdkMocks.mutateAsync).toHaveBeenCalledWith('builtin:coding');
      expect(localStorage.getItem('recentLayouts')).toBeNull();
      expect(screen.getByRole('dialog', { name: 'Add Layout' })).toBeTruthy();
      expect(
        screen
          .getByRole('button', { name: /Coding/ })
          .getAttribute('aria-busy'),
      ).not.toBe('true');
    });
  });
});

// archive#801: the project page renders as soon as the *project* query settles, so a
// layouts fetch still in flight reached this section as an empty array and
// stated "No layouts yet" for a project that has layouts.
describe('ProjectLayoutsSection loading window (#801)', () => {
  test('does not claim emptiness while the layouts query is in flight', () => {
    render(
      <ProjectLayoutsSection
        slug="alpha"
        layouts={[]}
        loading
        setLayout={vi.fn()}
        onOpenAddLayout={vi.fn()}
      />,
    );

    expect(screen.queryByText('No layouts yet')).toBeNull();
  });

  test('states emptiness once the query has settled with no layouts', () => {
    render(
      <ProjectLayoutsSection
        slug="alpha"
        layouts={[]}
        loading={false}
        setLayout={vi.fn()}
        onOpenAddLayout={vi.fn()}
      />,
    );

    expect(screen.getByText('No layouts yet')).toBeTruthy();
  });

  test('renders resolved layouts rather than a skeleton on a background refetch', () => {
    render(
      <ProjectLayoutsSection
        slug="alpha"
        layouts={[
          {
            id: 'alpha:coding',
            projectSlug: 'alpha',
            slug: 'coding',
            name: 'Coding',
            type: 'builtin',
          },
        ]}
        loading
        setLayout={vi.fn()}
        onOpenAddLayout={vi.fn()}
      />,
    );

    expect(screen.getByText('Coding')).toBeTruthy();
  });

  // react-query clears `isLoading` once a query settles into error, so without
  // an explicit error branch a failed fetch reads as "No layouts yet" — the
  // same confident-emptiness defect, reached from the error path (archive#801).
  test('states a failure as a failure rather than as emptiness', () => {
    const onRetry = vi.fn();
    render(
      <ProjectLayoutsSection
        slug="alpha"
        layouts={[]}
        loading={false}
        error
        onRetry={onRetry}
        setLayout={vi.fn()}
        onOpenAddLayout={vi.fn()}
      />,
    );

    expect(screen.queryByText('No layouts yet')).toBeNull();
    expect(screen.getByText('Could not load layouts')).toBeTruthy();

    fireEvent.click(screen.getByText('Retry'));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  test('prefers already-resolved layouts over an error from a background refetch', () => {
    render(
      <ProjectLayoutsSection
        slug="alpha"
        layouts={[
          {
            id: 'alpha:coding',
            projectSlug: 'alpha',
            slug: 'coding',
            name: 'Coding',
            type: 'builtin',
          },
        ]}
        loading={false}
        error
        setLayout={vi.fn()}
        onOpenAddLayout={vi.fn()}
      />,
    );

    expect(screen.getByText('Coding')).toBeTruthy();
    expect(screen.queryByText('Could not load layouts')).toBeNull();
  });
});

/**
 * 4-HOME-014. Applying a layout failed into an empty `catch` in BOTH hosts of
 * this picker, and removal fired from a bare `×` with no confirmation and no
 * error path — on the same page whose Delete Project has a confirm modal.
 */
describe('layout apply and removal failures (4-HOME-014)', () => {
  const installedLayout = {
    id: 'layout-1',
    slug: 'coding',
    name: 'Coding',
    type: 'coding',
    projectSlug: 'demo',
  };

  test('the Settings picker states why an apply was refused', async () => {
    sdkMocks.mutateAsync.mockRejectedValueOnce(
      new Error('Layout storage is unavailable'),
    );
    render(<LayoutsSection slug="demo" />);

    fireEvent.click(screen.getByRole('button', { name: '+ Add Layout' }));
    fireEvent.click(screen.getByRole('button', { name: /Coding/ }));

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain("Couldn't add that layout");
    expect(alert.textContent).toContain('Layout storage is unavailable');
    expect(screen.getByRole('dialog', { name: 'Add Layout' })).toBeTruthy();
  });

  test('the Project Page picker states why an apply was refused', async () => {
    const { ProjectPage } = await import('../views/ProjectPage');
    sdkMocks.mutateAsync.mockRejectedValueOnce(new Error('apply failed'));
    await renderProjectPageWithConnections(<ProjectPage slug="demo" />);

    fireEvent.click(screen.getByRole('button', { name: '+ Add layout' }));
    fireEvent.click(screen.getByRole('button', { name: /Coding/ }));

    await waitFor(() =>
      expect(
        screen
          .getAllByRole('alert')
          .some((node) => node.textContent?.includes('apply failed')),
      ).toBe(true),
    );
  });

  test('removing a layout confirms first and does nothing when cancelled', async () => {
    sdkMocks.projectLayouts = [installedLayout];
    render(<LayoutsSection slug="demo" />);

    fireEvent.click(screen.getByRole('button', { name: 'Remove Coding' }));
    const dialog = await screen.findByRole('alertdialog', {
      name: 'Remove layout',
    });
    expect(dialog.textContent).toContain('Coding');
    expect(sdkMocks.removeMutate).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(sdkMocks.removeMutate).not.toHaveBeenCalled();
  });

  test('removal runs only after the confirmation is accepted', async () => {
    sdkMocks.projectLayouts = [installedLayout];
    render(<LayoutsSection slug="demo" />);

    fireEvent.click(screen.getByRole('button', { name: 'Remove Coding' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Remove' }));

    expect(sdkMocks.removeMutate).toHaveBeenCalledWith('coding');
  });

  test('a refused removal says so instead of leaving the row unexplained', async () => {
    sdkMocks.projectLayouts = [installedLayout];
    render(<LayoutsSection slug="demo" />);

    fireEvent.click(screen.getByRole('button', { name: 'Remove Coding' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Remove' }));
    expect(sdkMocks.removeOptions?.onError).toBeTypeOf('function');

    act(() => {
      sdkMocks.removeOptions?.onError?.(
        new Error('Project storage is unavailable'),
        'coding',
      );
    });

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain("Couldn't remove that layout");
    expect(alert.textContent).toContain('Project storage is unavailable');
  });
});
