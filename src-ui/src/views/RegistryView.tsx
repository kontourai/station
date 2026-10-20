import {
  type RegistryCatalogTab,
  useInstalledRegistryItemsQuery,
  useInvalidateQuery,
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
import { Button } from '../components/Button';
import { KitCatalog } from '../components/registry/KitCatalog';
import { MarketplaceSources } from '../components/registry/MarketplaceSources';
import {
  getRegistryItemId,
  RegistryCatalog,
  type RegistryItem,
} from '../components/registry/RegistryCatalog';
import {
  layoutActionSuccessVerb,
  type RegistryLayoutAction,
} from '../components/registry/RegistryLayoutActions';
import { getRegistrySkillInstallRefusal } from '../components/registry/registryCatalogModel';
import {
  StationExtensionsAccess,
  useStationExtensionsAccess,
} from '../components/registry/StationExtensionsAccess';
import { useNavigation } from '../contexts/NavigationContext';
import { useToast } from '../contexts/ToastContext';
import { useShowSurface } from '../contexts/useShowSurface';
import { usePermissions } from '../core/PermissionManager';
import { pluginRegistry } from '../core/PluginRegistry';
import { AgentToolCatalog } from './agent-editor/AgentToolCatalog';
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
  toolPicker = false,
  onInstalled,
  installTarget,
}: {
  initialTab?: RegistryCatalogTab;
  toolPicker?: boolean;
  onInstalled?: () => void;
  installTarget?: string;
} = {}) {
  const { navigate } = useNavigation();
  const { showToast } = useToast();
  // #928 C2a: "Open a Project" means Home by name; reveal the surface.
  const showSurface = useShowSurface();
  const invalidateQuery = useInvalidateQuery();
  const extensionAccess = useStationExtensionsAccess();
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
    if (!toolPicker) navigate(`/registry/${tab}`);
  };
  const [message, setMessage] = useState<string | null>(null);
  const [search, setSearch] = useState(installTarget ?? '');
  const [selectedSource, setSelectedSource] = useState('all');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [inspectedSelection, setInspectedSelection] = useState<{
    tab: RegistryCatalogTab;
    item: RegistryItem;
  } | null>(null);
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
  const {
    data: availableData,
    error: availableError,
    isLoading: loadingAvailable,
    dataUpdatedAt: availableUpdatedAt,
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
  useEffect(() => {
    if (availableUpdatedAt || availableError)
      void invalidateQuery(['registry', 'sources']);
  }, [availableError, availableUpdatedAt, invalidateQuery]);
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
    const items =
      selectedSource === 'all'
        ? available
        : available.filter((item) => item.catalog?.sourceId === selectedSource);
    if (!query) return items;
    return items.filter((item) =>
      [
        getRegistryItemId(item),
        item.displayName,
        item.description,
        item.source,
        item.version,
      ].some((value) => value?.toLowerCase().includes(query)),
    );
  }, [available, search, selectedSource]);
  const selectedItem = useMemo(() => {
    if (inspectedSelection?.tab === activeTab) return inspectedSelection.item;
    if (filtered.length === 0) return null;
    return (
      filtered.find((item) => getRegistryItemId(item) === selectedId) ??
      filtered[0]
    );
  }, [filtered, selectedId, inspectedSelection, activeTab]);

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
    /**
     * How the outcome is reported. The default is the page's inline row; a
     * plugin install passes the shared toast instead (#1536 G7) — a grey
     * inline bar reading "Installed Getting Started Starter" sat directly
     * above the catalog and read as another result rather than as the answer
     * to what had just been asked for.
     */
    reportSuccess?: () => void,
  ) => ({
    onError: (error: Error) => setMessage(error.message),
    onSuccess: () => {
      if (!isInstalled && tab === 'integrations') onInstalled?.();
      const installationKey = registryInstallationKey(tab, itemId);
      setInstallationOverrides((current) => {
        const next = new Map(current);
        next.set(installationKey, !isInstalled);
        return next;
      });
      if (reportSuccess) {
        reportSuccess();
      } else {
        setMessage(
          `${isInstalled ? 'Removed' : 'Installed'} ${item.displayName || itemId}`,
        );
      }
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
    const refusal = isInstalled
      ? null
      : getRegistrySkillInstallRefusal(activeTab, item);
    if (refusal) {
      setMessage(refusal);
      return;
    }
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
      pluginMutation.mutate(
        {
          id: isInstalled ? (item.installedPluginName ?? itemId) : itemId,
          action,
        },
        callbacks,
      );
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
    // The installed plugin's own name, which is what selects it in Plugins —
    // a registry id is only the catalog's handle for it.
    const installedPluginName = data.manifest?.name;
    // The preview's own component list is what the modal just showed the
    // operator, and the server derives it from the staged manifest — so the
    // offer to place a layout is made exactly when a layout was reviewed.
    const addsLayout = data.components.some(
      (component) => component.type === 'layout',
    );
    const baseCallbacks = actionCallbacks(tab, item, itemId, false, () => {
      setMessage(null);
      showToast(
        `Installed ${displayName}`,
        undefined,
        undefined,
        // Review L7: named for what it DOES. It navigates to the installed
        // plugin's detail page, where "What it adds" carries the action that
        // actually places the layout (and adds it outright when there is only
        // one project); calling it "Add to project" promised an add this button
        // does not perform.
        addsLayout && installedPluginName
          ? [
              {
                label: 'Open plugin',
                variant: 'primary' as const,
                onClick: () =>
                  navigate(
                    `/plugins/${encodeURIComponent(installedPluginName)}`,
                  ),
              },
            ]
          : undefined,
        'success',
      );
    });
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
        onInstalled?.();
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

  const remoteBundlesSection = <StationExtensionsAccess />;
  const remoteIsolationActive = extensionAccess.blocked;

  return (
    <div className="registry-view">
      {remoteIsolationActive && remoteBundlesSection}
      {pluginRegistryStatus.state === 'degraded' &&
        pluginRegistryStatus.failure !== 'remote-isolation' && (
          <div className="page__message" role="alert">
            <p>
              {pluginRegistryStatus.failedPluginNames.length
                ? `Couldn't load extensions: ${pluginRegistryStatus.failedPluginNames.join(', ')}.`
                : "Couldn't load extensions for this Station."}
            </p>
            <Button onClick={() => void pluginRegistry.reload()}>
              Retry extensions
            </Button>
          </div>
        )}
      {!toolPicker && (
        <MarketplaceSources
          selected={selectedSource}
          onSelect={setSelectedSource}
        />
      )}
      {installTarget ? (
        <div>
          <Button
            variant="primary"
            disabled={
              previewMutation.isPending || mutationPending || !selectedItem
            }
            onClick={() => {
              if (selectedItem)
                runAction(
                  selectedItem,
                  getRegistryItemId(selectedItem),
                  isInstalled(selectedItem, getRegistryItemId(selectedItem)),
                );
            }}
          >
            Review {selectedItem?.displayName || 'tool'} permissions
          </Button>
          {message && <p role="status">{message}</p>}
        </div>
      ) : toolPicker ? (
        <AgentToolCatalog
          tab={activeTab}
          onTab={selectTab}
          search={search}
          onSearch={setSearch}
          source={selectedSource}
          onSource={setSelectedSource}
          items={filtered}
          loading={loadingAvailable && availableData === undefined}
          error={availableError as Error | null}
          message={message}
          installed={isInstalled}
          pendingId={
            previewMutation.isPending ? previewMutation.variables : pendingId
          }
          pending={mutationPending || previewMutation.isPending}
          onInstall={runAction}
        />
      ) : (
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
            select: (id) => {
              setSelectedId(id);
              const item = available.find(
                (item) => getRegistryItemId(item) === id,
              );
              if (item) setInspectedSelection({ tab: activeTab, item });
            },
            runAction,
            runLayoutAction,
            onUseLayout: (id) => {
              setSelectedId(id);
              setMessage(
                'Choose a project, then select Add Layout to apply this ready layout.',
              );
            },
            openSkill: (name) =>
              navigate(`/guidance/${encodeURIComponent(name)}`, {
                tab: 'skills',
              }),
            manageSkills: () => navigate('/guidance?tab=skills'),
            managePlugins: () => {
              if (!toolPicker) navigate('/plugins');
            },
            openProjects: () => showSurface('home'),
            retryInstalled: () => {
              void refetchInstalled();
            },
            renderKits: () => <KitCatalog />,
          }}
        />
      )}
      {!remoteIsolationActive && remoteBundlesSection}
      {pluginInstallPreview && (
        <InstallPreviewModal
          previewData={pluginInstallPreview.data}
          extensionAccess={
            pluginInstallPreview.data.manifest?.hasBundle ||
            pluginInstallPreview.data.manifest?.workspacePanes?.length ||
            pluginInstallPreview.data.components.some(
              (component) => component.type === 'layout',
            ) ? (
              <StationExtensionsAccess onlyWhenOff installation />
            ) : undefined
          }
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
    </div>
  );
}
