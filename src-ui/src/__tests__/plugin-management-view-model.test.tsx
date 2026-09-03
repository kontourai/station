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
        plugin: { name: string; displayName?: string; agents?: unknown[] };
        permissions?: {
          pendingConsent?: Array<{ permission: string; tier: string }>;
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
  refetchPlugins: vi.fn(),
  previewOnSuccess: null as ((data: unknown) => void) | null,
}));

vi.mock('@tanstack/react-query', () => ({
  useQueryClient: () => mocks.queryClient,
}));

vi.mock('../contexts/ApiBaseContext', () => ({
  useApiBase: () => ({ apiBase: 'http://api.test' }),
}));

vi.mock('../contexts/NavigationContext', () => ({
  useNavigation: () => ({ setLayout: vi.fn() }),
}));

vi.mock('../contexts/ProjectsContext', () => ({
  useProjects: () => ({ projects: [] }),
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
    selectedId: null,
    select: vi.fn(),
    deselect: vi.fn(),
  }),
}));

vi.mock('@kontourai/station-sdk', () => ({
  useAddProjectLayoutFromPluginMutation: () => ({ mutateAsync: vi.fn() }),
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
    data: [],
    error: mocks.pluginsError,
    isLoading: false,
    refetch: mocks.refetchPlugins,
  }),
  usePluginUpdateMutation: () => ({ mutate: vi.fn() }),
  usePluginUpdatesQuery: () => ({ data: [] }),
  useReloadPluginsMutation: () => ({
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
    mocks.reloadClientRegistry.mockReset().mockResolvedValue(undefined);
    mocks.revokePermission.mockReset().mockResolvedValue({
      granted: [],
      reconciliation: { status: 'completed', effects: [] },
    });
    mocks.installOnSuccess = null;
    mocks.pluginsError = undefined;
    mocks.refetchPlugins.mockReset();
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
    },
    {
      status: 'winding-down',
      expected:
        'Make network requests through the server was removed. Existing work is still winding down.',
    },
    {
      status: 'incomplete',
      expected:
        'Make network requests through the server was removed, but runtime cleanup is incomplete. Retry the removal to reconcile it again.',
    },
  ] as const)(
    'reports $status runtime revocation truth',
    async ({ status, expected }) => {
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

      expect(result.current.message).toEqual({
        type: 'success',
        text: expected,
      });
    },
  );

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
