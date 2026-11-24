/**
 * @vitest-environment jsdom
 */

import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import type { RegistryItem } from '../../../components/registry/registryCatalogModel';
import exampleCatalog from './fixtures/example-catalog.json';

/**
 * Rows as `GET /api/registry/plugins` lists them for the repository's
 * example catalog: the fixture is the server's own listing (pinned by
 * `discover-catalog-fixture.test.ts`), with the catalog selection the source
 * manager adds.
 */
const catalogRows = (): RegistryItem[] =>
  (exampleCatalog as RegistryItem[]).map((row) => ({
    ...row,
    catalog: {
      sourceId: 'bundled',
      itemId: row.id,
      revision: 'a'.repeat(64),
      kind: 'plugins' as const,
    },
    catalogSourceName: 'Bundled examples',
    catalogFreshness: 'live' as const,
  }));

const state = vi.hoisted(() => ({
  rows: [] as unknown[],
  installed: [] as unknown[],
  error: null as Error | null,
  loading: false,
  refetch: vi.fn(),
  previewCalls: [] as string[],
  pluginCalls: [] as Array<Record<string, unknown>>,
  sourceActions: [] as unknown[],
  sources: [] as unknown[],
  navigate: vi.fn(),
  showToast: vi.fn(),
  registryListeners: new Set<() => void>(),
  phone: false,
  registryStatus: {
    state: 'ready',
    failedPluginNames: [] as string[],
    failure: undefined as string | undefined,
  },
}));

vi.mock('@kontourai/station-sdk', () => ({
  useRegistryItemsQuery: () => ({
    data: state.loading ? undefined : state.error ? undefined : state.rows,
    error: state.error,
    isLoading: state.loading,
    dataUpdatedAt: 1,
    refetch: state.refetch,
  }),
  useInstalledRegistryItemsQuery: () => ({
    data: state.installed,
    isLoading: false,
    error: null,
    refetch: () => Promise.resolve(undefined),
  }),
  useInvalidateQuery: () => vi.fn(),
  usePluginRegistryPreviewMutation: () => ({
    isPending: false,
    variables: undefined,
    reset: vi.fn(),
    mutate: (id: string, callbacks: { onSuccess: (data: unknown) => void }) => {
      state.previewCalls.push(id);
      callbacks.onSuccess({
        valid: true,
        manifest: { name: id, displayName: 'Knowledge Docs', version: '1.0.0' },
        components: [{ type: 'layout', id: 'knowledge-docs' }],
        conflicts: [],
        contentDigest: 'sha256:digest',
        registryTrustRevision: 'trust-1',
        permissions: {
          required: ['navigation.dock'],
          autoGranted: ['navigation.dock'],
          pendingConsent: [],
        },
        dependencies: [],
      });
    },
  }),
  usePluginRegistryInstallMutation: () => ({
    isPending: false,
    variables: undefined,
    mutate: (
      variables: Record<string, unknown>,
      callbacks: { onSuccess: (result: unknown) => void },
    ) => {
      state.pluginCalls.push(variables);
      // The server after a removal: the app is no longer installed.
      if (variables.action === 'uninstall') {
        state.installed = state.installed.filter(
          (row) => (row as { id: string }).id !== variables.id,
        );
        state.rows = state.rows.map((row) =>
          (row as RegistryItem).id === variables.id
            ? { ...(row as RegistryItem), installed: false }
            : row,
        );
      }
      callbacks.onSuccess({ success: true });
    },
  }),
  useRegistryAgentActionMutation: () => ({ isPending: false, mutate: vi.fn() }),
  useReloadPluginsMutation: () => ({ mutateAsync: async () => undefined }),
  usePluginsQuery: () => ({ data: [] }),
  useRegistrySourcesQuery: () => ({
    data: state.sources,
    isLoading: false,
    error: null,
    refetch: vi.fn(),
  }),
  useRegistrySourceActionMutation: () => ({
    mutate: (variables: unknown) => state.sourceActions.push(variables),
    reset: vi.fn(),
    isPending: false,
    error: null,
  }),
}));

