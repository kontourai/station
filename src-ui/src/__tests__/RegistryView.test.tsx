/**
 * @vitest-environment jsdom
 */

import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import * as remotePluginBundleConsent from '../core/remotePluginBundleConsent';

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

const registryItems = {
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
} as const;

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
      callbacks?.onSuccess?.({
        success: true,
        action: variables.action,
        permissions: installedPermissions,
      });
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
const pluginRegistryListeners = new Set<() => void>();
let pluginRegistryStatus: {
  state: 'ready' | 'degraded';
  failedPluginNames: readonly string[];
  failure: 'remote-isolation' | undefined;
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
  useRegistryItemsQuery: (tab: string) => ({
    data: emptyTabs.has(tab)
      ? []
      : registryItems[tab as keyof typeof registryItems].map((item) => ({
          ...item,
          installed: installedByTab[tab as keyof typeof installedByTab].has(
            item.id,
          ),
        })),
    isLoading: false,
  }),
  useRegistrySkillActionMutation: () => makeMutation('skills'),
}));

vi.mock('@kontourai/station-connect', () => ({
  useConnections: () => ({ activeConnection: { id: 'local-station' } }),
}));

const navigateMock = vi.fn();
const showSurfaceMock = vi.fn();
const platformProfile = vi.hoisted(() => ({ isTauri: false }));

// #928 C2a: "Open a Project to Add Layout" means Home by name and reveals
// the Home surface through the shared command hook.
vi.mock('../contexts/useShowSurface', () => ({
  useShowSurface: () => showSurfaceMock,
}));

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

