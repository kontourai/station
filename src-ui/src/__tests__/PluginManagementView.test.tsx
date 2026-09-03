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

import { render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, test, vi } from 'vitest';

const refetchPlugins = vi.fn();
const reloadRejectedPlugin = vi.fn();

vi.mock('../contexts/NavigationContext', () => ({
  useNavigation: () => ({ navigate: vi.fn() }),
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
});
