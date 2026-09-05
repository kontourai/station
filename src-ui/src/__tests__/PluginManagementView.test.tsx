/**
 * @vitest-environment jsdom
 *
 * the failing query's `error`/`refetch` now flow from
 * `usePluginManagementViewModel` into `PluginManagementView` as
 * `error`/`onRetry` props on `SplitPaneLayout` (the shell itself already
 * renders `ErrorState` for a truthy `error` — see `SplitPaneLayout.test.tsx`).
 * The gap this test closes is the WIRING between the view and the shell: a
 * view that forgot to pass `pluginsError` through would pass every
 * `usePluginManagementViewModel` unit test and still show "No plugins
 * installed yet" on a failed read. The view model itself is mocked wholesale
 * here (its own error derivation is pinned in
 * `plugin-management-view-model.test.tsx`), and the real `SplitPaneLayout`
 * renders — this is the join, not either half again.
 */

import { fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, test, vi } from 'vitest';

const refetchPlugins = vi.fn();
const reloadRejectedPlugin = vi.fn();

vi.mock('../contexts/NavigationContext', () => ({
  useNavigation: () => ({ navigate: vi.fn() }),
}));

// Unrelated to the wiring under test and it reaches for a live connection
// context; its own behaviour is pinned in
// `plugin-management/__tests__/WorkspaceHomeRoleSection.test.tsx`.
vi.mock('../views/plugin-management/WorkspaceHomeRoleSection', () => ({
  WorkspaceHomeRoleSection: () => null,
}));

vi.mock('../hooks/useIsMobile', () => ({
  useIsMobile: () => false,
  MOBILE_MEDIA_QUERY: '(max-width: 768px)',
}));

Object.defineProperty(window, 'matchMedia', {
  writable: true,
  value: vi.fn().mockImplementation(() => ({
    matches: false,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  })),
});

function baseViewModel(overrides: Record<string, unknown> = {}) {
  return {
    addLayoutToProjects: vi.fn(),
    addPluginLayout: vi.fn(),
    apiBase: 'http://station.test',
    assigningLayout: null,
    changelogData: null,
    changelogExpanded: false,
    createProjectForLayout: vi.fn(),
    deselectPlugin: vi.fn(),
    expandedProviders: new Set(),
    filtered: [],
    install: vi.fn(),
    installMessage: null,
    installMutation: { isPending: false },
    installSource: '',
    isLoading: false,
    pluginsError: undefined as unknown,
    refetchPlugins,
    reloadRejectedPending: false,
    reloadRejectedPlugin,
    items: [],
    layoutAssignment: null,
    loadingProviderDetails: false,
    message: null,
    plugins: [],
    previewData: null,
    previewMutation: { isPending: false },
    previewSkips: new Set(),
    projects: [],
    providerDetails: null,
    queryClient: { invalidateQueries: vi.fn() },
    quickProjectName: '',
    remove: vi.fn(),
    removeConfirm: null,
    requestConsent: vi.fn(),
    requestRevokePermission: vi.fn(),
    revokeConfirm: null as null | {
      pluginName: string;
      permission: string;
      label: string;
    },
    revokePermission: vi.fn(),
    revokingPermissions: new Set<string>(),
    savePluginSetting: vi.fn(),
    search: '',
    selected: null,
    selectedPlugin: null,
    selectedProjects: new Set(),
    selectPlugin: vi.fn(),
    setChangelogExpanded: vi.fn(),
    setInstallMessage: vi.fn(),
    setInstallSourceAndReset: vi.fn(),
    setLayoutAssignment: vi.fn(),
    setPreviewData: vi.fn(),
    setRemoveConfirm: vi.fn(),
    setRevokeConfirm: vi.fn(),
    setSearch: vi.fn(),
    setShowFolderPicker: vi.fn(),
    setShowInstallModal: vi.fn(),
    showFolderPicker: false,
    showInstallModal: false,
    settingsData: null,
    toggleExpandedProviders: vi.fn(),
    togglePreviewSkip: vi.fn(),
    toggleProjectSelection: vi.fn(),
    toggleProvider: vi.fn(),
    updateMutation: { isPending: false, variables: undefined },
    updatePlugin: vi.fn(),
    updates: [],
    ...overrides,
  };
}

