import { useConnections } from '@kontourai/station-connect';
import {
  type RegistryCatalogTab,
  useInstalledRegistryItemsQuery,
  usePluginRegistryInstallMutation,
  usePluginRegistryPreviewMutation,
  useRegistryAgentActionMutation,
  useRegistryIntegrationActionMutation,
  useRegistryItemsQuery,
  useRegistryLayoutActionMutation,
  useRegistrySkillActionMutation,
  useReloadPluginsMutation,
} from '@kontourai/station-sdk';
import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { ConfirmModal } from '../components/modals/ConfirmModal';
import { KitCatalog } from '../components/registry/KitCatalog';
import {
  getRegistryItemId,
  RegistryCatalog,
  type RegistryItem,
} from '../components/registry/RegistryCatalog';
import {
  layoutActionSuccessVerb,
  type RegistryLayoutAction,
} from '../components/registry/RegistryLayoutActions';
import { useApiBase } from '../contexts/ApiBaseContext';
import { useNavigation } from '../contexts/NavigationContext';
import { useShowSurface } from '../contexts/useShowSurface';
import { usePermissions } from '../core/PermissionManager';
import { pluginRegistry } from '../core/PluginRegistry';
import {
  reloadAfterRemotePluginBundleRevoke,
  remotePluginBundlesAllowed,
  setRemotePluginBundlesAllowed,
  subscribeRemotePluginBundleConsent,
} from '../core/remotePluginBundleConsent';
import { usePlatformProfile } from '../platform/PlatformProfileContext';
import { InstallPreviewModal } from './plugin-management/InstallPreviewModal';
import {
  installedDependencyPermissions,
  type PreviewData,
} from './plugin-management/types';
import './PluginManagementView.css';
import './RegistryView.css';
import './page-layout.css';

function registryInstallationKey(tab: RegistryCatalogTab, itemId: string) {
  return `${tab}:${itemId}`;
}