vi.mock('@kontourai/station-connect', () => ({
  useConnections: () => ({
    activeConnection: { id: 'local-station' },
    captureSelectionIntent: () => 0,
  }),
}));
vi.mock('../../../contexts/NavigationContext', () => ({
  useNavigation: () => ({ navigate: state.navigate }),
}));
vi.mock('../../../contexts/ApiBaseContext', () => ({
  useApiBase: () => ({ apiBase: 'http://127.0.0.1:3141' }),
}));
vi.mock('../../../contexts/ToastContext', () => ({
  useToast: () => ({ showToast: state.showToast }),
}));
vi.mock('../../../platform/PlatformProfileContext', () => ({
  usePlatformProfile: () => ({ isTauri: false }),
}));
vi.mock('../../../core/PluginRegistry', () => ({
  pluginRegistry: {
    subscribe: (listener: () => void) => {
      state.registryListeners.add(listener);
      return () => state.registryListeners.delete(listener);
    },
    getLoadStatus: () => state.registryStatus,
    reload: vi.fn(async () => undefined),
  },
}));
vi.mock('../../../hooks/useIsMobile', () => ({
  useIsMobile: () => state.phone,
}));
vi.mock('../../../core/PermissionManager', () => ({
  usePermissions: () => ({
    requestConsent: vi.fn(async () => true),
    requestInstallConsent: vi.fn(async () => true),
  }),
}));

import { DiscoverView } from '../DiscoverView';

afterEach(() => {
  state.rows = catalogRows();
  state.installed = [];
  state.error = null;
  state.loading = false;
  state.refetch.mockReset();
  state.previewCalls.length = 0;
  state.pluginCalls.length = 0;
  state.sourceActions.length = 0;
  state.sources = [];
  state.navigate.mockReset();
  state.phone = false;
  state.showToast.mockReset();
  state.registryStatus = {
    state: 'ready',
    failedPluginNames: [],
    failure: undefined,
  };
});
state.rows = catalogRows();

const cardNames = () =>
  screen
    .getAllByRole('heading', { level: 3 })
    .map((heading) => heading.textContent);

const facetGroup = (name: string) => screen.getByRole('group', { name });

/** The group offers exactly these facets, named as a screen reader says them. */
function expectFacets(group: string, names: string[]) {
  const buttons = within(facetGroup(group)).getAllByRole('button');
  expect(buttons).toHaveLength(names.length);
  names.forEach((name, index) =>
    expect(within(facetGroup(group)).getByRole('button', { name })).toBe(
      buttons[index],
    ),
  );
}

