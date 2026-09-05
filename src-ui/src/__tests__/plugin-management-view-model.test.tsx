/* @vitest-environment jsdom */

import {
  act,
  fireEvent,
  render,
  renderHook,
  screen,
  waitFor,
} from '@testing-library/react';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { InstallPreviewModal } from '../views/plugin-management/InstallPreviewModal';
import {
  consentFailureMessage,
  usePluginManagementViewModel,
} from '../views/plugin-management/usePluginManagementViewModel';

const mocks = vi.hoisted(() => ({
  installMutate: vi.fn(),
  previewMutate: vi.fn(),
  requestInstallConsent: vi.fn(),
  installOnSuccess: null as
    | ((data: {
        plugin?: { name: string; displayName?: string; agents?: unknown[] };
        permissions?: {
          pendingConsent?: Array<{ permission: string; tier: string }>;
          dependencies?: Array<{
            id: string;
            pendingConsent: Array<{ permission: string; tier: string }>;
          }>;
        };
      }) => Promise<void>)
    | null,
  queryClient: {
    invalidateQueries: vi.fn(),
  },
  reloadClientRegistry: vi.fn(),
  reloadPlugins: vi.fn(),
  revokePermission: vi.fn(async () => ({
    granted: [],
    reconciliation: {
      status: 'completed',
      effects: [],
    } as {
      status: string;
      effects?: string[];
      operationId?: string;
      generation?: number;
      failures?: string[];
    },
  })),
  requestConsent: vi.fn(),
  // `data: plugins = []` alone makes a failed `usePluginsQuery`
  // read indistinguishable from a host with no plugins installed, so
  // `PluginManagementView` claimed "No plugins installed yet" over a read
  // that never answered.
  pluginsError: undefined as unknown,
  pluginsData: [] as unknown[],
  refetchPlugins: vi.fn(),
  selectedId: null as string | null,
  selectPlugin: vi.fn(),
  deselectPlugin: vi.fn(),
  previewOnSuccess: null as ((data: unknown) => void) | null,
  projects: [] as Array<{ slug: string; name: string }>,
  addLayoutFromPlugin: vi.fn(),
  setLayout: vi.fn(),
}));

vi.mock('@tanstack/react-query', () => ({
  useQueryClient: () => mocks.queryClient,
}));

vi.mock('../contexts/ApiBaseContext', () => ({
  useApiBase: () => ({ apiBase: 'http://api.test' }),
}));

vi.mock('../contexts/NavigationContext', () => ({
  useNavigation: () => ({ setLayout: mocks.setLayout }),
}));

vi.mock('../contexts/ProjectsContext', () => ({
  useProjects: () => ({ projects: mocks.projects }),
}));

vi.mock('../core/PermissionManager', () => ({
  usePermissions: () => ({
    requestConsent: mocks.requestConsent,
    requestInstallConsent: mocks.requestInstallConsent,
  }),
}));

vi.mock('../core/PluginRegistry', () => ({
  pluginRegistry: { reload: mocks.reloadClientRegistry },
}));

vi.mock('../hooks/useUrlSelection', () => ({
  useUrlSelection: () => ({
    selectedId: mocks.selectedId,
    select: mocks.selectPlugin,
    deselect: mocks.deselectPlugin,
  }),
}));

