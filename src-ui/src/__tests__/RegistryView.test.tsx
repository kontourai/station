/**
 * @vitest-environment jsdom
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { useRegistryItemsQuery } from '../../../packages/sdk/src/query-domains/catalog';
import type { RegistryItem } from '../components/registry/registryCatalogModel';
import * as remotePluginBundleConsent from '../core/remotePluginBundleConsent';

const registrySources = vi.hoisted(() => [] as Array<Record<string, unknown>>);
const catalogRecovery = vi.hoisted(() => ({
  useItems: vi.fn(),
  fetch: vi.fn(),
}));
vi.mock(
  '../../../packages/sdk/src/query-domains/catalogRequests',
  async (original) => ({
    ...(await original<
      typeof import('../../../packages/sdk/src/query-domains/catalogRequests')
    >()),
    fetchRegistryItems: catalogRecovery.fetch,
  }),
);

const installedByTab = {
  agents: new Set<string>(),
  integrations: new Set<string>(),
  plugins: new Set<string>(),
  layouts: new Set<string>(),
  skills: new Set<string>(),
};
const mutationCalls: Array<{
  action: 'install' | 'uninstall' | 'enable' | 'disable' | 'remove';
  id: string;
  tab: 'agents' | 'integrations' | 'plugins' | 'skills' | 'layouts';
  consent?: {
    permissions: string[];
    contentDigest: string;
    dependencies: string[];
  };
  skip?: string[];
}> = [];

/**
 * Registry ids the preview endpoint resolves as PLUGINS (#765 D1): install
 * clicks on the agents/plugins tabs preview first and open the install
 * preview modal. Ids absent here answer `registry-plugin-not-found`, which
 * keeps the plain agent install path.
 */
const previewResults = new Map<string, unknown>();
let installedPermissions:
  | {
      dependencies?: Array<{
        id: string;
        pendingConsent: Array<{ permission: string; tier: string }>;
      }>;
    }
  | undefined;
const previewMutationCalls: string[] = [];
let previewMutationResets = 0;
const validDemoPreview = () => ({
  valid: true,
  manifest: {
    name: 'demo-layout',
    displayName: 'Demo Layout',
    version: '1.0.0',
  },
  components: [{ type: 'layout', id: 'demo' }],
  conflicts: [],
  contentDigest: 'sha256:demo',
  permissions: {
    required: ['navigation.dock'],
    autoGranted: ['navigation.dock'],
    pendingConsent: [] as Array<{ permission: string; tier: string }>,
  },
  dependencies: [],
});

const registryItems: Record<keyof typeof installedByTab, RegistryItem[]> = {
  agents: [
    {
      id: 'agent-one',
      displayName: 'Agent One',
      description: 'Primary agent',
      version: '1.0.0',
    },
    {
      id: 'agent-two',
      displayName: 'Agent Two',
      description: 'Backup agent',
    },
  ],
  integrations: [
    {
      id: 'integration-one',
      displayName: 'Integration One',
      description: 'Registry integration',
    },
  ],
  plugins: [
    {
      id: 'demo-layout',
      displayName: 'Demo Layout',
      description: 'Starter plugin',
      source: '../demo-layout',
      version: '1.0.0',
    },
  ],
  skills: [
    {
      id: 'skill-one',
      displayName: 'Skill One',
      description: 'Registry skill',
      source: 'GitHub',
    },
    {
      id: 'prototype',
      displayName: 'Prototype',
      description: 'Build a prototype',
      source: 'GitHub',
      status: 'unsupported-skill-name',
    },
    {
      id: 'pr',
      displayName: 'Pull Request',
      description: 'Review a pull request',
      source: 'GitHub',
      status: 'unsupported-skill-format',
    },
  ],
  layouts: [
    {
      id: 'builtin:coding',
      name: 'Coding',
      description: 'Files and chat',
      source: 'builtin',
      lifecycle: { state: 'installed' },
      enabled: true,
    },
    {
      id: 'builtin:tasks',
      name: 'Tasks',
      description: 'Project tasks',
      source: 'builtin',
      lifecycle: { state: 'disabled' },
      enabled: false,
    },
  ],
};

function makeMutation(
  tab: 'agents' | 'integrations' | 'plugins' | 'skills' | 'layouts',
) {
  return {
    isPending: false,
    mutate: (
      variables: {
        id: string;
        action: 'install' | 'uninstall' | 'enable' | 'disable' | 'remove';
        consent?: {
          permissions: string[];
          contentDigest: string;
          dependencies: string[];
        };
        skip?: string[];
      },
      callbacks?: {
        onSuccess?: (result: {
          success: boolean;
          permissions?: typeof installedPermissions;
          action: 'install' | 'uninstall' | 'enable' | 'disable' | 'remove';
        }) => void;
      },
    ) => {
      mutationCalls.push({ tab, ...variables });
      if (!staleAfterMutationTabs.has(tab)) {
        if (variables.action === 'install' || variables.action === 'enable') {
          installedByTab[tab].add(variables.id);
        } else {
          installedByTab[tab].delete(variables.id);
        }
      }
      callbacks?.onSuccess?.(
        tab === 'plugins' && pluginInstallResult
          ? (pluginInstallResult as never)
          : {
              success: true,
              action: variables.action,
              permissions: installedPermissions,
            },
      );
    },
    variables: null,
  };
}