export function RegistryView({
  initialTab,
}: {
  initialTab?: RegistryCatalogTab;
} = {}) {
  const { navigate } = useNavigation();
  // #928 C2a: "Open a Project" means Home by name; reveal the surface.
  const showSurface = useShowSurface();
  const { isTauri } = usePlatformProfile();
  const { apiBase } = useApiBase();
  const { activeConnection } = useConnections();
  const activeConnectionId = activeConnection?.id ?? 'default';
  const [activeTab, setActiveTab] = useState<RegistryCatalogTab>(
    initialTab ?? 'agents',
  );
  // The URL is authoritative: Back/Forward (or any in-app navigation that
  // changes /registry/:tab while this view stays mounted) must re-sync the
  // rendered tab — initializer-only state desyncs on popstate (archive#2678).
  useEffect(() => {
    setActiveTab(initialTab ?? 'agents');
  }, [initialTab]);
  const selectTab = (tab: RegistryCatalogTab) => {
    setActiveTab(tab);
    navigate(`/registry/${tab}`);
  };
  const [message, setMessage] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [remoteBundleModal, setRemoteBundleModal] = useState<
    'enable' | 'disable' | null
  >(null);
  const [installationOverrides, setInstallationOverrides] = useState(
    () => new Map<string, boolean>(),
  );
  // A registry entry that resolves as a PLUGIN is installed the way the
  // Plugins view installs one (archive#4288): preview the resolved source,
  // take the operator's decision on what the preview found, and send that
  // decision with the install. Without it the server refuses any plugin that
  // contributes code — refusing is the honest no-decision behavior; the old
  // one-click path materialized the plugin tree without ever building its
  // bundle, so its layout components could never register (#765 D1).
  const [pluginInstallPreview, setPluginInstallPreview] = useState<{
    tab: RegistryCatalogTab;
    item: RegistryItem;
    itemId: string;
    data: PreviewData;
  } | null>(null);
  const [previewSkips, setPreviewSkips] = useState<Set<string>>(
    () => new Set(),
  );
  const previewMutation = usePluginRegistryPreviewMutation();
  const reloadPluginsMutation = useReloadPluginsMutation();
  const { requestConsent, requestInstallConsent } = usePermissions();
  const pluginRegistryStatus = useSyncExternalStore(
    pluginRegistry.subscribe,
    pluginRegistry.getLoadStatus,
  );
  const remoteBundlesAllowed = useSyncExternalStore(
    subscribeRemotePluginBundleConsent,
    () => remotePluginBundlesAllowed(activeConnectionId, apiBase),
  );
  const {
    data: availableData,
    error: availableError,
    isLoading: loadingAvailable,
  } = useRegistryItemsQuery<RegistryItem>(
    activeTab === 'kits' ? 'agents' : activeTab,
    { enabled: activeTab !== 'kits' },
  );
  const {
    data: installedData,
    error: installedError,
    isLoading: loadingInstalled,
    refetch: refetchInstalled,
  } = useInstalledRegistryItemsQuery<RegistryItem>(
    activeTab === 'kits' ? 'agents' : activeTab,
    { enabled: activeTab !== 'kits' },
  );
  const available = availableData ?? [];
  const installed = installedData ?? [];
  const agentMutation = useRegistryAgentActionMutation();
  const integrationMutation = useRegistryIntegrationActionMutation();
  const pluginMutation = usePluginRegistryInstallMutation();
  const skillMutation = useRegistrySkillActionMutation();
  const layoutMutation = useRegistryLayoutActionMutation();

  const installedIds = useMemo(
    () => new Set(installed.map(getRegistryItemId)),
    [installed],
  );
  const isInstalled = (item: RegistryItem, itemId: string) => {
    const override = installationOverrides.get(
      registryInstallationKey(activeTab, itemId),
    );
    return override ?? (installedIds.has(itemId) || !!item.installed);
  };
  const filtered = useMemo(() => {
    const query = search.trim().toLowerCase();
    if (!query) return available;
    return available.filter((item) =>
      [
        getRegistryItemId(item),
        item.displayName,
        item.description,
        item.source,
        item.version,
      ].some((value) => value?.toLowerCase().includes(query)),
    );
  }, [available, search]);
  const selectedItem = useMemo(() => {
    if (filtered.length === 0) return null;
    return (
      filtered.find((item) => getRegistryItemId(item) === selectedId) ??
      filtered[0]
    );
  }, [filtered, selectedId]);

  useEffect(() => {
    if (filtered.length === 0) {
      setSelectedId(null);
    } else if (!selectedItem) {
      setSelectedId(getRegistryItemId(filtered[0]));
    }
  }, [filtered, selectedItem]);

  const selectedItemId = selectedItem ? getRegistryItemId(selectedItem) : null;
  const selectedInstalled = selectedItem
    ? isInstalled(selectedItem, selectedItemId ?? '')
    : false;
  const pendingId =
    activeTab === 'agents'
      ? agentMutation.variables?.id
      : activeTab === 'skills'
        ? skillMutation.variables?.id
        : activeTab === 'integrations'
          ? integrationMutation.variables?.id
          : activeTab === 'layouts'
            ? layoutMutation.variables?.id
            : pluginMutation.variables?.id;
  const mutationPending =
    activeTab === 'agents'
      ? agentMutation.isPending
      : activeTab === 'skills'
        ? skillMutation.isPending
        : activeTab === 'integrations'
          ? integrationMutation.isPending
          : activeTab === 'layouts'
            ? layoutMutation.isPending
            : pluginMutation.isPending;

  const runLayoutAction = (
    item: RegistryItem,
    itemId: string,
    action: RegistryLayoutAction,
  ) => {
    setMessage(null);
    layoutMutation.mutate(
      { id: itemId, action },
      {
        onError: (error: Error) => setMessage(error.message),
        onSuccess: () =>
          setMessage(
            `${layoutActionSuccessVerb(action)} ${item.name || itemId}`,
          ),
      },
    );
  };

  const actionCallbacks = (
    tab: RegistryCatalogTab,
    item: RegistryItem,
    itemId: string,
    isInstalled: boolean,
  ) => ({
    onError: (error: Error) => setMessage(error.message),
    onSuccess: () => {
      const installationKey = registryInstallationKey(tab, itemId);
      setInstallationOverrides((current) => {
        const next = new Map(current);
        next.set(installationKey, !isInstalled);
        return next;
      });
      setMessage(
        `${isInstalled ? 'Removed' : 'Installed'} ${item.displayName || itemId}`,
      );
      void refetchInstalled().finally(() => {
        setInstallationOverrides((current) => {
          const next = new Map(current);
          next.delete(installationKey);
          return next;
        });
      });
    },
  });

  const runAction = (
    item: RegistryItem,
    itemId: string,
    isInstalled: boolean,
  ) => {
    const action = isInstalled ? 'uninstall' : 'install';
    // Installing a registry entry the plugin registry resolves starts at the
    // preview, exactly like the Plugins view: the decision the server needs
    // is about the previewed bytes, so there is nothing honest to send until
    // the preview has been shown. The server is the authority on which ids
    // are plugins — an agent-face entry it cannot resolve answers
    // `registry-plugin-not-found` and keeps the plain agent install path.
    if (
      action === 'install' &&
      (activeTab === 'agents' || activeTab === 'plugins')
    ) {
      const tab = activeTab;
      setMessage(null);
      // A failed preview is terminal mutation state, not a disabled install
      // action. Clear it before each attempt so the selected-card entry point
      // remains live after a refusal, transport error, or malformed response.
      previewMutation.reset();
      previewMutation.mutate(itemId, {
        onSuccess: (data: PreviewData & { code?: string }) => {
          if (data.code === 'registry-plugin-not-found' && tab === 'agents') {
            agentMutation.mutate(
              { id: itemId, action },
              actionCallbacks(tab, item, itemId, isInstalled),
            );
            return;
          }
          if (
            !data.valid ||
            !data.contentDigest ||
            !data.permissions ||
            !Array.isArray(data.components) ||
            !Array.isArray(data.conflicts)
          ) {
            setMessage(
              data.error ||
                `Could not preview ${item.displayName || itemId} before install`,
            );
            return;
          }
          setPreviewSkips(
            new Set(
              data.conflicts.map((conflict) => {
                return `${conflict.type}:${conflict.id}`;
              }),
            ),
          );
          setPluginInstallPreview({ tab, item, itemId, data });
        },
        onError: (error: Error) => setMessage(error.message),
      });
      return;
    }
    const callbacks = actionCallbacks(activeTab, item, itemId, isInstalled);
    if (activeTab === 'agents') {
      agentMutation.mutate({ id: itemId, action }, callbacks);
    } else if (activeTab === 'skills') {
      skillMutation.mutate({ id: itemId, action }, callbacks);
    } else if (activeTab === 'integrations') {
      integrationMutation.mutate({ id: itemId, action }, callbacks);
    } else {
      pluginMutation.mutate({ id: itemId, action }, callbacks);
    }
  };

  const confirmPluginInstall = async () => {
    const preview = pluginInstallPreview;
    if (!preview) return;
    const { data, item, itemId, tab } = preview;
    if (!data.contentDigest || !data.permissions) return;
    const displayName =
      data.manifest?.displayName ||
      data.manifest?.name ||
      item.displayName ||
      itemId;
    const pendingConsent = [
      ...data.permissions.pendingConsent,
      ...(data.dependencies ?? []).flatMap((dependency) =>
        (dependency.consent?.pendingConsent ?? []).map((entry) => ({
          ...entry,
          permission: `${dependency.id}: ${entry.permission}`,
        })),
      ),
    ];
    if (pendingConsent.length > 0) {
      const approved = await requestInstallConsent(
        data.manifest?.name || itemId,
        displayName,
        pendingConsent,
      );
      if (!approved) {
        setPluginInstallPreview(null);
        setMessage(
          `Install declined for ${displayName} — nothing was added or changed.`,
        );
        return;
      }
    }
    setPluginInstallPreview(null);
    const baseCallbacks = actionCallbacks(tab, item, itemId, false);
    const callbacks = {
      onError: baseCallbacks.onError,
      onSuccess: async (result: unknown) => {
        baseCallbacks.onSuccess();
        void pluginRegistry.reload();
        const dependencyStatus = installedDependencyPermissions(result);
        if (
          dependencyStatus === undefined &&
          (data.dependencies?.length ?? 0) > 0
        ) {
          setMessage(
            `${displayName} is installed, but Station did not report current dependency approval status. Check Plugins on the Station host.`,
          );
        }
        for (const dependency of dependencyStatus ?? []) {
          const dependencyPending = dependency.pendingConsent;
          if (dependencyPending.length === 0) continue;
          const approved = await requestConsent(
            dependency.id,
            dependency.id,
            dependencyPending,
          );
          if (!approved) {
            setMessage(
              `${displayName} is installed, but dependency ${dependency.id} still requires host approval.`,
            );
            break;
          }
        }
        await reloadPluginsMutation.mutateAsync().catch((error) => {
          setMessage(
            `Installed ${displayName}, but plugin activation could not be refreshed: ${error instanceof Error ? error.message : 'unknown error'}`,
          );
        });
        // The server announces the install over SSE too; reloading here makes
        // the new layout components register without depending on that
        // connection being up.
        await pluginRegistry.reload();
      },
    };
    const variables = {
      id: itemId,
      action: 'install' as const,
      consent: {
        registryTrustRevision: data.registryTrustRevision,
        ...(data.grantRevision !== undefined
          ? { grantRevision: data.grantRevision }
          : {}),
        permissions: data.permissions.required,
        contentDigest: data.contentDigest,
        dependencies: (data.dependencies ?? []).map(
          (dependency) => dependency.id,
        ),
        ...((data.dependencies ?? []).some((dependency) => dependency.consent)
          ? {
              dependencyApprovals: (data.dependencies ?? []).flatMap(
                (dependency) =>
                  dependency.consent
                    ? [
                        {
                          id: dependency.id,
                          registryTrustRevision:
                            dependency.consent.registryTrustRevision,
                          ...(dependency.consent.grantRevision !== undefined
                            ? {
                                grantRevision: dependency.consent.grantRevision,
                              }
                            : {}),
                          permissions: dependency.consent.permissions,
                          contentDigest: dependency.consent.contentDigest,
                          dependencies: dependency.consent.dependencies,
                        },
                      ]
                    : [],
              ),
            }
          : {}),
      },
      skip: Array.from(previewSkips),
    };
    if (tab === 'agents') {
      agentMutation.mutate(variables, callbacks);
    } else {
      pluginMutation.mutate(variables, callbacks);
    }
  };

  const remoteBundlesSection = remoteBundlesAllowed ? (
    <div className="page__message" role="status">
      Remote extensions enabled for this Station on this device via security
      override.{' '}
      <button type="button" onClick={() => setRemoteBundleModal('disable')}>
        Disable remote extensions
      </button>
    </div>
  ) : pluginRegistryStatus.failure === 'remote-isolation' ? (
    <div className="page__message" role="status">
      Extensions are off for this remote Station on this device.{' '}
      <button type="button" onClick={() => setRemoteBundleModal('enable')}>
        Enable remote extensions for this Station…
      </button>
    </div>
  ) : null;
  // Elevation is keyed to the ACTIVE refusal: once consent is granted, the
  // stale 'remote-isolation' status can linger until the reload completes,
  // and the enabled-override row must not jump above the catalog then.
  const remoteIsolationActive =
    pluginRegistryStatus.failure === 'remote-isolation' &&
    !remoteBundlesAllowed;

  return (
    <div className="registry-view">
      {remoteIsolationActive && remoteBundlesSection}
      <RegistryCatalog
        model={{
          activeTab,
          search,
          message,
          isLoading: loadingAvailable && availableData === undefined,
          loadError: availableError as Error | null,
          isCheckingInstalled:
            (loadingInstalled && installedData === undefined) ||
            !!installedError,
          installedStatusError: installedError as Error | null,
          available,
          filtered,
          installedIds,
          installationOverrides,
          selectedItem,
          selectedItemId,
          selectedInstalled,
          selectedActionPending:
            (mutationPending && pendingId === selectedItemId) ||
            (previewMutation.isPending &&
              previewMutation.variables === selectedItemId),
          layoutPendingId: layoutMutation.variables?.id,
          layoutPending: layoutMutation.isPending,
        }}
        actions={{
          setActiveTab: selectTab,
          setSearch,
          clearMessage: () => setMessage(null),
          select: setSelectedId,
          runAction,
          runLayoutAction,
          onUseLayout: (id) => {
            setSelectedId(id);
            setMessage(
              'Choose a project, then select Add Layout to apply this ready layout.',
            );
          },
          manageSkills: () => navigate('/guidance?tab=skills'),
          managePlugins: () => navigate('/plugins'),
          openProjects: () => showSurface('home'),
          retryInstalled: () => {
            void refetchInstalled();
          },
          renderKits: () => <KitCatalog />,
        }}
      />
      {!remoteIsolationActive && remoteBundlesSection}
      {pluginInstallPreview && (
        <InstallPreviewModal
          previewData={pluginInstallPreview.data}
          previewSkips={previewSkips}
          installPending={agentMutation.isPending || pluginMutation.isPending}
          onClose={() => setPluginInstallPreview(null)}
          onToggleSkip={(key) =>
            setPreviewSkips((current) => {
              const next = new Set(current);
              if (next.has(key)) {
                next.delete(key);
              } else {
                next.add(key);
              }
              return next;
            })
          }
          onConfirm={() => void confirmPluginInstall()}
        />
      )}
      <ConfirmModal
        isOpen={remoteBundleModal === 'enable'}
        title="Enable remote extensions?"
        message={`Remote plugin code will run with this entire app's authority, including other Stations' data, credentials reachable from this window, and these consent settings.${isTauri ? " On this device that includes the native bridge and this device's paired Station credentials." : ''} The toggle is stored per Station on this device, but the trust granted is app-wide. Enable this only for a Station server you fully control or trust.`}
        confirmLabel="Enable remote extensions"
        cancelLabel="Cancel"
        variant="warning"
        onConfirm={() => {
          if (
            setRemotePluginBundlesAllowed(activeConnectionId, apiBase, true)
          ) {
            setRemoteBundleModal(null);
          } else {
            setMessage("Couldn't enable — storage is unavailable.");
          }
        }}
        onCancel={() => setRemoteBundleModal(null)}
      />
      <ConfirmModal
        isOpen={remoteBundleModal === 'disable'}
        title="Disable remote extensions?"
        message="This disables remote extensions for this Station on this device. Already-executed bundle code cannot be unloaded, so Station will reload this window now."
        confirmLabel="Disable and reload"
        cancelLabel="Cancel"
        variant="warning"
        onConfirm={() => {
          if (
            setRemotePluginBundlesAllowed(activeConnectionId, apiBase, false)
          ) {
            reloadAfterRemotePluginBundleRevoke();
          } else {
            setMessage(
              "Couldn't disable — storage is unavailable; remote extensions remain enabled",
            );
          }
        }}
        onCancel={() => setRemoteBundleModal(null)}
      />
    </div>
  );
}