vi.mock('@kontourai/station-sdk', () => ({
  useAddProjectLayoutFromPluginMutation: () => ({
    mutateAsync: mocks.addLayoutFromPlugin,
  }),
  useCreateProjectMutation: () => ({ mutateAsync: vi.fn() }),
  usePluginChangelogQuery: () => ({ data: null }),
  usePluginInstallMutation: () => ({
    isPending: false,
    mutate: mocks.installMutate,
  }),
  usePluginPreviewMutation: () => ({
    isPending: false,
    mutate: mocks.previewMutate,
  }),
  usePluginProvidersQuery: () => ({ data: undefined, isLoading: false }),
  usePluginProviderToggleMutation: () => ({ mutate: vi.fn() }),
  usePluginRemoveMutation: () => ({ mutate: vi.fn() }),
  usePluginSettingsMutation: () => ({ mutate: vi.fn() }),
  usePluginSettingsQuery: () => ({ data: undefined }),
  usePluginsQuery: () => ({
    data: mocks.pluginsData,
    error: mocks.pluginsError,
    isLoading: false,
    refetch: mocks.refetchPlugins,
  }),
  usePluginUpdateMutation: () => ({ mutate: vi.fn() }),
  usePluginUpdatesQuery: () => ({ data: [] }),
  reloadPlugins: mocks.reloadPlugins,
  useReloadPluginsMutation: () => ({
    isPending: false,
    mutateAsync: mocks.reloadPlugins,
  }),
  // archive#3815: withdrawing a permission.
  useRevokePluginPermissionMutation: () => ({
    mutateAsync: mocks.revokePermission,
  }),
  waitForAgentHealth: vi.fn(),
}));