const emptyTabs = new Set<string>();
const stalledInstalledTabs = new Set<string>();
const staleAfterMutationTabs = new Set<string>();
const installedErrorTabs = new Set<string>();
const reconciledRefetchTabs = new Set<string>();
const refetchInstalled = vi.fn();
const reloadPlugins = vi.fn(async () => undefined);
/** What the plugin install resolves with instead of an applied install. */
let pluginInstallResult: unknown;
/** What `GET /api/plugins` lists (readiness included). */
let installedPluginRows: unknown[] = [];
const pluginRegistryListeners = new Set<() => void>();
let pluginRegistryStatus: {
  state: 'ready' | 'degraded';
  failedPluginNames: readonly string[];
  failure:
    | 'remote-isolation'
    | 'registry-unavailable'
    | 'bundle-load-failure'
    | undefined;
} = {
  state: 'ready',
  failedPluginNames: [],
  failure: undefined,
};

vi.mock('@kontourai/station-sdk', () => ({
  useInstalledRegistryItemsQuery: (tab: string) => ({
    data: stalledInstalledTabs.has(tab)
      ? undefined
      : registryItems[tab as keyof typeof registryItems].filter((item) =>
          installedByTab[tab as keyof typeof installedByTab].has(item.id),
        ),
    isLoading: stalledInstalledTabs.has(tab),
    error: installedErrorTabs.has(tab)
      ? new Error('Installed state unavailable')
      : null,
    refetch: () => {
      refetchInstalled(tab);
      return reconciledRefetchTabs.has(tab)
        ? Promise.resolve(undefined)
        : new Promise<undefined>(() => {});
    },
  }),
  useRegistryAgentActionMutation: () => makeMutation('agents'),
  useRegistryIntegrationActionMutation: () => makeMutation('integrations'),
  useRegistryLayoutActionMutation: () => makeMutation('layouts'),
  usePluginRegistryInstallMutation: () => makeMutation('plugins'),
  usePluginsQuery: () => ({ data: installedPluginRows }),
  usePluginRegistryPreviewMutation: () => ({
    isPending: false,
    variables: undefined,
    reset: () => {
      previewMutationResets += 1;
    },
    mutate: (
      registryId: string,
      callbacks?: {
        onSuccess?: (data: unknown) => void;
        onError?: (error: Error) => void;
      },
    ) => {
      previewMutationCalls.push(registryId);
      const result = previewResults.get(registryId);
      if (result instanceof Error) {
        callbacks?.onError?.(result);
        return;
      }
      callbacks?.onSuccess?.(
        result ?? {
          valid: false,
          error: `Plugin '${registryId}' not found in registry`,
          code: 'registry-plugin-not-found',
          components: [],
          conflicts: [],
        },
      );
    },
  }),
  useReloadPluginsMutation: () => ({ mutateAsync: reloadPlugins }),
  useInvalidateQuery: () => vi.fn(),
  useRegistrySourcesQuery: () => ({
    data: registrySources,
    isLoading: false,
    error: null,
    refetch: vi.fn(),
  }),
  useRegistrySourceActionMutation: () => ({
    mutate: vi.fn(),
    reset: vi.fn(),
    isPending: false,
    error: null,
  }),
  useRegistrySkillContentQuery: () => ({
    data: 'Instructions',
    isLoading: false,
    error: null,
  }),
  useRegistryItemsQuery: catalogRecovery.useItems,
  useRegistrySkillActionMutation: () => makeMutation('skills'),
}));

vi.mock('@kontourai/station-connect', () => ({
  useConnections: () => ({
    activeConnection: { id: 'local-station' },
    captureSelectionIntent: () => 0,
  }),
}));

const navigateMock = vi.fn();
const platformProfile = vi.hoisted(() => ({ isTauri: false }));

vi.mock('../contexts/NavigationContext', () => ({
  useNavigation: () => ({
    navigate: navigateMock,
  }),
}));

vi.mock('../contexts/ApiBaseContext', () => ({
  useApiBase: () => ({ apiBase: 'http://127.0.0.1:3141' }),
}));

const showToastMock = vi.fn();

vi.mock('../contexts/ToastContext', () => ({
  useToast: () => ({ showToast: showToastMock }),
}));

vi.mock('../platform/PlatformProfileContext', () => ({
  usePlatformProfile: () => platformProfile,
}));

const pluginRegistryReload = vi.fn();
const requestInstallConsent = vi.fn(async () => true);
const requestConsent = vi.fn(async () => true);