describe('Apps › Discover', () => {
  test('offers only the facets the example manifests declare, with their counts', () => {
    render(<DiscoverView />);

    // Each facet's name keeps its label and its count apart.
    expectFacets('Works with', [
      'Everything',
      'Chats and agents 7 apps',
      'Knowledge 2 apps',
    ]);
    expectFacets('Opens as', [
      'Anywhere',
      'Its own screen 7 apps',
      'A view in a project 10 apps',
      'A pane 1 app',
    ]);
  });

  test('a facet shows only the apps whose facts declare it; the rest appear under Everything', () => {
    render(<DiscoverView />);
    expect(cardNames()).toContain('Smart Routing');

    fireEvent.click(
      within(facetGroup('Works with')).getByRole('button', {
        name: /Knowledge/,
      }),
    );
    expect(cardNames()).toEqual([
      'Knowledge Docs Starter',
      'Enterprise Layout',
    ]);

    fireEvent.click(
      within(facetGroup('Works with')).getByRole('button', {
        name: 'Everything',
      }),
    );
    fireEvent.click(
      within(facetGroup('Opens as')).getByRole('button', { name: /A pane/ }),
    );
    expect(cardNames()).toEqual(['Session Activity Pane']);
  });

  test('a card says what the app is for, its screens, what it brings and needs, and where its code runs', () => {
    render(<DiscoverView />);
    const knowledge = screen
      .getByRole('heading', { name: 'Knowledge Docs Starter' })
      .closest('li')!;
    expect(within(knowledge).getByText('Library · Ask · Sources')).toBeTruthy();
    expect(
      within(knowledge).getByText(
        '1 agent · 1 prompt · 1 knowledge collection',
      ),
    ).toBeTruthy();
    expect(
      within(knowledge).getByText("Runs in Station's window"),
    ).toBeTruthy();
    expect(within(knowledge).queryByText(/Sandboxed/)).toBeNull();

    const pane = screen
      .getByRole('heading', { name: 'Session Activity Pane' })
      .closest('li')!;
    expect(within(pane).getByText('a view in a project, a pane')).toBeTruthy();
    expect(
      within(pane).getByText('station-sessions-mcp tool server'),
    ).toBeTruthy();
    expect(within(pane).getByText('Sandboxed')).toBeTruthy();
    expect(within(pane).queryByText("Runs in Station's window")).toBeNull();
  });

  test('says honestly what is not an app and what Station could not read', () => {
    state.rows = [
      ...catalogRows(),
      {
        id: 'remote-app',
        displayName: 'Remote app',
        installed: false,
        catalogSourceName: 'Team catalog',
      },
    ];
    render(<DiscoverView />);
    const routing = screen
      .getByRole('heading', { name: 'Smart Routing' })
      .closest('li')!;
    expect(
      within(routing).getByText(
        'No screen of its own: it adds skills, agents or providers.',
      ),
    ).toBeTruthy();
    const remote = screen
      .getByRole('heading', { name: 'Remote app' })
      .closest('li')!;
    expect(
      within(remote).getByText('What it includes is shown when you review it.'),
    ).toBeTruthy();

    fireEvent.click(
      within(facetGroup('Opens as')).getByRole('button', {
        name: /Its own screen/,
      }),
    );
    expect(cardNames()).not.toContain('Remote app');
    expect(cardNames()).not.toContain('Smart Routing');
  });

  test('Added means installed: an installed app is managed in Library and can be removed', () => {
    state.installed = [{ id: 'knowledge-docs-starter', installed: true }];
    state.rows = catalogRows().map((row) =>
      row.id === 'knowledge-docs-starter'
        ? {
            ...row,
            installed: true,
            installedPluginName: 'knowledge-docs-starter',
          }
        : row,
    );
    render(<DiscoverView />);
    const added = screen
      .getAllByText('Added')
      .map((badge) => badge.closest('li')?.querySelector('h3')?.textContent);
    expect(added).toEqual(['Knowledge Docs Starter']);
    // Being added does not hide where its screen code runs.
    const card = screen
      .getByRole('heading', { name: 'Knowledge Docs Starter' })
      .closest('li')!;
    expect(within(card).getByText("Runs in Station's window")).toBeTruthy();

    fireEvent.click(
      screen.getByRole('button', { name: 'Manage Knowledge Docs Starter' }),
    );
    expect(state.navigate).toHaveBeenCalledWith(
      '/apps/library/knowledge-docs-starter',
    );
  });

  test("Remove asks Library's question first: Cancel removes nothing, Remove removes once and the card offers Review", async () => {
    state.installed = [{ id: 'knowledge-docs-starter', installed: true }];
    state.rows = catalogRows().map((row) =>
      row.id === 'knowledge-docs-starter'
        ? {
            ...row,
            installed: true,
            installedPluginName: 'knowledge-docs-starter',
          }
        : row,
    );
    render(<DiscoverView />);
    const remove = screen.getByRole('button', {
      name: 'Remove Knowledge Docs Starter',
    });

    remove.focus();
    fireEvent.click(remove);
    let dialog = screen.getByRole('dialog', { name: 'Remove plugin' });
    expect(dialog.textContent).toContain(
      'Remove “Knowledge Docs Starter” from Station? This cannot be undone.',
    );
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('dialog', { name: 'Remove plugin' })).toBeNull();
    expect(state.pluginCalls).toEqual([]);

    fireEvent.click(remove);
    dialog = screen.getByRole('dialog', { name: 'Remove plugin' });
    await act(async () => {
      fireEvent.click(within(dialog).getByRole('button', { name: 'Remove' }));
    });
    expect(state.pluginCalls).toEqual([
      { id: 'knowledge-docs-starter', action: 'uninstall' },
    ]);
    const review = screen.getByRole('button', {
      name: 'Review Knowledge Docs Starter',
    });
    expect(document.activeElement).toBe(review);
    expect(
      screen.queryByRole('button', { name: 'Remove Knowledge Docs Starter' }),
    ).toBeNull();
  });

  test('Review installs through the preview with the decision attached, then points at Library', () => {
    render(<DiscoverView />);
    fireEvent.click(
      screen.getByRole('button', { name: 'Review Knowledge Docs Starter' }),
    );
    expect(state.previewCalls).toEqual(['knowledge-docs-starter']);
    expect(state.pluginCalls).toEqual([]);

    fireEvent.click(screen.getByRole('button', { name: 'Confirm Install' }));
    expect(state.pluginCalls).toEqual([
      expect.objectContaining({
        id: 'knowledge-docs-starter',
        action: 'install',
        consent: expect.objectContaining({
          contentDigest: 'sha256:digest',
          permissions: ['navigation.dock'],
        }),
      }),
    ]);
  });

  test('facet counts follow the search and the other facet, and a chosen value stays to be cleared', () => {
    render(<DiscoverView />);
    fireEvent.change(screen.getByLabelText('Search apps'), {
      target: { value: 'knowledge docs' },
    });
    expectFacets('Opens as', [
      'Anywhere',
      'Its own screen 1 app',
      'A view in a project 1 app',
    ]);

    fireEvent.change(screen.getByLabelText('Search apps'), {
      target: { value: '' },
    });
    fireEvent.click(
      within(facetGroup('Opens as')).getByRole('button', { name: /A pane/ }),
    );
    fireEvent.change(screen.getByLabelText('Search apps'), {
      target: { value: 'knowledge docs' },
    });
    expect(
      within(facetGroup('Opens as')).getByRole('button', {
        name: 'A pane 0 apps',
      }),
    ).toBeTruthy();
    fireEvent.click(
      within(facetGroup('Opens as')).getByRole('button', { name: 'Anywhere' }),
    );
    expect(cardNames()).toEqual(['Knowledge Docs Starter']);
  });

  test('pressing a chosen facet value again clears it, even when the search leaves it at zero', () => {
    render(<DiscoverView />);
    const pane = () =>
      within(facetGroup('Opens as')).getByRole('button', { name: /A pane/ });
    fireEvent.click(pane());
    expect(pane().getAttribute('aria-pressed')).toBe('true');
    fireEvent.change(screen.getByLabelText('Search apps'), {
      target: { value: 'knowledge docs' },
    });
    expect(pane().textContent).toContain('0');
    fireEvent.click(pane());
    expect(
      within(facetGroup('Opens as'))
        .getByRole('button', { name: 'Anywhere' })
        .getAttribute('aria-pressed'),
    ).toBe('true');
    expect(cardNames()).toEqual(['Knowledge Docs Starter']);
  });

  test('search matches the source and version the card shows', () => {
    state.rows = catalogRows().map((row) =>
      row.id === 'fieldwork-review'
        ? { ...row, catalogSourceName: 'Field team catalog' }
        : row,
    );
    render(<DiscoverView />);
    const search = screen.getByLabelText('Search apps');
    fireEvent.change(search, { target: { value: 'field team' } });
    expect(cardNames()).toEqual(['Fieldwork Review']);
    fireEvent.change(search, { target: { value: 'v0.1.0' } });
    expect(cardNames()).toEqual(['Fieldwork Review']);
  });

  test('claims no trust line when the server does not say where screen code runs', () => {
    state.rows = catalogRows().map((row) => {
      if (!row.app || row.app.kind !== 'app') return row;
      const { inProcessScreen: _omitted, ...older } = row.app;
      return { ...row, app: older as typeof row.app };
    });
    render(<DiscoverView />);
    expect(screen.queryByText("Runs in Station's window")).toBeNull();
    expect(screen.queryByText('Sandboxed')).toBeNull();
    // The rest of what it knows is still shown.
    expect(screen.getByText('Library · Ask · Sources')).toBeTruthy();
  });

  test('the other filters come before the apps in reading order', () => {
    render(<DiscoverView />);
    const moreFilters = screen.getByRole('complementary', {
      name: 'More filters',
    });
    const apps = screen.getByRole('region', { name: 'Apps' });
    expect(
      moreFilters.compareDocumentPosition(apps) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(within(moreFilters).getByRole('group', { name: 'Opens as' })).toBe(
      facetGroup('Opens as'),
    );
  });

  test('on a phone the other filters fold, open on request, and name what is filtering', () => {
    state.phone = true;
    render(<DiscoverView />);
    const toggle = screen.getByRole('button', { name: 'More filters' });
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByRole('group', { name: 'Opens as' })).toBeNull();
    // What it works with stays out, above the apps.
    expect(facetGroup('Works with')).toBeTruthy();

    fireEvent.click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    fireEvent.click(
      within(facetGroup('Opens as')).getByRole('button', { name: /A pane/ }),
    );
    fireEvent.click(toggle);
    expect(screen.queryByRole('group', { name: 'Opens as' })).toBeNull();
    expect(
      screen.getByRole('button', { name: 'More filters · A pane' }),
    ).toBeTruthy();
    expect(cardNames()).toEqual(['Session Activity Pane']);
  });

  test('ends the sentence before the Skills and Tools links, which open Skills and the Customize Tools item', () => {
    render(<DiscoverView />);
    const moreFilters = screen.getByRole('complementary', {
      name: 'More filters',
    });
    // The sentence ends before the links, which stand on their own row after
    // it, so no word or full stop can be stranded beside a link.
    const sentence = within(moreFilters).getByText(
      'Skills and tool servers are found where you use them.',
    );
    expect(sentence.tagName).toBe('P');
    expect(within(sentence).queryAllByRole('button')).toHaveLength(0);
    const skills = within(moreFilters).getByRole('button', { name: 'Skills' });
    const tools = within(moreFilters).getByRole('button', { name: 'Tools' });
    expect(skills.parentElement).toBe(tools.parentElement);
    expect(skills.parentElement?.textContent).toBe('SkillsTools');
    fireEvent.click(skills);
    expect(state.navigate).toHaveBeenLastCalledWith('/guidance?tab=skills');
    fireEvent.click(tools);
    expect(state.navigate).toHaveBeenLastCalledWith('/customize/tools');
  });

  test('a search that matches nothing keeps both filter groups in place', () => {
    render(<DiscoverView />);
    fireEvent.change(screen.getByLabelText('Search apps'), {
      target: { value: 'nothing matches this' },
    });
    expectFacets('Works with', ['Everything']);
    expectFacets('Opens as', ['Anywhere']);
  });

  test('says when a source served its last saved list', () => {
    state.rows = catalogRows().map((row) => ({
      ...row,
      catalogFreshness: 'stale' as const,
    }));
    render(<DiscoverView />);
    expect(
      screen.getByText(/last list Station could read from their source/),
    ).toBeTruthy();
  });

  test('shows loading, a failed read with retry, and an empty catalogue', () => {
    state.loading = true;
    const { rerender } = render(<DiscoverView />);
    expect(screen.getByRole('status', { name: 'Loading apps' })).toBeTruthy();

    state.loading = false;
    state.error = new Error('catalogue unavailable');
    rerender(<DiscoverView />);
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(state.refetch).toHaveBeenCalled();

    state.error = null;
    state.rows = [];
    rerender(<DiscoverView />);
    expect(screen.getByText('Your sources list no apps yet')).toBeTruthy();
  });

  test('keeps the source controls and their refresh action', () => {
    state.sources = [
      {
        id: 'team',
        kind: 'plugins',
        displayName: 'Team catalog',
        origin: 'user',
        adapter: 'directory',
        enabled: true,
        status: 'stale',
      },
    ];
    render(<DiscoverView />);
    fireEvent.click(screen.getByRole('button', { name: /Manage sources/ }));
    fireEvent.click(screen.getByRole('button', { name: /Refresh/ }));
    expect(state.sourceActions).toEqual([
      expect.objectContaining({ id: 'team', action: 'refresh' }),
    ]);
  });

  test('names a local catalogue without its path and keeps the location as the tooltip', () => {
    state.sources = [
      {
        id: 'bundled',
        kind: 'plugins',
        displayName: 'Station',
        origin: 'station',
        location: '/Users/someone/station/examples/registry/default.json',
        adapter: 'manifest',
        enabled: true,
        status: 'ready',
      },
      {
        id: 'repo',
        kind: 'plugins',
        displayName: 'Team apps',
        origin: 'user',
        location: 'github:example-org/example-apps/main/apps',
        adapter: 'github',
        enabled: true,
        status: 'ready',
      },
    ];
    render(<DiscoverView />);
    const picker = screen.getByLabelText('Show apps from') as HTMLSelectElement;
    const local = [...picker.options].find((o) => o.value === 'bundled')!;
    expect(local.textContent).toBe('Station');
    expect(local.title).toBe('~/station/examples/registry/default.json');
    // A repository is not a path: its address still tells sources apart.
    const repo = [...picker.options].find((o) => o.value === 'repo')!;
    expect(repo.textContent).toBe(
      'Team apps — github.com/example-org/example-apps/apps @ main',
    );
    expect(repo.title).toBe('');
  });

  test('Manage sources lists every source, so one Discover does not browse can still be removed', () => {
    state.sources = [
      {
        id: 'apps',
        kind: 'plugins',
        displayName: 'App catalog',
        origin: 'user',
        adapter: 'directory',
        enabled: true,
        status: 'ready',
      },
      {
        id: 'agents-only',
        kind: 'agents',
        displayName: 'Agent catalog',
        origin: 'user',
        adapter: 'directory',
        enabled: true,
        status: 'ready',
        detection: {
          state: 'detected',
          checkedAt: '2026-11-12T00:00:00.000Z',
          kinds: [
            {
              kind: 'agents',
              count: 2,
              via: 'station-manifest',
              installable: true,
            },
          ],
        },
      },
    ];
    render(<DiscoverView />);
    // The picker offers only what Discover shows.
    const picker = screen.getByLabelText('Show apps from') as HTMLSelectElement;
    expect([...picker.options].map((option) => option.value)).toEqual([
      'all',
      'apps',
    ]);
    fireEvent.click(screen.getByRole('button', { name: 'Manage sources (2)' }));
    const dialog = screen.getByRole('dialog', { name: 'Manage sources' });
    expect(within(dialog).getByText('Agent catalog')).toBeTruthy();
    // Its card says what it provides.
    expect(within(dialog).getByText('2 agents')).toBeTruthy();
    fireEvent.click(
      within(dialog).getByRole('button', {
        name: 'More actions for Agent catalog',
      }),
    );
    fireEvent.click(screen.getByRole('menuitem', { name: 'Remove source' }));
    expect(state.sourceActions).toContainEqual(
      expect.objectContaining({ id: 'agents-only', action: 'remove' }),
    );
  });

  test('keeps the remote extension consent on the page', () => {
    render(<DiscoverView />);
    act(() => {
      state.registryStatus = {
        state: 'degraded',
        failedPluginNames: [],
        failure: 'remote-isolation',
      };
      for (const listener of state.registryListeners) listener();
    });
    expect(
      screen.getByText(
        /Extensions from http:\/\/127.0.0.1:3141 are off on this device/,
      ),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Review and enable' }));
    expect(
      screen.getByText(/other Stations' data, credentials in this window/i),
    ).toBeTruthy();
  });
});