let viewModel = baseViewModel();

vi.mock('../views/plugin-management/usePluginManagementViewModel', () => ({
  usePluginManagementViewModel: () => viewModel,
}));

import { PluginManagementView } from '../views/PluginManagementView';

describe('PluginManagementView error wiring (Review H1)', () => {
  beforeEach(() => {
    refetchPlugins.mockReset();
    viewModel = baseViewModel();
  });

  test('an errored pluginsError renders the shell error state, not "No plugins installed yet"', () => {
    viewModel = baseViewModel({
      pluginsError: new Error('plugins read failed'),
    });
    render(<PluginManagementView onNavigate={vi.fn()} />);

    expect(screen.getByRole('alert')).toBeTruthy();
    expect(screen.getByText('Unable to load plugins')).toBeTruthy();
    expect(screen.getByText('plugins read failed')).toBeTruthy();
    expect(screen.queryByText('No plugins installed yet')).toBeNull();
  });

  test('a settled-empty read (no error) still renders "No plugins installed yet", with no error state', () => {
    render(<PluginManagementView onNavigate={vi.fn()} />);

    expect(screen.getByText('No plugins installed yet')).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  test('trusted revocation explains completed versus winding-down retirement', () => {
    viewModel = baseViewModel({
      revokeConfirm: {
        pluginName: 'provider-plugin',
        permission: 'providers.register',
        label: 'Register system providers',
      },
    });
    render(<PluginManagementView onNavigate={vi.fn()} />);

    expect(
      screen.getByText(
        /drain running module work and retire registered providers/,
      ),
    ).toBeTruthy();
    expect(screen.getByText(/still winding down/)).toBeTruthy();
    expect(screen.queryByText(/continues until the plugin reloads/)).toBeNull();
  });

  test('renders and invokes runtime-cleanup continuation actions', () => {
    const invoke = vi.fn();
    viewModel = baseViewModel({
      message: {
        type: 'success',
        text: 'Runtime cleanup is incomplete.',
        action: { label: 'Retry cleanup', invoke },
      },
    });
    render(<PluginManagementView onNavigate={vi.fn()} />);

    fireEvent.click(screen.getByRole('button', { name: 'Retry cleanup' }));
    expect(invoke).toHaveBeenCalledOnce();
  });
});

describe('the double-empty rule (station#4463 slice 2)', () => {
  beforeEach(() => {
    refetchPlugins.mockReset();
    viewModel = baseViewModel();
  });

  // SHELL-09's own fix for this was itself inverted: `PluginEmptyState` was
  // passed unconditionally as `SplitPaneLayout`'s `emptyContent`, which
  // bypasses the shell's own double-empty guard, and its "Nothing selected"
  // rendered anyway when the list was genuinely empty — beside the list
  // pane's own "No plugins installed yet".
  test('no plugins installed renders one empty message, not "Nothing selected" too', () => {
    render(<PluginManagementView onNavigate={vi.fn()} />);

    expect(screen.getByText('No plugins installed yet')).toBeTruthy();
    expect(screen.queryByText('Nothing selected')).toBeNull();
  });

  test('with plugins installed and none selected, the detail pane says "Nothing selected"', () => {
    viewModel = baseViewModel({
      items: [{ id: 'a', name: 'Alpha' }],
      filtered: [{ name: 'alpha' }],
    });
    render(<PluginManagementView onNavigate={vi.fn()} />);

    expect(screen.queryByText('No plugins installed yet')).toBeNull();
    expect(screen.getByText('Nothing selected')).toBeTruthy();
  });

  // `PluginManagementView` never passed `searchValue`, so
  // `SplitPaneLayout`'s FilteredEmpty branch was production-unreachable — a
  // search matching no installed plugin fell through to the list's
  // genuinely-empty title, "No plugins installed yet", which is false when
  // plugins ARE installed and merely filtered off-screen.
  test('plugins installed + a non-matching search renders exactly the FilteredEmpty message', () => {
    viewModel = baseViewModel({
      plugins: [{ name: 'alpha' }],
      items: [],
      filtered: [],
      search: 'zzz-does-not-match',
    });
    render(<PluginManagementView onNavigate={vi.fn()} />);

    expect(screen.queryByText('No plugins installed yet')).toBeNull();
    expect(
      screen.getByText('Nothing in plugins matches “zzz-does-not-match”'),
    ).toBeTruthy();
    expect(screen.queryByText('Nothing selected')).toBeNull();
  });
});

describe('rejected installed plugins', () => {
  test('renders the exact reason and recovery action without valid-plugin controls', () => {
    const rejected = {
      status: 'rejected' as const,
      name: 'Legacy_Plugin',
      displayName: 'Legacy_Plugin',
      rejection: {
        code: 'invalid-plugin-name' as const,
        reason:
          "Plugin manifest name 'Legacy_Plugin' is not a canonical plugin id",
        recovery: {
          kind: 'repair-manifest' as const,
          instruction:
            'Use a lowercase plugin name, then choose Reload plugins.',
        },
      },
    };
    viewModel = baseViewModel({
      plugins: [rejected],
      filtered: [rejected],
      items: [
        {
          id: 'rejected:Legacy_Plugin',
          name: 'Legacy_Plugin',
          subtitle: `Rejected · ${rejected.rejection.reason}`,
        },
      ],
      selectedPlugin: 'rejected:Legacy_Plugin',
      selected: rejected,
    });

    render(<PluginManagementView onNavigate={vi.fn()} />);

    expect(screen.getByText('Rejected', { exact: true })).toBeTruthy();
    expect(screen.getByRole('alert').textContent).toContain(
      'not a canonical plugin id',
    );
    expect(
      screen.getByText(rejected.rejection.recovery.instruction),
    ).toBeTruthy();
    const detail = screen
      .getByText(
        'Installed files are present, but Station rejected plugin.json.',
      )
      .closest<HTMLElement>('.detail-panel');
    expect(detail).toBeTruthy();
    expect(
      within(detail!).queryByRole('button', { name: 'Remove' }),
    ).toBeNull();
    expect(
      within(detail!).queryByRole('button', { name: /Update/ }),
    ).toBeNull();
    screen.getByRole('button', { name: 'Reload plugins' }).click();
    expect(reloadRejectedPlugin).toHaveBeenCalledOnce();
  });

  test('renders a failed recovery message on the rejected detail', () => {
    const rejected = {
      status: 'rejected' as const,
      name: 'broken-plugin',
      displayName: 'broken-plugin',
      rejection: {
        code: 'malformed-json' as const,
        reason: 'plugin.json contains malformed JSON.',
        recovery: {
          kind: 'repair-manifest' as const,
          instruction: 'Repair plugin.json, then choose Reload plugins.',
        },
      },
    };
    viewModel = baseViewModel({
      plugins: [rejected],
      filtered: [rejected],
      items: [],
      selectedPlugin: 'rejected:broken-plugin',
      selected: rejected,
      message: {
        type: 'error',
        text: 'Plugins were not reloaded: registry is still unavailable',
      },
    });

    render(<PluginManagementView onNavigate={vi.fn()} />);

    expect(
      screen.getByText(
        'Plugins were not reloaded: registry is still unavailable',
      ),
    ).toBeTruthy();
  });
});

/**
 * #1536 G2. The detail page's capability chips said `ui` and
 * `layout:getting-started` and offered a permissions table and Remove — after
 * installing a starter there was no way to see what had arrived or to place
 * it. This is the JOIN: the view has to hand the panel the sole-project
 * decision and the action, and a view that computed the label from nothing
 * would still render a plausible button.
 */
describe('what an installed plugin adds (#1536 G2)', () => {
  const starter = {
    name: 'getting-started-starter',
    displayName: 'Getting Started Starter',
    version: '1.0.0',
    hasBundle: true,
    layout: { slug: 'getting-started' },
    workspacePanes: [{ id: 'notes', name: 'Notes' }],
    agents: [{ slug: 'guide' }],
  };

  function renderWithProjects(
    projects: Array<{ slug: string; name: string }>,
    overrides: Record<string, unknown> = {},
  ) {
    const addPluginLayout = vi.fn();
    viewModel = baseViewModel({
      plugins: [starter],
      filtered: [starter],
      items: [{ id: starter.name, name: starter.displayName, subtitle: '' }],
      selectedPlugin: starter.name,
      selected: starter,
      projects,
      addPluginLayout,
      ...overrides,
    });
    render(<PluginManagementView onNavigate={vi.fn()} />);
    return addPluginLayout;
  }

  test('names each contribution, and only the layout can be placed', () => {
    renderWithProjects([{ slug: 'demo', name: 'Demo' }]);

    const section = screen
      .getByText('What it adds')
      .closest<HTMLElement>('.detail-panel__section');
    expect(section).toBeTruthy();
    const rows = within(section!).getAllByRole('listitem');
    // Review M4: each entry is NAMED. The layout used to render its raw slug
    // under a section promising things rather than slugs.
    expect(rows.map((row) => row.textContent)).toEqual([
      'LayoutGetting StartedAdd to Demo',
      'PaneNotes',
      'AgentGuide',
    ]);
  });

  test('with exactly one project the destination is named, not asked for', () => {
    const addPluginLayout = renderWithProjects([
      { slug: 'demo', name: 'Demo' },
    ]);

    fireEvent.click(screen.getByRole('button', { name: 'Add to Demo' }));
    expect(addPluginLayout).toHaveBeenCalledWith(starter);
  });

  test('with several projects the action asks which one', () => {
    const addPluginLayout = renderWithProjects([
      { slug: 'demo', name: 'Demo' },
      { slug: 'other', name: 'Other' },
    ]);

    expect(screen.queryByRole('button', { name: 'Add to Demo' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Add to project…' }));
    expect(addPluginLayout).toHaveBeenCalledWith(starter);
  });

  test('with no projects the action still asks, so a project can be created', () => {
    renderWithProjects([]);
    expect(
      screen.getByRole('button', { name: 'Add to project…' }),
    ).toBeTruthy();
  });

  test('an in-flight add disables the action instead of queueing another', () => {
    const addPluginLayout = renderWithProjects(
      [{ slug: 'demo', name: 'Demo' }],
      {
        assigningLayout: true,
      },
    );

    const button = screen.getByRole('button', { name: 'Adding…' });
    fireEvent.click(button);
    expect(addPluginLayout).not.toHaveBeenCalled();
  });

  test('a plugin that adds nothing renders no section', () => {
    const bare = {
      name: 'smart-routing',
      displayName: 'Smart Routing',
      version: '1.0.0',
      hasBundle: false,
    };
    viewModel = baseViewModel({
      plugins: [bare],
      filtered: [bare],
      items: [{ id: bare.name, name: bare.displayName, subtitle: '' }],
      selectedPlugin: bare.name,
      selected: bare,
      projects: [{ slug: 'demo', name: 'Demo' }],
    });

    render(<PluginManagementView onNavigate={vi.fn()} />);

    expect(screen.queryByText('What it adds')).toBeNull();
  });
  test('prefers a display name the payload declares over the humanized slug', () => {
    viewModel = baseViewModel({
      plugins: [
        {
          ...starter,
          layout: { slug: 'getting-started', name: 'First Steps' },
        },
      ],
      filtered: [starter],
      items: [{ id: starter.name, name: starter.displayName, subtitle: '' }],
      selectedPlugin: starter.name,
      selected: {
        ...starter,
        layout: { slug: 'getting-started', name: 'First Steps' },
      },
      projects: [{ slug: 'demo', name: 'Demo' }],
    });

    render(<PluginManagementView onNavigate={vi.fn()} />);

    expect(screen.getByText('First Steps')).toBeTruthy();
    expect(screen.queryByText('Getting Started')).toBeNull();
  });
});