describe('usePluginManagementViewModel', () => {
  beforeEach(() => {
    mocks.queryClient.invalidateQueries.mockReset();
    mocks.requestConsent.mockReset();
    mocks.requestInstallConsent.mockReset();
    mocks.installMutate
      .mockReset()
      .mockImplementation((_variables, options) => {
        mocks.installOnSuccess = options.onSuccess;
      });
    mocks.previewMutate.mockReset().mockImplementation((_source, options) => {
      mocks.previewOnSuccess = options.onSuccess;
    });
    mocks.reloadPlugins.mockReset().mockResolvedValue(undefined);
    mocks.reloadClientRegistry.mockReset().mockResolvedValue('ready');
    mocks.revokePermission.mockReset().mockResolvedValue({
      granted: [],
      reconciliation: { status: 'completed', effects: [] },
    });
    mocks.installOnSuccess = null;
    mocks.pluginsError = undefined;
    mocks.pluginsData = [];
    mocks.selectedId = null;
    mocks.selectPlugin.mockReset();
    mocks.deselectPlugin.mockReset();
    mocks.refetchPlugins.mockReset().mockResolvedValue({
      isError: false,
      error: null,
    });
    mocks.projects = [];
    mocks.addLayoutFromPlugin.mockReset().mockResolvedValue(undefined);
    mocks.setLayout.mockReset();
  });

  /**
   * #1536 G2. Installing a starter opened the Add Layout picker once, in the
   * seconds after the install, and the detail page offered nothing afterwards
   * — so a layout the operator skipped, or installed from Registry, had no
   * route into a project at all. `addPluginLayout` is that route.
   */
  describe('addPluginLayout', () => {
    const starter = {
      name: 'getting-started-starter',
      displayName: 'Getting Started Starter',
      layout: { slug: 'getting-started' },
    };

    test('adds straight to the only project and opens it, without asking', async () => {
      mocks.projects = [{ slug: 'demo', name: 'Demo' }];
      const { result } = renderHook(() => usePluginManagementViewModel());

      await act(async () => {
        await result.current.addPluginLayout(starter);
      });

      expect(mocks.addLayoutFromPlugin).toHaveBeenCalledWith({
        projectSlug: 'demo',
        plugin: 'getting-started-starter',
      });
      expect(mocks.setLayout).toHaveBeenCalledWith('demo', 'getting-started');
      expect(result.current.layoutAssignment).toBeNull();
    });

    test('asks which project when there is more than one, and adds nothing yet', async () => {
      mocks.projects = [
        { slug: 'demo', name: 'Demo' },
        { slug: 'other', name: 'Other' },
      ];
      const { result } = renderHook(() => usePluginManagementViewModel());

      await act(async () => {
        await result.current.addPluginLayout(starter);
      });

      expect(mocks.addLayoutFromPlugin).not.toHaveBeenCalled();
      expect(result.current.layoutAssignment).toEqual({
        pluginName: 'getting-started-starter',
        displayName: 'Getting Started Starter',
        layoutSlug: 'getting-started',
      });
    });

    test('opens the picker with no projects, so the create-a-project path is reachable', async () => {
      const { result } = renderHook(() => usePluginManagementViewModel());

      await act(async () => {
        await result.current.addPluginLayout(starter);
      });

      expect(mocks.addLayoutFromPlugin).not.toHaveBeenCalled();
      expect(result.current.layoutAssignment).not.toBeNull();
      expect(result.current.quickProjectName).toBe('Getting Started Starter');
    });

    test('reports the failure against the named project rather than silently doing nothing', async () => {
      mocks.projects = [{ slug: 'demo', name: 'Demo' }];
      mocks.addLayoutFromPlugin.mockRejectedValue(new Error('nope'));
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const { result } = renderHook(() => usePluginManagementViewModel());

      await act(async () => {
        await result.current.addPluginLayout(starter);
      });

      expect(result.current.message).toEqual({
        type: 'error',
        text: 'Failed to add the Getting Started Starter layout to Demo.',
      });
      expect(mocks.setLayout).not.toHaveBeenCalled();
      warn.mockRestore();
    });

    test('does nothing for a plugin that contributes no layout', async () => {
      mocks.projects = [{ slug: 'demo', name: 'Demo' }];
      const { result } = renderHook(() => usePluginManagementViewModel());

      await act(async () => {
        await result.current.addPluginLayout({ name: 'smart-routing' });
      });

      expect(mocks.addLayoutFromPlugin).not.toHaveBeenCalled();
      expect(result.current.layoutAssignment).toBeNull();
    });
  });

  test('surfaces the query error as pluginsError (Review H1)', () => {
    mocks.pluginsError = new Error('plugins read failed');
    const { result } = renderHook(() => usePluginManagementViewModel());

    expect(result.current.pluginsError).toBe(mocks.pluginsError);
  });

  test('refetchPlugins is the query refetch, not a no-op (Review H1)', () => {
    const { result } = renderHook(() => usePluginManagementViewModel());

    result.current.refetchPlugins();
    expect(mocks.refetchPlugins).toHaveBeenCalledTimes(1);
  });

  test('reloads server, client registry, and collection after manifest repair', async () => {
    mocks.selectedId = 'rejected:repairable';
    mocks.pluginsData = [
      {
        status: 'rejected',
        name: 'repairable',
        displayName: 'repairable',
        rejection: {
          code: 'malformed-json',
          reason: 'plugin.json contains malformed JSON.',
          recovery: {
            kind: 'repair-manifest',
            instruction: 'Repair plugin.json, then choose Reload plugins.',
          },
        },
      },
    ];
    mocks.refetchPlugins.mockResolvedValueOnce({
      data: [{ name: 'repairable', version: '2.0.0' }],
      isError: false,
      error: null,
    });
    const { result } = renderHook(() => usePluginManagementViewModel());

    await act(async () => {
      await result.current.reloadRejectedPlugin();
    });

    expect(mocks.reloadPlugins).toHaveBeenCalledOnce();
    expect(mocks.reloadClientRegistry).toHaveBeenCalledOnce();
    expect(mocks.refetchPlugins).toHaveBeenCalledOnce();
    expect(mocks.reloadPlugins.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.reloadClientRegistry.mock.invocationCallOrder[0],
    );
    expect(mocks.reloadClientRegistry.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.refetchPlugins.mock.invocationCallOrder[0],
    );
    expect(mocks.queryClient.invalidateQueries.mock.calls).toEqual([
      [{ queryKey: ['plugin-updates'] }],
      [{ queryKey: ['layouts'] }],
      [{ queryKey: ['agents'] }],
      [{ queryKey: ['projects'] }],
    ]);
    expect(mocks.selectPlugin).toHaveBeenCalledWith('repairable');
    expect(mocks.deselectPlugin).not.toHaveBeenCalled();
  });

  test('does not overwrite user navigation while repaired selection reconciliation is in flight', async () => {
    mocks.selectedId = 'rejected:repairable';
    mocks.pluginsData = [
      {
        status: 'rejected',
        name: 'repairable',
        displayName: 'repairable',
        rejection: {
          code: 'malformed-json',
          reason: 'plugin.json contains malformed JSON.',
          recovery: {
            kind: 'repair-manifest',
            instruction: 'Repair plugin.json, then choose Reload plugins.',
          },
        },
      },
    ];
    let finishRefetch!: () => void;
    mocks.refetchPlugins.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishRefetch = () =>
            resolve({
              data: [{ name: 'repairable', version: '2.0.0' }],
              isError: false,
              error: null,
            });
        }),
    );
    const { result, rerender } = renderHook(() =>
      usePluginManagementViewModel(),
    );

    let reload!: Promise<void>;
    act(() => {
      reload = result.current.reloadRejectedPlugin();
    });
    await waitFor(() => expect(mocks.refetchPlugins).toHaveBeenCalledOnce());

    act(() => {
      mocks.selectedId = 'another-plugin';
      rerender();
    });
    await act(async () => {
      finishRefetch();
      await reload;
    });

    expect(mocks.selectPlugin).not.toHaveBeenCalled();
    expect(mocks.deselectPlugin).not.toHaveBeenCalled();
  });

  test('keeps a still-rejected plugin selected and reports that reload did not repair it', async () => {
    const rejected = {
      status: 'rejected',
      name: 'repairable',
      displayName: 'Repairable plugin',
      rejection: {
        code: 'malformed-json',
        reason: 'plugin.json contains malformed JSON.',
        recovery: {
          kind: 'repair-manifest',
          instruction: 'Repair plugin.json, then choose Reload plugins.',
        },
      },
    };
    mocks.selectedId = 'rejected:repairable';
    mocks.pluginsData = [rejected];
    mocks.refetchPlugins.mockResolvedValueOnce({
      data: [rejected],
      isError: false,
      error: null,
    });
    const { result } = renderHook(() => usePluginManagementViewModel());

    await act(async () => {
      await result.current.reloadRejectedPlugin();
    });

    expect(mocks.selectPlugin).not.toHaveBeenCalled();
    expect(mocks.deselectPlugin).not.toHaveBeenCalled();
    expect(result.current.message).toEqual({
      type: 'error',
      text: 'Repairable plugin is still rejected. plugin.json contains malformed JSON.',
    });
  });

  test('preserves the rejected directory when an unrelated valid manifest has the same name', async () => {
    const rejected = {
      status: 'rejected',
      name: 'repairable',
      displayName: 'Repairable folder',
      rejection: {
        code: 'malformed-json',
        reason: 'plugin.json contains malformed JSON.',
        recovery: {
          kind: 'repair-manifest',
          instruction: 'Repair plugin.json, then choose Reload plugins.',
        },
      },
    };
    const unrelated = { name: 'repairable', version: '1.0.0' };
    mocks.selectedId = 'rejected:repairable';
    mocks.pluginsData = [rejected, unrelated];
    mocks.refetchPlugins.mockResolvedValueOnce({
      data: [unrelated, rejected],
      isError: false,
      error: null,
    });
    const { result } = renderHook(() => usePluginManagementViewModel());

    await act(async () => {
      await result.current.reloadRejectedPlugin();
    });

    expect(mocks.selectPlugin).not.toHaveBeenCalled();
    expect(mocks.deselectPlugin).not.toHaveBeenCalled();
    expect(result.current.message).toEqual({
      type: 'error',
      text: 'Repairable folder is still rejected. plugin.json contains malformed JSON.',
    });
  });

  test('keeps a client-registry reload failure visible and does not refresh the collection', async () => {
    mocks.reloadClientRegistry.mockRejectedValueOnce(
      new Error('registry is still unavailable'),
    );
    const { result } = renderHook(() => usePluginManagementViewModel());

    await act(async () => {
      await result.current.reloadRejectedPlugin();
    });

    expect(mocks.reloadPlugins).toHaveBeenCalledOnce();
    expect(mocks.refetchPlugins).not.toHaveBeenCalled();
    expect(result.current.message).toEqual({
      type: 'error',
      text: 'Plugins were not reloaded: registry is still unavailable',
    });
  });

  test('treats a degraded client-registry reload as recovery failure', async () => {
    mocks.reloadClientRegistry.mockResolvedValueOnce('degraded');
    const { result } = renderHook(() => usePluginManagementViewModel());

    await act(async () => {
      await result.current.reloadRejectedPlugin();
    });

    expect(mocks.reloadPlugins).toHaveBeenCalledOnce();
    expect(mocks.reloadClientRegistry).toHaveBeenCalledOnce();
    expect(mocks.refetchPlugins).not.toHaveBeenCalled();
    expect(result.current.message).toEqual({
      type: 'error',
      text: 'Plugins were not reloaded: browser plugin registry is still degraded',
    });
  });

  test('keeps a collection refetch failure visible after both reload steps', async () => {
    mocks.refetchPlugins.mockResolvedValueOnce({
      isError: true,
      error: new Error('collection is still unavailable'),
    });
    const { result } = renderHook(() => usePluginManagementViewModel());

    await act(async () => {
      await result.current.reloadRejectedPlugin();
    });

    expect(mocks.reloadPlugins).toHaveBeenCalledOnce();
    expect(mocks.reloadClientRegistry).toHaveBeenCalledOnce();
    expect(result.current.message).toEqual({
      type: 'error',
      text: 'Plugins were not reloaded: collection is still unavailable',
    });
  });

  test('owns one pending latch across server, registry, and collection reloads', async () => {
    let releaseServerReload!: () => void;
    let releaseClientReload!: () => void;
    let releaseCollectionReload!: () => void;
    mocks.reloadPlugins.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          releaseServerReload = resolve;
        }),
    );
    mocks.reloadClientRegistry.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          releaseClientReload = resolve;
        }),
    );
    mocks.refetchPlugins.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          releaseCollectionReload = () =>
            resolve({ isError: false, error: null });
        }),
    );
    const { result } = renderHook(() => usePluginManagementViewModel());

    let first!: Promise<void>;
    act(() => {
      first = result.current.reloadRejectedPlugin();
    });
    await waitFor(() =>
      expect(result.current.reloadRejectedPending).toBe(true),
    );

    await act(async () => {
      await result.current.reloadRejectedPlugin();
    });
    expect(mocks.reloadPlugins).toHaveBeenCalledOnce();
    expect(mocks.reloadClientRegistry).not.toHaveBeenCalled();
    expect(mocks.refetchPlugins).not.toHaveBeenCalled();

    await act(async () => {
      releaseServerReload();
    });
    await waitFor(() =>
      expect(mocks.reloadClientRegistry).toHaveBeenCalledOnce(),
    );
    expect(result.current.reloadRejectedPending).toBe(true);
    expect(mocks.refetchPlugins).not.toHaveBeenCalled();

    await act(async () => {
      await result.current.reloadRejectedPlugin();
    });
    expect(mocks.reloadPlugins).toHaveBeenCalledOnce();

    await act(async () => {
      releaseClientReload();
    });
    await waitFor(() => expect(mocks.refetchPlugins).toHaveBeenCalledOnce());
    expect(result.current.reloadRejectedPending).toBe(true);

    await act(async () => {
      await result.current.reloadRejectedPlugin();
    });
    expect(mocks.reloadPlugins).toHaveBeenCalledOnce();

    await act(async () => {
      releaseCollectionReload();
      await first;
    });
    expect(result.current.reloadRejectedPending).toBe(false);
  });

  test('uses host approval copy only for trusted pending permissions', () => {
    expect(
      consentFailureMessage('Provider Kit', [
        { tier: 'trusted' },
        { tier: 'active' },
      ]),
    ).toBe(
      "Provider Kit is installed but requires host approval before it is ready. Open Plugins, select it, and choose Review Permissions when you're ready.",
    );
    expect(consentFailureMessage('Network Kit', [{ tier: 'active' }])).toBe(
      'Network Kit was installed, but required permissions were not approved.',
    );
  });

  test.each([
    {
      status: 'completed',
      expected:
        'Make network requests through the server was removed and its runtime capability is retired.',
      actionLabel: undefined,
    },
    {
      status: 'winding-down',
      expected:
        'Make network requests through the server was removed. Existing work is still winding down. Cleanup operation operation-1.',
      actionLabel: 'Check cleanup',
    },
    {
      status: 'incomplete',
      expected:
        'Make network requests through the server was removed, but runtime cleanup is incomplete.',
      actionLabel: 'Retry cleanup',
    },
  ] as const)(
    'reports $status runtime revocation truth',
    async ({ status, expected, actionLabel }) => {
      mocks.revokePermission.mockResolvedValueOnce({
        granted: [],
        reconciliation:
          status === 'completed'
            ? { status, effects: [] }
            : status === 'winding-down'
              ? { status, operationId: 'operation-1', generation: 1 }
              : { status, failures: ['provider-retirement'] },
      });
      const { result } = renderHook(() => usePluginManagementViewModel());

      await act(() =>
        result.current.revokePermission('plugin-a', 'network.fetch'),
      );

      expect(result.current.message).toMatchObject({
        type: 'success',
        text: expected,
      });
      expect(result.current.message?.action?.label).toBe(actionLabel);
    },
  );

  test('offers an actionable retry after incomplete runtime cleanup', async () => {
    mocks.revokePermission
      .mockResolvedValueOnce({
        granted: [],
        reconciliation: {
          status: 'incomplete',
          operationId: 'operation-incomplete',
          generation: 1,
          failures: ['provider-retirement'],
        },
      })
      .mockResolvedValueOnce({
        granted: [],
        reconciliation: { status: 'completed', effects: [] },
      });
    const { result } = renderHook(() => usePluginManagementViewModel());
    await act(() =>
      result.current.revokePermission('plugin-a', 'providers.register'),
    );

    expect(result.current.message?.action?.label).toBe('Retry cleanup');
    act(() => result.current.message?.action?.invoke());
    await waitFor(() =>
      expect(mocks.revokePermission).toHaveBeenCalledTimes(2),
    );
    expect(mocks.revokePermission).toHaveBeenLastCalledWith({
      name: 'plugin-a',
      permissions: ['providers.register'],
    });
  });

  /**
   * archive#4288. Everything below drives the real sequence: preview, then
   * decide, then — only then — install. The preview payload is what the
   * server now returns; the decision is assembled from it, never invented by
   * the client.
   */
  const PREVIEW = {
    valid: true,
    manifest: {
      name: 'network-kit',
      displayName: 'Network Kit',
      version: '1.0.0',
      hasBundle: true,
    },
    components: [],
    conflicts: [],
    dependencies: [{ id: 'shared-lib', status: 'will-install' }],
    contentDigest: 'sha256:reviewed',
    permissions: {
      required: ['navigation.dock', 'network.fetch'],
      autoGranted: ['navigation.dock'],
      pendingConsent: [{ permission: 'network.fetch', tier: 'active' }],
    },
  };

  async function primePreview(
    result: { current: ReturnType<typeof usePluginManagementViewModel> },
    preview: Record<string, unknown> = PREVIEW,
  ) {
    act(() => {
      result.current.setInstallSourceAndReset('/tmp/network-kit');
    });
    await act(async () => {
      await result.current.install();
    });
    act(() => {
      mocks.previewOnSuccess?.(preview);
    });
  }

  test('missing installed plugin details remain unknown and cannot prompt from preview identity', async () => {
    mocks.requestInstallConsent.mockResolvedValue(true);
    const { result } = renderHook(() => usePluginManagementViewModel());
    await primePreview(result);
    await act(async () => {
      await result.current.install([]);
    });
    await act(async () => {
      await mocks.installOnSuccess?.({
        permissions: {
          pendingConsent: [{ permission: 'network.fetch', tier: 'active' }],
        },
      });
    });
    expect(mocks.requestConsent).not.toHaveBeenCalled();
    expect(result.current.message?.text).toContain(
      'did not return installed plugin details',
    );
    expect(mocks.reloadPlugins).toHaveBeenCalledOnce();
    expect(mocks.reloadClientRegistry).toHaveBeenCalledOnce();
  });

  /**
   * ACCEPTANCE 1 and 2 at the client. Declining does not reach the server at
   * all — there is no install request to leave anything behind, which is what
   * "a declined install leaves nothing" means from here.
   */
  test('asks before installing, and a decline never sends an install request', async () => {
    mocks.requestInstallConsent.mockResolvedValue(false);
    const { result } = renderHook(() => usePluginManagementViewModel());
    await primePreview(result);

    await act(async () => {
      await result.current.install([]);
    });

    expect(mocks.requestInstallConsent).toHaveBeenCalledWith(
      'network-kit',
      'Network Kit',
      [{ permission: 'network.fetch', tier: 'active' }],
    );
    expect(mocks.installMutate).not.toHaveBeenCalled();
    expect(result.current.message).toEqual({
      type: 'success',
      text: 'Network Kit was not installed. Nothing was added or changed.',
    });
  });

  test('carries the reviewed permission set, digest and dependencies into the install', async () => {
    mocks.requestInstallConsent.mockResolvedValue(true);
    const { result } = renderHook(() => usePluginManagementViewModel());
    await primePreview(result);

    await act(async () => {
      await result.current.install([]);
    });

    expect(mocks.installMutate).toHaveBeenCalledTimes(1);
    expect(mocks.installMutate.mock.calls[0][0]).toEqual({
      source: '/tmp/network-kit',
      skip: [],
      consent: {
        permissions: ['navigation.dock', 'network.fetch'],
        contentDigest: 'sha256:reviewed',
        dependencies: ['shared-lib'],
      },
    });
    // The order matters more than the payload: the prompt resolved before the
    // mutation was dispatched, which is the whole defect this closes.
    expect(
      mocks.requestInstallConsent.mock.invocationCallOrder[0],
    ).toBeLessThan(mocks.installMutate.mock.invocationCallOrder[0]);
  });

  test('names dependency permissions in the decision and carries their byte-bound approval', async () => {
    mocks.requestInstallConsent.mockResolvedValue(true);
    const { result } = renderHook(() => usePluginManagementViewModel());
    await primePreview(result, {
      ...PREVIEW,
      dependencies: [
        {
          id: 'shared-providers',
          status: 'will-install',
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

    await act(async () => {
      await result.current.install([]);
    });

    expect(mocks.requestInstallConsent).toHaveBeenCalledWith(
      'network-kit',
      'Network Kit',
      [
        { permission: 'network.fetch', tier: 'active' },
        {
          permission: 'shared-providers: providers.register',
          tier: 'trusted',
        },
      ],
    );
    expect(mocks.installMutate.mock.calls[0][0].consent).toMatchObject({
      dependencies: ['shared-providers'],
      dependencyApprovals: [
        {
          id: 'shared-providers',
          permissions: ['providers.register'],
          contentDigest: 'sha256:dependency',
          dependencies: [],
        },
      ],
    });
    mocks.requestConsent.mockResolvedValue(true);
    await act(async () => {
      await mocks.installOnSuccess?.({
        plugin: { name: 'network-kit', displayName: 'Network Kit' },
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
      });
    });
    expect(mocks.requestConsent).toHaveBeenCalledWith(
      'shared-providers',
      'shared-providers',
      [{ permission: 'providers.register', tier: 'trusted' }],
    );
  });

  test.each([true, false])(
    'uses installed dependency permission truth (reported=%s), never pending preview state',
    async (reported) => {
      mocks.requestInstallConsent.mockResolvedValue(true);
      const { result } = renderHook(() => usePluginManagementViewModel());
      await primePreview(result, {
        ...PREVIEW,
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
      await act(async () => {
        await result.current.install([]);
      });
      await act(async () => {
        await mocks.installOnSuccess?.({
          plugin: { name: 'network-kit' },
          permissions: {
            pendingConsent: [],
            ...(reported
              ? {
                  dependencies: [
                    { id: 'shared-providers', pendingConsent: [] },
                  ],
                }
              : {}),
          },
        });
      });
      expect(mocks.requestConsent).not.toHaveBeenCalled();
      expect(result.current.message?.text).toContain(
        reported
          ? 'is ready'
          : 'did not report current dependency approval status',
      );
    },
  );

  test('will not install a source it has no preview to approve against', async () => {
    const { result } = renderHook(() => usePluginManagementViewModel());

    act(() => {
      result.current.setInstallSourceAndReset('/tmp/network-kit');
    });
    await act(async () => {
      await result.current.install([]);
    });

    expect(mocks.installMutate).not.toHaveBeenCalled();
    expect(mocks.requestInstallConsent).not.toHaveBeenCalled();
    expect(result.current.installMessage?.text).toMatch(
      /Preview this plugin before installing it/,
    );
  });

  test('installs without a prompt when the preview derived nothing to answer for', async () => {
    const { result } = renderHook(() => usePluginManagementViewModel());
    await primePreview(result, {
      ...PREVIEW,
      dependencies: [],
      permissions: {
        required: ['navigation.dock'],
        autoGranted: ['navigation.dock'],
        pendingConsent: [],
      },
    });

    await act(async () => {
      await result.current.install([]);
    });

    expect(mocks.requestInstallConsent).not.toHaveBeenCalled();
    expect(mocks.installMutate.mock.calls[0][0].consent).toEqual({
      permissions: ['navigation.dock'],
      contentDigest: 'sha256:reviewed',
      dependencies: [],
    });
  });

  /**
   * What survives after the install: the trusted tier. A same-origin click
   * cannot authorize it, so the server leaves it pending and the existing
   * host-approval path runs against the installed tree. Declining THAT leaves
   * an installed plugin, and the message says exactly that.
   */
  test('still routes trusted permissions to host approval after the install', async () => {
    mocks.requestInstallConsent.mockResolvedValue(true);
    mocks.requestConsent.mockResolvedValue(false);
    const { result } = renderHook(() => usePluginManagementViewModel());
    await primePreview(result, {
      ...PREVIEW,
      permissions: {
        required: ['navigation.dock', 'plugin.server'],
        autoGranted: ['navigation.dock'],
        pendingConsent: [{ permission: 'plugin.server', tier: 'trusted' }],
      },
    });

    await act(async () => {
      await result.current.install([]);
    });
    expect(mocks.installOnSuccess).toBeTruthy();

    await act(async () => {
      await mocks.installOnSuccess?.({
        plugin: { name: 'network-kit', displayName: 'Network Kit' },
        permissions: {
          pendingConsent: [{ permission: 'plugin.server', tier: 'trusted' }],
        },
      });
    });

    await waitFor(() => {
      expect(result.current.message).toEqual({
        type: 'error',
        text: "Network Kit is installed but requires host approval before it is ready. Open Plugins, select it, and choose Review Permissions when you're ready.",
      });
    });
    expect(mocks.requestConsent).toHaveBeenCalledWith(
      'network-kit',
      'Network Kit',
      [{ permission: 'plugin.server', tier: 'trusted' }],
    );
  });
});

describe('InstallPreviewModal', () => {
  test('keeps non-skippable Pane declarations checked and disables their toggle', () => {
    const onToggleSkip = vi.fn();
    render(
      <InstallPreviewModal
        previewData={{
          valid: true,
          manifest: {
            name: 'review-plugin',
            displayName: 'Review Plugin',
            version: '1.0.0',
            hasBundle: true,
          },
          components: [
            {
              type: 'pane',
              id: 'shared-review',
              skippable: false,
              conflict: {
                type: 'pane',
                id: 'shared-review',
                existingSource: 'builtin',
              },
            },
          ],
          conflicts: [
            {
              type: 'pane',
              id: 'shared-review',
              existingSource: 'builtin',
            },
          ],
        }}
        previewSkips={new Set(['pane:shared-review'])}
        installPending={false}
        onClose={vi.fn()}
        onToggleSkip={onToggleSkip}
        onConfirm={vi.fn()}
      />,
    );
    const checkbox = screen.getByRole('checkbox', {
      name: /paneshared-review/i,
    });
    expect((checkbox as HTMLInputElement).checked).toBe(true);
    expect((checkbox as HTMLInputElement).disabled).toBe(true);
    fireEvent.click(checkbox);
    expect(onToggleSkip).not.toHaveBeenCalled();
    expect(
      (
        screen.getByRole('button', {
          name: 'Confirm Install',
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
    expect(screen.getByText(/Required package declaration/)).toBeTruthy();
  });
});