vi.mock('../core/PluginRegistry', () => ({
  pluginRegistry: {
    subscribe: (listener: () => void) => {
      pluginRegistryListeners.add(listener);
      return () => pluginRegistryListeners.delete(listener);
    },
    getLoadStatus: () => pluginRegistryStatus,
    reload: () => pluginRegistryReload(),
  },
}));

vi.mock('../core/PermissionManager', () => ({
  usePermissions: () => ({
    requestConsent,
    requestInstallConsent,
  }),
}));

import { RegistryView } from '../views/RegistryView';

function fixtureRegistryItems(tab: keyof typeof registryItems) {
  return {
    data: emptyTabs.has(tab)
      ? []
      : registryItems[tab].map((item) => ({
          ...item,
          installed: installedByTab[tab].has(item.id),
        })),
    isLoading: false,
  };
}
catalogRecovery.useItems.mockImplementation(fixtureRegistryItems);

afterEach(() => {
  catalogRecovery.useItems.mockImplementation(fixtureRegistryItems);
  catalogRecovery.fetch.mockReset();
  localStorage.clear();
  for (const installedItems of Object.values(installedByTab)) {
    installedItems.clear();
  }
  mutationCalls.length = 0;
  previewResults.clear();
  installedPermissions = undefined;
  pluginInstallResult = undefined;
  installedPluginRows = [];
  reloadPlugins.mockClear();
  requestConsent.mockClear();
  previewMutationCalls.length = 0;
  previewMutationResets = 0;
  pluginRegistryReload.mockClear();
  requestInstallConsent.mockClear();
  requestInstallConsent.mockResolvedValue(true);
  navigateMock.mockReset();
  showToastMock.mockReset();
  emptyTabs.clear();
  stalledInstalledTabs.clear();
  staleAfterMutationTabs.clear();
  installedErrorTabs.clear();
  reconciledRefetchTabs.clear();
  refetchInstalled.mockClear();
  platformProfile.isTauri = false;
  pluginRegistryStatus = {
    state: 'ready',
    failedPluginNames: [],
    failure: undefined,
  };
  pluginRegistryListeners.clear();
});

/**
 * #1536 G7. A plugin install is confirmed by the shared toast, carrying the
 * route to the one thing left to do — placing the layout the operator just
 * reviewed. It used to be a grey inline `page__message` row directly above the
 * catalog, which read as another search result rather than as the answer.
 *
 * Review L7: the action is named for what it does. It opens the plugin's
 * detail page, where the add actually happens; "Add to project" promised an
 * add this button never performed.
 */
function expectInstalledToast(message: string, pluginName: string) {
  expect(screen.queryByText(message)).toBeNull();
  const lastCall = showToastMock.mock.calls.at(-1);
  expect(lastCall, 'no toast was shown').toBeDefined();
  const [text, , , actions, tone] = lastCall as [
    string,
    unknown,
    unknown,
    Array<{ label: string; onClick: () => void }> | undefined,
    string,
  ];
  expect(text).toBe(message);
  expect(tone).toBe('success');
  expect(actions?.map((action) => action.label)).toEqual(['Open plugin']);
  actions?.[0].onClick();
  expect(navigateMock).toHaveBeenCalledWith(`/apps/library/${pluginName}`);
}

/**
 * The one place this view installs a plugin: the tool picker opened on a
 * named plugin (a tool request, the agent editor's tool library). No
 * catalogue page lists plugins; Apps › Discover installs them on its own.
 */
function renderPluginInstall() {
  return render(
    <RegistryView initialTab="plugins" toolPicker installTarget="demo-layout" />,
  );
}

function reviewPluginInstall() {
  fireEvent.click(
    screen.getByRole('button', { name: 'Review Demo Layout permissions' }),
  );
}

test('keeps an inspected catalog selection after a catalog refresh changes the available revision', async () => {
  const { RegistryView } = await import('../views/RegistryView');
  const view = render(<RegistryView initialTab="skills" />);
  fireEvent.click(
    screen.getByRole('button', { name: 'View Skill One details' }),
  );
  const original = registryItems.skills[0]!.id;
  registryItems.skills[0]!.id = 'skill-one-new-revision';
  try {
    view.rerender(<RegistryView initialTab="skills" />);
    fireEvent.click(
      screen.getByRole('button', { name: 'Install to workspace' }),
    );
    await waitFor(() =>
      expect(mutationCalls).toContainEqual(
        expect.objectContaining({
          tab: 'skills',
          id: original,
          action: 'install',
        }),
      ),
    );
  } finally {
    registryItems.skills[0]!.id = original;
  }
});