afterEach(() => {
  for (const installedItems of Object.values(installedByTab)) {
    installedItems.clear();
  }
  mutationCalls.length = 0;
  previewResults.clear();
  installedPermissions = undefined;
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
  expect(navigateMock).toHaveBeenCalledWith(`/plugins/${pluginName}`);
}

describe('RegistryView', () => {
  test('updates the URL when switching Registry tabs', () => {
    render(<RegistryView />);

    fireEvent.click(screen.getByRole('tab', { name: 'Skills' }));

    expect(navigateMock).toHaveBeenCalledWith('/registry/skills');
  });

  test('keeps remote plugin isolation visible in the Registry', () => {
    render(<RegistryView />);

    act(() => {
      pluginRegistryStatus = {
        state: 'degraded',
        failedPluginNames: [],
        failure: 'remote-isolation',
      };
      for (const listener of pluginRegistryListeners) listener();
    });

    expect(
      screen.getByText(
        /Extensions are off for this remote Station on this device/,
      ),
    ).toBeTruthy();
  });

  test('states the app-wide authority of remote extensions without claiming profile-only containment', () => {
    render(<RegistryView />);

    act(() => {
      pluginRegistryStatus = {
        state: 'degraded',
        failedPluginNames: [],
        failure: 'remote-isolation',
      };
      for (const listener of pluginRegistryListeners) listener();
    });
    fireEvent.click(
      screen.getByRole('button', {
        name: 'Enable remote extensions for this Station…',
      }),
    );

    expect(
      screen.getByText(
        /this entire app's authority, including other Stations' data/i,
      ),
    ).toBeTruthy();
    expect(screen.queryByText(/applies only to this Station/i)).toBeNull();
    expect(screen.queryByText(/native bridge/i)).toBeNull();
  });

  test('names the native bridge and paired credentials in native-host consent copy', () => {
    platformProfile.isTauri = true;
    render(<RegistryView />);

    act(() => {
      pluginRegistryStatus = {
        state: 'degraded',
        failedPluginNames: [],
        failure: 'remote-isolation',
      };
      for (const listener of pluginRegistryListeners) listener();
    });
    fireEvent.click(
      screen.getByRole('button', {
        name: 'Enable remote extensions for this Station…',
      }),
    );

    expect(
      screen.getByText(
        /On this device that includes the native bridge and this device's paired Station credentials\./,
      ),
    ).toBeTruthy();
  });

  test('puts the remote-isolation consent section before the catalog', () => {
    render(<RegistryView />);

    act(() => {
      pluginRegistryStatus = {
        state: 'degraded',
        failedPluginNames: [],
        failure: 'remote-isolation',
      };
      for (const listener of pluginRegistryListeners) listener();
    });

    const consent = screen.getByRole('button', {
      name: 'Enable remote extensions for this Station…',
    });
    const catalog = screen.getByTestId('registry-detail');
    expect(
      consent.compareDocumentPosition(catalog) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  test('granted consent with a stale refusal keeps the override row below the catalog', () => {
    // Right after consent is granted, the 'remote-isolation' status lingers
    // until the reload completes; the enabled row must not jump above the
    // catalog during that window (archive#2539).
    remotePluginBundleConsent.setRemotePluginBundlesAllowed(
      'local-station',
      'http://127.0.0.1:3141',
      true,
    );
    render(<RegistryView />);

    act(() => {
      pluginRegistryStatus = {
        state: 'degraded',
        failedPluginNames: [],
        failure: 'remote-isolation',
      };
      for (const listener of pluginRegistryListeners) listener();
    });

    const disable = screen.getByRole('button', {
      name: 'Disable remote extensions',
    });
    const catalog = screen.getByTestId('registry-detail');
    expect(
      catalog.compareDocumentPosition(disable) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  test('keeps remote extensions enabled and shows an error when revocation cannot be verified', () => {
    const apiBase = 'http://127.0.0.1:3141';
    remotePluginBundleConsent.setRemotePluginBundlesAllowed(
      'local-station',
      apiBase,
      true,
    );
    const reload = vi
      .spyOn(remotePluginBundleConsent, 'reloadAfterRemotePluginBundleRevoke')
      .mockImplementation(() => {});
    const removeItem = vi
      .spyOn(Storage.prototype, 'removeItem')
      .mockImplementation(() => {
        throw new Error('storage unavailable');
      });
    try {
      render(<RegistryView />);
      fireEvent.click(
        screen.getByRole('button', { name: 'Disable remote extensions' }),
      );
      fireEvent.click(
        screen.getByRole('button', { name: 'Disable and reload' }),
      );

      expect(reload).not.toHaveBeenCalled();
      expect(
        screen.getByText(
          "Couldn't disable — storage is unavailable; remote extensions remain enabled",
        ),
      ).toBeTruthy();
      expect(
        screen.getByRole('dialog', { name: 'Disable remote extensions?' }),
      ).toBeTruthy();
    } finally {
      removeItem.mockRestore();
      reload.mockRestore();
    }
  });

  test('reloads only after remote extension revocation is verified', () => {
    const apiBase = 'http://127.0.0.1:3141';
    remotePluginBundleConsent.setRemotePluginBundlesAllowed(
      'local-station',
      apiBase,
      true,
    );
    const reload = vi
      .spyOn(remotePluginBundleConsent, 'reloadAfterRemotePluginBundleRevoke')
      .mockImplementation(() => {});
    try {
      render(<RegistryView />);
      fireEvent.click(
        screen.getByRole('button', { name: 'Disable remote extensions' }),
      );
      fireEvent.click(
        screen.getByRole('button', { name: 'Disable and reload' }),
      );

      expect(reload).toHaveBeenCalledOnce();
    } finally {
      reload.mockRestore();
    }
  });

  test('uses selected-card preview actions for agents without mutating on card click', () => {
    const { rerender } = render(<RegistryView />);

    fireEvent.click(
      screen.getByRole('button', { name: 'View Agent Two details' }),
    );

    expect(mutationCalls).toEqual([]);
    const detail = screen.getByTestId('registry-detail');
    expect(within(detail).getByText('Selected agent')).toBeTruthy();
    expect(
      within(detail).getByRole('button', { name: 'Install' }),
    ).toBeTruthy();

    fireEvent.click(within(detail).getByRole('button', { name: 'Install' }));

    expect(mutationCalls).toEqual([
      { id: 'agent-two', action: 'install', tab: 'agents' },
    ]);
    expect(screen.getByText('Installed Agent Two')).toBeTruthy();

    rerender(<RegistryView />);
    const installedDetail = screen.getByTestId('registry-detail');
    expect(
      within(installedDetail).getByRole('button', { name: 'Remove' }),
    ).toBeTruthy();

    fireEvent.click(
      within(installedDetail).getByRole('button', { name: 'Remove' }),
    );

    expect(mutationCalls).toEqual([
      { id: 'agent-two', action: 'install', tab: 'agents' },
      { id: 'agent-two', action: 'uninstall', tab: 'agents' },
    ]);
    expect(screen.getByText('Removed Agent Two')).toBeTruthy();
  });

  test.each([
    ['Skills', 'skills', 'skill-one', 'Skill One', 'GitHub'],
    [
      'Integrations',
      'integrations',
      'integration-one',
      'Integration One',
      undefined,
    ],
    ['Plugins', 'plugins', 'demo-layout', 'Demo Layout', 'Configured registry'],
  ] as const)(
    'renders preview install/remove actions for %s',
    (tabLabel, tabKey, itemId, itemLabel, sourceLabel) => {
      if (tabKey === 'plugins') {
        previewResults.set(itemId, validDemoPreview());
      }
      const { rerender } = render(<RegistryView />);

      fireEvent.click(screen.getByRole('tab', { name: tabLabel }));
      const detail = screen.getByTestId('registry-detail');
      expect(
        within(detail).getByText(`Selected ${tabKey.slice(0, -1)}`),
      ).toBeTruthy();
      if (sourceLabel) {
        expect(within(detail).getAllByText(sourceLabel).length).toBeGreaterThan(
          0,
        );
      }

      fireEvent.click(
        screen.getByRole('button', { name: `View ${itemLabel} details` }),
      );
      const selectedDetail = screen.getByTestId('registry-detail');
      fireEvent.click(
        within(selectedDetail).getByRole('button', { name: /Install/ }),
      );

      if (tabKey === 'plugins') {
        // A registry plugin installs from its preview (#765 D1): the modal
        // shows what the previewed source contributes before anything runs.
        fireEvent.click(
          screen.getByRole('button', { name: 'Confirm Install' }),
        );
      }

      expect(mutationCalls).toContainEqual(
        expect.objectContaining({
          id: itemId,
          action: 'install',
          tab: tabKey,
        }),
      );
      if (tabKey === 'plugins') {
        expectInstalledToast(`Installed ${itemLabel}`, itemId);
      } else {
        expect(screen.getByText(`Installed ${itemLabel}`)).toBeTruthy();
        expect(showToastMock).not.toHaveBeenCalled();
      }

      rerender(<RegistryView />);
      const installedDetail = screen.getByTestId('registry-detail');
      if (tabKey === 'plugins') {
        fireEvent.click(
          within(installedDetail).getByRole('button', {
            name: 'Open a Project to Add Layout',
          }),
        );
        // #928 C2a: Home is revealed as a surface, not navigated to.
        expect(showSurfaceMock).toHaveBeenCalledWith('home');
        expect(navigateMock).not.toHaveBeenCalledWith('/');
        expect(
          within(installedDetail).getByRole('button', {
            name: 'Manage Plugin',
          }),
        ).toBeTruthy();
        expect(
          within(installedDetail).getByRole('button', {
            name: 'Remove Plugin',
          }),
        ).toBeTruthy();
      } else {
        expect(
          within(installedDetail).getByRole('button', { name: /Remove/ }),
        ).toBeTruthy();
      }
    },
  );

  // #765 F1's exact case: the audit found a layout's detail block labeled
  // "Selected agent". The eyebrow derives from the active tab, so the
  // Layouts tab — which the install-flow cases above cannot cover, its
  // detail actions differ — is pinned on its own.
  test('derives the detail eyebrow from the Layouts tab', () => {
    render(<RegistryView />);

    fireEvent.click(screen.getByRole('tab', { name: 'Layouts' }));
    const detail = screen.getByTestId('registry-detail');
    expect(within(detail).getByText('Selected layout')).toBeTruthy();
    expect(within(detail).queryByText('Selected agent')).toBeNull();
  });

  test('offers a route to installed skill management from the skills tab', () => {
    render(<RegistryView />);

    fireEvent.click(screen.getByRole('tab', { name: 'Skills' }));
    fireEvent.click(
      screen.getByRole('button', { name: 'Manage Installed Skills' }),
    );

    expect(navigateMock).toHaveBeenCalledWith('/guidance?tab=skills');
  });

  test('re-syncs the rendered tab when the route prop changes after mount (Back/Forward)', () => {
    const view = render(<RegistryView initialTab="plugins" />);
    expect(
      screen.getByRole('tab', { name: 'Plugins', selected: true }),
    ).toBeTruthy();

    view.rerender(<RegistryView initialTab="skills" />);
    expect(
      screen.getByRole('tab', { name: 'Skills', selected: true }),
    ).toBeTruthy();
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

  test('shows in-app empty-state guidance and docs, not a terminal command', () => {
    emptyTabs.add('agents');
    render(<RegistryView />);

    expect(
      screen.getByText(
        'No agents are available from the configured registry sources yet.',
      ),
    ).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Manage plugins' })).toBeNull();
    expect(
      screen.getByText(/Ask an administrator to include an item/i),
    ).toBeTruthy();
    expect(screen.queryByText(/station plugin install/i)).toBeNull();

    const docsLink = screen.getByRole('link', { name: 'Open plugin guidance' });
    expect(docsLink.getAttribute('href')).toBe(
      'https://github.com/kontourai/station/blob/main/docs/guides/plugins.md',
    );
    expect(docsLink.getAttribute('target')).toBe('_blank');
    expect(docsLink.getAttribute('rel')).toBe('noopener noreferrer');

    fireEvent.click(docsLink);
    expect(navigateMock).not.toHaveBeenCalledWith('/plugins');
  });

  test('filters registry items and explains and clears a no-match state', () => {
    render(<RegistryView />);

    fireEvent.change(screen.getByLabelText('Search agents'), {
      target: { value: 'backup' },
    });

    expect(
      screen.getByRole('button', { name: 'View Agent Two details' }),
    ).toBeTruthy();
    expect(
      screen.queryByRole('button', { name: 'View Agent One details' }),
    ).toBeNull();

    fireEvent.change(screen.getByLabelText('Search agents'), {
      target: { value: 'missing entry' },
    });

    expect(
      screen.getByText('Nothing in agents matches “missing entry”'),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Clear filter' }));
    expect(
      (screen.getByLabelText('Search agents') as HTMLInputElement).value,
    ).toBe('');
    expect(
      screen.getByRole('button', { name: 'View Agent One details' }),
    ).toBeTruthy();
  });

  test('keeps the available catalog usable while installed status is refreshing', () => {
    stalledInstalledTabs.add('plugins');

    render(<RegistryView initialTab="plugins" />);

    expect(screen.queryByText('Loading...')).toBeNull();
    expect(
      screen.getByRole('button', { name: 'View Demo Layout details' }),
    ).toBeTruthy();
    expect(
      (
        within(screen.getByTestId('registry-detail')).getByRole('button', {
          name: 'Checking installed status...',
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
  });

  test('shows an installed plugin immediately while its refetch catches up', () => {
    staleAfterMutationTabs.add('plugins');
    previewResults.set('demo-layout', validDemoPreview());

    render(<RegistryView initialTab="plugins" />);
    fireEvent.click(
      within(screen.getByTestId('registry-detail')).getByRole('button', {
        name: 'Install',
      }),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Confirm Install' }));

    const installedDetail = screen.getByTestId('registry-detail');
    expectInstalledToast('Installed Demo Layout', 'demo-layout');
    expect(
      within(installedDetail).getByRole('button', {
        name: 'Open a Project to Add Layout',
      }),
    ).toBeTruthy();
    expect(screen.getAllByText('Installed').length).toBeGreaterThan(0);
  });

  test('"Open a Project to Add Layout" reveals the Home surface instead of navigating to / (#928 C2a)', () => {
    staleAfterMutationTabs.add('plugins');
    previewResults.set('demo-layout', validDemoPreview());
    navigateMock.mockClear();
    showSurfaceMock.mockClear();

    render(<RegistryView initialTab="plugins" />);
    fireEvent.click(
      within(screen.getByTestId('registry-detail')).getByRole('button', {
        name: 'Install',
      }),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Confirm Install' }));
    fireEvent.click(
      within(screen.getByTestId('registry-detail')).getByRole('button', {
        name: 'Open a Project to Add Layout',
      }),
    );

    expect(showSurfaceMock).toHaveBeenCalledWith('home');
    expect(navigateMock).not.toHaveBeenCalledWith('/');
  });

  test('reconciles an optimistic install against contradictory fresh server state', async () => {
    staleAfterMutationTabs.add('plugins');
    reconciledRefetchTabs.add('plugins');
    previewResults.set('demo-layout', validDemoPreview());
    render(<RegistryView initialTab="plugins" />);

    fireEvent.click(
      within(screen.getByTestId('registry-detail')).getByRole('button', {
        name: 'Install',
      }),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Confirm Install' }));

    expectInstalledToast('Installed Demo Layout', 'demo-layout');
    await waitFor(() =>
      expect(
        within(screen.getByTestId('registry-detail')).getByRole('button', {
          name: 'Install',
        }),
      ).toBeTruthy(),
    );
    expect(refetchInstalled).toHaveBeenCalled();
  });

  test('fails closed when installed status errors and offers a retry', () => {
    installedErrorTabs.add('plugins');
    render(<RegistryView initialTab="plugins" />);

    expect(
      (
        within(screen.getByTestId('registry-detail')).getByRole('button', {
          name: 'Checking installed status...',
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
    fireEvent.click(
      screen.getByRole('button', { name: 'Retry installed status' }),
    );
    expect(refetchInstalled).toHaveBeenCalledTimes(1);
    expect(mutationCalls).toEqual([]);
  });

  test('a plugin that contributes no layout is confirmed with nothing to place (#1536 G7)', () => {
    previewResults.set('demo-layout', {
      ...validDemoPreview(),
      components: [{ type: 'provider', id: 'llm' }],
    });
    render(<RegistryView initialTab="plugins" />);

    fireEvent.click(
      within(screen.getByTestId('registry-detail')).getByRole('button', {
        name: 'Install',
      }),
    );
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

  test('keeps installed plugin removal reachable through the full lifecycle', () => {
    previewResults.set('demo-layout', validDemoPreview());
    render(<RegistryView initialTab="plugins" />);

    const detail = screen.getByTestId('registry-detail');
    fireEvent.click(within(detail).getByRole('button', { name: 'Install' }));
    fireEvent.click(screen.getByRole('button', { name: 'Confirm Install' }));
    expectInstalledToast('Installed Demo Layout', 'demo-layout');

    fireEvent.click(
      within(detail).getByRole('button', { name: 'Remove Plugin' }),
    );
    expect(screen.getByText('Removed Demo Layout')).toBeTruthy();
    expect(
      within(detail).getByRole('button', { name: 'Install' }),
    ).toBeTruthy();

    fireEvent.click(within(detail).getByRole('button', { name: 'Install' }));
    fireEvent.click(screen.getByRole('button', { name: 'Confirm Install' }));
    expectInstalledToast('Installed Demo Layout', 'demo-layout');
    expect(mutationCalls).toEqual([
      expect.objectContaining({
        id: 'demo-layout',
        action: 'install',
        tab: 'plugins',
      }),
      { id: 'demo-layout', action: 'uninstall', tab: 'plugins' },
      expect.objectContaining({
        id: 'demo-layout',
        action: 'install',
        tab: 'plugins',
      }),
    ]);
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
    render(<RegistryView initialTab="plugins" />);

    fireEvent.click(
      within(screen.getByTestId('registry-detail')).getByRole('button', {
        name: 'Install',
      }),
    );

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
      render(<RegistryView initialTab="plugins" />);
      fireEvent.click(
        within(screen.getByTestId('registry-detail')).getByRole('button', {
          name: 'Install',
        }),
      );
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
    render(<RegistryView initialTab="plugins" />);

    fireEvent.click(
      within(screen.getByTestId('registry-detail')).getByRole('button', {
        name: 'Install',
      }),
    );
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

  test('an agents-tab entry the plugin registry does not resolve keeps the plain agent install path', () => {
    render(<RegistryView />);

    fireEvent.click(
      screen.getByRole('button', { name: 'View Agent Two details' }),
    );
    fireEvent.click(
      within(screen.getByTestId('registry-detail')).getByRole('button', {
        name: 'Install',
      }),
    );

    expect(previewMutationCalls).toEqual(['agent-two']);
    expect(mutationCalls).toEqual([
      { id: 'agent-two', action: 'install', tab: 'agents' },
    ]);
  });

  test('renders a selected-card preview failure and keeps a repeat install click live', () => {
    previewResults.set('demo-layout', new Error('Preview staging failed'));
    render(<RegistryView initialTab="plugins" />);

    const install = within(screen.getByTestId('registry-detail')).getByRole(
      'button',
      { name: 'Install' },
    );
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