describe('RegistryView', () => {
  test.each(['skills', 'integrations'] as const)(
    'recovers the %s catalog after a failed read and a failed retry',
    async (tab) => {
      catalogRecovery.useItems.mockImplementation(useRegistryItemsQuery);
      catalogRecovery.fetch
        .mockRejectedValueOnce(new Error('Catalog offline'))
        .mockRejectedValueOnce(new Error('Still offline'))
        .mockResolvedValue(registryItems[tab]);
      const client = new QueryClient({
        defaultOptions: { queries: { retry: false } },
      });
      const { unmount } = render(
        <QueryClientProvider client={client}>
          <RegistryView initialTab={tab} />
        </QueryClientProvider>,
      );
      try {
        await screen.findByText('Try again in a moment.');
        expect(screen.queryByText('Catalog offline')).toBeNull();
        fireEvent.click(screen.getByRole('button', { name: 'Retry catalog' }));
        await waitFor(() => {
          expect(catalogRecovery.fetch).toHaveBeenCalledTimes(2);
          expect(
            screen.getByRole('button', { name: 'Retry catalog' }),
          ).toHaveProperty('disabled', false);
        });
        expect(screen.getByText('Try again in a moment.')).toBeTruthy();
        expect(screen.queryByText('Still offline')).toBeNull();
        fireEvent.click(screen.getByRole('button', { name: 'Retry catalog' }));
        await screen.findByRole('button', {
          name: `View ${registryItems[tab][0]!.displayName} details`,
        });
        expect(screen.queryByText('Try again in a moment.')).toBeNull();
        expect(catalogRecovery.fetch).toHaveBeenCalledTimes(3);
      } finally {
        unmount();
        client.clear();
      }
    },
  );
  test('the agent picker installs without navigating away from the agent draft', async () => {
    const { RegistryView } = await import('../views/RegistryView');
    const onInstalled = vi.fn();
    render(
      <RegistryView
        initialTab="integrations"
        toolPicker
        onInstalled={onInstalled}
      />,
    );
    expect(screen.queryByRole('tab', { name: 'Agents' })).toBeNull();
    expect(screen.getByRole('tab', { name: 'Plugins' })).toBeTruthy();
    fireEvent.change(screen.getByRole('searchbox', { name: 'Find tools' }), {
      target: { value: 'Integration One' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Install' }));
    await waitFor(() => expect(onInstalled).toHaveBeenCalledOnce());
  });
  test('keeps unsupported-format skill details available with an explanation and disabled installation', () => {
    render(<RegistryView initialTab="skills" />);
    fireEvent.click(
      screen.getByRole('button', { name: 'View Pull Request details' }),
    );
    const detail = screen.getByTestId('registry-detail');
    expect(within(detail).queryByText('Available')).toBeNull();
    expect(
      within(detail).getByText(
        'This skill uses metadata that Station cannot install. Its original Markdown is available for inspection; ask its publisher for a supported format.',
      ),
    ).toBeTruthy();
    const action = within(detail).getByRole('button', { name: 'Unavailable' });
    expect(action).toHaveProperty('disabled', true);
    fireEvent.click(action);
    expect(mutationCalls).toEqual([]);
  });

  test('keeps unsupported skill details visible without offering installation or blocking a valid sibling', () => {
    render(<RegistryView initialTab="skills" />);
    fireEvent.click(
      screen.getByRole('button', { name: 'View Prototype details' }),
    );
    const detail = screen.getByTestId('registry-detail');
    expect(within(detail).queryByText('Available')).toBeNull();
    expect(
      within(detail).getByText(
        'This skill uses a name reserved by Station. Ask its publisher for a supported name before installing.',
      ),
    ).toBeTruthy();
    const unavailable = within(detail).getByRole('button', {
      name: 'Unavailable',
    });
    expect(unavailable).toHaveProperty('disabled', true);
    fireEvent.click(unavailable);
    expect(mutationCalls).toEqual([]);
    fireEvent.click(
      screen.getByRole('button', { name: 'View Skill One details' }),
    );
    fireEvent.click(
      within(screen.getByTestId('registry-detail')).getByRole('button', {
        name: 'Install to workspace',
      }),
    );
    expect(mutationCalls).toEqual([
      { tab: 'skills', id: 'skill-one', action: 'install' },
    ]);
  });

  // Each catalogue is its own page: its picker lists sources of the page's
  // own kind, and choosing one narrows that page without leaving it.
  const SOURCES = [
    {
      id: 'skills-only',
      kind: 'skills',
      displayName: 'Skill library',
      origin: 'user',
      adapter: 'github',
      enabled: true,
      status: 'ready',
      detection: {
        state: 'detected',
        checkedAt: '2026-11-12T00:00:00.000Z',
        kinds: [
          { kind: 'skills', count: 3, via: 'skill-md', installable: true },
        ],
      },
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
            count: 1,
            via: 'station-manifest',
            installable: true,
          },
        ],
      },
    },
    {
      id: 'apps-only',
      kind: 'plugins',
      displayName: 'App catalog',
      origin: 'user',
      adapter: 'directory',
      enabled: true,
      status: 'ready',
    },
  ];

  test('Browse skills lists only skill sources, and choosing one keeps the page', () => {
    registrySources.push(...SOURCES);
    try {
      render(<RegistryView initialTab="skills" />);
      const picker = screen.getByLabelText('Source') as HTMLSelectElement;
      expect([...picker.options].map((option) => option.value)).toEqual([
        'all',
        'skills-only',
      ]);
      fireEvent.change(picker, { target: { value: 'skills-only' } });
      expect(picker.value).toBe('skills-only');
      expect(navigateMock).not.toHaveBeenCalled();
      expect(
        screen.getByRole('textbox', { name: 'Search skills' }),
      ).toBeTruthy();
    } finally {
      registrySources.length = 0;
    }
  });

  test.each(['integrations', 'layouts'] as const)(
    'the %s page has no source picker, because no source supplies it',
    (tab) => {
      registrySources.push(...SOURCES);
      try {
        render(<RegistryView initialTab={tab} />);
        expect(screen.queryByLabelText('Source')).toBeNull();
        expect(
          screen.queryByRole('button', { name: /^Manage sources/ }),
        ).toBeNull();
        expect(navigateMock).not.toHaveBeenCalled();
      } finally {
        registrySources.length = 0;
      }
    },
  );

  test('Discover comes first: management opens from the toolbar instead of sitting above the catalog', () => {
    render(<RegistryView initialTab="skills" />);
    const browse = screen.getByLabelText('Source');
    const tabs = screen.getByRole('textbox', { name: 'Search skills' });
    const follows = (a: Node, b: Node) =>
      Boolean(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);
    expect(follows(browse, tabs)).toBe(true);
    // No source list between browsing and the catalog.
    expect(
      screen.queryByText(/^Manage sources/, { selector: 'summary' }),
    ).toBeNull();
    const manage = screen.getByRole('button', { name: /^Manage sources/ });
    expect(follows(manage, tabs)).toBe(true);
    fireEvent.click(manage);
    expect(screen.getByRole('dialog', { name: 'Manage sources' })).toBeTruthy();
  });

  test('a catalog card shows a short Details label and names the item for assistive tech', () => {
    render(<RegistryView />);
    const button = screen.getByRole('button', {
      name: `View ${registryItems.skills[0]!.displayName} details`,
    });
    expect(button.textContent).toBe('Details');
  });

  test('each catalogue is its own page: no tab strip leads to the others', () => {
    for (const tab of [
      'agents',
      'skills',
      'integrations',
      'layouts',
    ] as const) {
      const view = render(<RegistryView initialTab={tab} />);
      expect(screen.queryByRole('tablist')).toBeNull();
      expect(screen.queryByRole('tab')).toBeNull();
      view.unmount();
    }
    expect(navigateMock).not.toHaveBeenCalled();
  });

  // The remote extension code controls moved to Apps › Library, where
  // AppsLibraryExtensions.test drives them; a catalogue page has none.
  test('a catalogue page carries no remote extension controls', () => {
    remotePluginBundleConsent.setRemotePluginBundlesAllowed(
      'local-station',
      'http://127.0.0.1:3141',
      true,
    );
    render(<RegistryView initialTab="skills" />);
    act(() => {
      pluginRegistryStatus = {
        state: 'degraded',
        failedPluginNames: [],
        failure: 'remote-isolation',
      };
      for (const listener of pluginRegistryListeners) listener();
    });
    expect(
      screen.queryByRole('button', { name: 'Review and enable' }),
    ).toBeNull();
    expect(
      screen.queryByRole('button', { name: 'Turn off extensions' }),
    ).toBeNull();
  });

  test('derives the detail eyebrow from the Layouts tab', () => {
    render(<RegistryView initialTab="layouts" />);

    const detail = screen.getByTestId('registry-detail');
    expect(within(detail).getByText('Selected layout')).toBeTruthy();
    expect(within(detail).queryByText('Selected agent')).toBeNull();
  });

  test('offers a route to installed skill management from the skills tab', () => {
    render(<RegistryView initialTab="skills" />);

    fireEvent.click(
      screen.getByRole('button', { name: 'Manage Installed Skills' }),
    );

    expect(navigateMock).toHaveBeenCalledWith('/guidance?tab=skills');
  });

  test('re-syncs the rendered tab when the route prop changes after mount (Back/Forward)', () => {
    const view = render(<RegistryView initialTab="integrations" />);
    expect(
      screen.getByRole('textbox', { name: 'Search tool servers' }),
    ).toBeTruthy();

    view.rerender(<RegistryView initialTab="skills" />);
    expect(screen.getByRole('textbox', { name: 'Search skills' })).toBeTruthy();
    expect(
      screen.queryByRole('textbox', { name: 'Search tool servers' }),
    ).toBeNull();
  });

  test('shows layout lifecycle truth and enables a disabled starter', () => {
    render(<RegistryView initialTab="layouts" />);

    const detail = screen.getByTestId('registry-detail');
    expect(within(detail).getByText('Coding')).toBeTruthy();
    expect(within(detail).getByRole('button', { name: 'Use' })).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'View Tasks details' }));
    fireEvent.click(
      within(screen.getByTestId('registry-detail')).getByRole('button', {
        name: 'Enable',
      }),
    );
    expect(mutationCalls).toContainEqual({
      id: 'builtin:tasks',
      action: 'enable',
      tab: 'layouts',
    });
  });

  test('shows in-app empty-state guidance, not a terminal command', () => {
    emptyTabs.add('skills');
    render(<RegistryView />);

    expect(screen.getByText('No skills in your sources yet.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Manage plugins' })).toBeNull();
    expect(
      screen.getByText('Add a source, or ask the Station operator to add one.'),
    ).toBeTruthy();
    expect(screen.queryByText(/station plugin install/i)).toBeNull();
  });

  test('filters registry items and explains and clears a no-match state', () => {
    render(<RegistryView />);

    fireEvent.change(screen.getByLabelText('Search skills'), {
      target: { value: 'prototype' },
    });

    expect(
      screen.getByRole('button', { name: 'View Prototype details' }),
    ).toBeTruthy();
    expect(
      screen.queryByRole('button', { name: 'View Skill One details' }),
    ).toBeNull();

    fireEvent.change(screen.getByLabelText('Search skills'), {
      target: { value: 'missing entry' },
    });

    expect(
      screen.getByText('Nothing in skills matches “missing entry”'),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Clear filter' }));
    expect(
      (screen.getByLabelText('Search skills') as HTMLInputElement).value,
    ).toBe('');
    expect(
      screen.getByRole('button', { name: 'View Skill One details' }),
    ).toBeTruthy();
  });

  test('keeps the available catalog usable while installed status is refreshing', () => {
    stalledInstalledTabs.add('integrations');

    render(<RegistryView initialTab="integrations" />);

    expect(screen.queryByText('Loading...')).toBeNull();
    expect(
      screen.getByRole('button', { name: 'View Integration One details' }),
    ).toBeTruthy();
    expect(
      (
        within(screen.getByTestId('registry-detail')).getByRole('button', {
          name: 'Checking installed status…',
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
  });

  test('a built-in-only layout preview does not ask for app-wide extension access', () => {
    platformProfile.isTauri = true;
    pluginRegistryStatus = {
      state: 'degraded',
      failedPluginNames: [],
      failure: 'remote-isolation',
    };
    previewResults.set('demo-layout', {
      ...validDemoPreview(),
      hasBundle: false,
    });
    renderPluginInstall();
    reviewPluginInstall();
    const preview = screen.getByRole('dialog', { name: 'Install Preview' });
    expect(
      within(preview).queryByRole('button', { name: 'Review and enable' }),
    ).toBeNull();
    fireEvent.click(
      within(preview).getByRole('button', { name: 'Confirm Install' }),
    );
    expect(mutationCalls).toHaveLength(1);
  });

  test('reviews extension access inside install preview without installing or leaving the preview', () => {
    pluginRegistryStatus = {
      state: 'degraded',
      failedPluginNames: [],
      failure: 'remote-isolation',
    };
    platformProfile.isTauri = true;
    previewResults.set('demo-layout', {
      ...validDemoPreview(),
      hasBundle: true,
    });
    renderPluginInstall();
    reviewPluginInstall();
    expect(
      screen.getByText(
        /You can install this plugin now. Its custom extension code stays off/,
      ),
    ).toBeTruthy();
    const preview = screen.getByRole('dialog', { name: 'Install Preview' });
    fireEvent.click(
      within(preview).getByRole('button', { name: 'Review and enable' }),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Not now' }));
    expect(mutationCalls).toEqual([]);
    expect(
      screen.getByRole('dialog', { name: 'Install Preview' }),
    ).toBeTruthy();
    expect(navigateMock).not.toHaveBeenCalled();
    fireEvent.click(
      within(preview).getByRole('button', { name: 'Review and enable' }),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Allow extensions' }));
    expect(mutationCalls).toEqual([]);
    expect(
      screen.getByRole('dialog', { name: 'Install Preview' }),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Confirm Install' }));
    expect(mutationCalls).toHaveLength(1);
  });

  // The optimistic state is the catalogue page's own, the same for every
  // tab it shows; Tools' Browse tool servers is one of those pages.
  test('shows an installed item immediately while its refetch catches up', () => {
    staleAfterMutationTabs.add('integrations');

    render(<RegistryView initialTab="integrations" />);
    fireEvent.click(
      within(screen.getByTestId('registry-detail')).getByRole('button', {
        name: 'Install',
      }),
    );

    const installedDetail = screen.getByTestId('registry-detail');
    expect(screen.getByText('Installed Integration One')).toBeTruthy();
    expect(
      within(installedDetail).getByRole('button', { name: 'Remove' }),
    ).toBeTruthy();
    expect(within(installedDetail).getByText('Installed')).toBeTruthy();
    expect(refetchInstalled).toHaveBeenCalledWith('integrations');
  });

  test('reconciles an optimistic install against contradictory fresh server state', async () => {
    staleAfterMutationTabs.add('integrations');
    reconciledRefetchTabs.add('integrations');
    render(<RegistryView initialTab="integrations" />);

    fireEvent.click(
      within(screen.getByTestId('registry-detail')).getByRole('button', {
        name: 'Install',
      }),
    );

    expect(screen.getByText('Installed Integration One')).toBeTruthy();
    await waitFor(() =>
      expect(
        within(screen.getByTestId('registry-detail')).getByRole('button', {
          name: 'Install',
        }),
      ).toBeTruthy(),
    );
    expect(refetchInstalled).toHaveBeenCalledWith('integrations');
  });

  test('fails closed when installed status errors and offers a retry', () => {
    installedErrorTabs.add('integrations');
    render(<RegistryView initialTab="integrations" />);

    expect(
      (
        within(screen.getByTestId('registry-detail')).getByRole('button', {
          name: 'Checking installed status…',
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
    fireEvent.click(
      screen.getByRole('button', { name: 'Retry installed status' }),
    );
    expect(refetchInstalled).toHaveBeenCalledTimes(1);
    expect(mutationCalls).toEqual([]);
  });

  test('an install saved without completing its activation says it is not active and points at the plugin, without a host review it cannot finish', async () => {
    previewResults.set('demo-layout', validDemoPreview());
    pluginInstallResult = {
      success: false,
      plugin: { name: 'demo-layout', version: '1.0.0' },
      permissions: {
        pendingConsent: [],
        dependencies: [
          {
            id: 'shared-providers',
            pendingConsent: [
              { permission: 'providers.register', tier: 'trusted' },
            ],
          },
        ],
      },
      configurationActivation: {
        status: 'pending',
        recovery: 'required',
        reason: 'saved',
      },
    };
    renderPluginInstall();
    reviewPluginInstall();
    fireEvent.click(screen.getByRole('button', { name: 'Confirm Install' }));

    await waitFor(() => expect(showToastMock).toHaveBeenCalled());
    const [text, , , actions, tone] = showToastMock.mock.calls.at(-1) as [
      string,
      unknown,
      unknown,
      Array<{ label: string; onClick: () => void }> | undefined,
      string,
    ];
    expect(text).toBe(
      'Demo Layout was installed, but its activation did not finish, so it is not active. Choose Recover plugin to activate it; trusted permissions are asked for after that.',
    );
    expect(tone).toBe('warning');
    actions?.[0]?.onClick();
    expect(navigateMock).toHaveBeenCalledWith('/apps/library/demo-layout');
    expect(mutationCalls).toHaveLength(1);
    expect(requestConsent).not.toHaveBeenCalled();
    expect(reloadPlugins).not.toHaveBeenCalled();
  });

  test('installing a plugin that is already installed but not active offers Recover, and installs again only when asked', async () => {
    previewResults.set('demo-layout', validDemoPreview());
    installedPluginRows = [
      {
        name: 'demo-layout',
        version: '1.0.0',
        installationReadiness: { state: 'pending', recovery: 'review' },
      },
    ];
    renderPluginInstall();
    reviewPluginInstall();
    fireEvent.click(screen.getByRole('button', { name: 'Confirm Install' }));

    await waitFor(() => expect(showToastMock).toHaveBeenCalled());
    const [text, , , actions, tone] = showToastMock.mock.calls.at(-1) as [
      string,
      unknown,
      unknown,
      Array<{ label: string; onClick: () => void }>,
      string,
    ];
    expect(text).toBe(
      'Demo Layout is already installed but not active. Recover it to activate it; installing it again adds another copy of its code.',
    );
    expect(tone).toBe('warning');
    expect(mutationCalls).toEqual([]);
    expect(actions.map((action) => action.label)).toEqual([
      'Recover plugin',
      'Install again anyway',
    ]);
    actions[0]!.onClick();
    expect(navigateMock).toHaveBeenCalledWith('/apps/library/demo-layout');
    actions[1]!.onClick();
    await waitFor(() => expect(mutationCalls).toHaveLength(1));
  });

  test('a plugin that contributes no layout is confirmed with nothing to place (#1536 G7)', () => {
    previewResults.set('demo-layout', {
      ...validDemoPreview(),
      components: [{ type: 'provider', id: 'llm' }],
    });
    renderPluginInstall();

    reviewPluginInstall();
    fireEvent.click(screen.getByRole('button', { name: 'Confirm Install' }));

    // The action is derived from what the preview actually reviewed, so an
    // "Add to project" that could not lead anywhere is not offered.
    const [text, , , actions] = showToastMock.mock.calls.at(-1) as [
      string,
      unknown,
      unknown,
      unknown,
    ];
    expect(text).toBe('Installed Demo Layout');
    expect(actions).toBeUndefined();
  });

  /**
   * #765 D1. An id the preview endpoint resolves as a PLUGIN installs from its
   * preview with the operator's decision attached, and the client plugin
   * registry reloads so the new components register without a page reload.
   * Installing one through the provider's raw tree copy used to land a tree
   * whose bundle was never built — every declared layout component then
   * rendered "Unsupported layout tab" while the install reported success.
   *
   * Review L6: this ran on the AGENTS tab, because a JSON-manifest registry
   * used to list its plugins there. #1536 D2 ended that — each surface now
   * browses its own kind — so the plugin install path is exercised where
   * plugins actually appear. The agents-tab fallback for an id the preview
   * does NOT resolve is pinned separately, above.
   */
  test('installs a registry plugin from its preview with the operator decision attached', () => {
    previewResults.set('demo-layout', validDemoPreview());
    renderPluginInstall();

    reviewPluginInstall();

    // Nothing mutated yet: the preview modal is the decision point.
    expect(mutationCalls).toEqual([]);
    expect(screen.getByText('Install Preview')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Confirm Install' }));

    expect(mutationCalls).toEqual([
      {
        id: 'demo-layout',
        action: 'install',
        tab: 'plugins',
        consent: {
          permissions: ['navigation.dock'],
          contentDigest: 'sha256:demo',
          dependencies: [],
        },
        skip: [],
      },
    ]);
    expectInstalledToast('Installed Demo Layout', 'demo-layout');
    expect(pluginRegistryReload).toHaveBeenCalled();
  });

  test.each(['granted', 'pending', 'unknown'] as const)(
    'uses the install result for dependency approvals: %s',
    async (state) => {
      previewResults.set('demo-layout', {
        ...validDemoPreview(),
        dependencies: [
          {
            id: 'shared-providers',
            status: 'installed',
            consent: {
              permissions: ['providers.register'],
              contentDigest: 'sha256:dependency',
              dependencies: [],
              pendingConsent: [
                { permission: 'providers.register', tier: 'trusted' },
              ],
            },
          },
        ],
      });
      installedPermissions =
        state === 'unknown'
          ? undefined
          : {
              dependencies: [
                {
                  id: 'shared-providers',
                  pendingConsent:
                    state === 'granted'
                      ? []
                      : [{ permission: 'providers.register', tier: 'trusted' }],
                },
              ],
            };
      requestConsent.mockClear();
      renderPluginInstall();
      reviewPluginInstall();
      fireEvent.click(screen.getByRole('button', { name: 'Confirm Install' }));
      await waitFor(() => expect(mutationCalls).toHaveLength(1));
      if (state === 'pending') {
        await waitFor(() =>
          expect(requestConsent).toHaveBeenCalledWith(
            'shared-providers',
            'shared-providers',
            [{ permission: 'providers.register', tier: 'trusted' }],
          ),
        );
      } else {
        expect(requestConsent).not.toHaveBeenCalled();
        if (state === 'unknown')
          await waitFor(() =>
            expect(
              screen.getByText(
                /did not report current dependency approval status/,
              ),
            ).toBeTruthy(),
          );
      }
    },
  );

  test('a declined consent decision installs nothing', async () => {
    previewResults.set('demo-layout', {
      ...validDemoPreview(),
      permissions: {
        required: ['providers.register'],
        autoGranted: [],
        pendingConsent: [{ permission: 'providers.register', tier: 'trusted' }],
      },
    });
    requestInstallConsent.mockResolvedValueOnce(false);
    renderPluginInstall();

    reviewPluginInstall();
    fireEvent.click(screen.getByRole('button', { name: 'Confirm Install' }));

    await waitFor(() =>
      expect(screen.getByText(/Install declined for Demo Layout/)).toBeTruthy(),
    );
    expect(requestInstallConsent).toHaveBeenCalledWith(
      'demo-layout',
      'Demo Layout',
      [{ permission: 'providers.register', tier: 'trusted' }],
    );
    expect(mutationCalls).toEqual([]);
    expect(pluginRegistryReload).not.toHaveBeenCalled();
  });

  // The agent catalogue is gone: the page opens on skills by default, and
  // nothing installs an agent entry from here.
  test('opens on Browse skills when no page is named', () => {
    render(<RegistryView />);
    expect(screen.getByRole('textbox', { name: 'Search skills' })).toBeTruthy();
    expect(screen.queryByRole('textbox', { name: 'Search agents' })).toBeNull();
  });

  test('renders a selected-card preview failure and keeps a repeat install click live', () => {
    previewResults.set('demo-layout', new Error('Preview staging failed'));
    renderPluginInstall();

    const install = screen.getByRole('button', {
      name: 'Review Demo Layout permissions',
    });
    fireEvent.click(install);

    expect(screen.getByText('Preview staging failed')).toBeTruthy();
    expect(previewMutationCalls).toEqual(['demo-layout']);

    previewResults.set('demo-layout', validDemoPreview());
    fireEvent.click(install);

    expect(previewMutationCalls).toEqual(['demo-layout', 'demo-layout']);
    expect(previewMutationResets).toBe(2);
    expect(screen.getByText('Install Preview')).toBeTruthy();
  });
});
