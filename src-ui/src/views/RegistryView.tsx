import {
  type RegistryCatalogTab,
  useInstalledRegistryItemsQuery,
  useInvalidateQuery,
  useRegistryIntegrationActionMutation,
  useRegistryItemsQuery,
  useRegistryLayoutActionMutation,
  useRegistrySkillActionMutation,
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
import { useShowSurface } from '../contexts/useShowSurface';
import { pluginRegistry } from '../core/PluginRegistry';
import { AgentToolCatalog } from './agent-editor/AgentToolCatalog';
import { usePluginCatalogInstall } from './plugin-management/usePluginCatalogInstall';
import './PluginManagementView.css';
import './RegistryView.css';
import './page-layout.css';

/** The source kinds the catalogue tabs on this page list. */
const REGISTRY_PAGE_SOURCE_KINDS = ['skills', 'agents'] as const;

function registryInstallationKey(tab: RegistryCatalogTab, itemId: string) {
  return `${tab}:${itemId}`;
}

/**
 * A source chosen together with a switch to its catalog tab. The route
 * boundary keys this view by route (`RouteViewBoundary`), so the tab switch
 * remounts it; the choice is handed to that next mount, for that tab only.
 */
let sourceForNextTab: { tab: RegistryCatalogTab; source: string } | null = null;

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
  // The route remounts this view for each tab (`RouteViewBoundary` keys by
  // route), so the chosen source is handed to the next mount: browsing a
  // source keeps it across tabs.
  const selectTab = (
    tab: RegistryCatalogTab,
    source: string = selectedSource,
  ) => {
    setActiveTab(tab);
    if (!toolPicker) {
      sourceForNextTab = { tab, source };
      navigate(`/registry/${tab}`);
    }
  };
  const [message, setMessage] = useState<string | null>(null);
  const [search, setSearch] = useState(installTarget ?? '');
  const [selectedSource, setSelectedSource] = useState(() => {
    const handed = sourceForNextTab;
    sourceForNextTab = null;
    return handed && handed.tab === (initialTab ?? 'agents')
      ? handed.source
      : 'all';
  });
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [inspectedSelection, setInspectedSelection] = useState<{
    tab: RegistryCatalogTab;
    item: RegistryItem;
  } | null>(null);
  const [installationOverrides, setInstallationOverrides] = useState(
    () => new Map<string, boolean>(),
  );
  const pluginRegistryStatus = useSyncExternalStore(
    pluginRegistry.subscribe,
    pluginRegistry.getLoadStatus,
  );
  const {
    data: availableData,
    error: availableError,
    isLoading: loadingAvailable,
    dataUpdatedAt: availableUpdatedAt,
    refetch: refetchAvailable,
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
  const integrationMutation = useRegistryIntegrationActionMutation();
  const skillMutation = useRegistrySkillActionMutation();
  const layoutMutation = useRegistryLayoutActionMutation();
  const {
    startInstall,
    previewMutation,
    agentMutation,
    pluginMutation,
    modal: pluginInstallModal,
  } = usePluginCatalogInstall({
    // Read when an install settles, after `actionCallbacks` below exists.
    actionCallbacks: (...args) => actionCallbacks(...args),
    setMessage,
    onInstalled,
  });

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
      startInstall(activeTab, item, itemId);
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
          onSelect={(id, _kind, supplied) => {
            setSelectedSource(id);
            // Show the chosen source's catalog: keep the tab when the source
            // supplies it, otherwise open its first kind this page lists.
            // Plugins are browsed in Apps › Discover, not here.
            const tabs: readonly RegistryCatalogTab[] = (supplied ?? []).filter(
              (tab) => tab !== 'plugins',
            );
            if (tabs.length > 0 && !tabs.includes(activeTab))
              selectTab(tabs[0]!, id);
          }}
          // A source that only supplies plugins has nothing on these tabs.
          kinds={REGISTRY_PAGE_SOURCE_KINDS}
          manage="dialog"
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
              if (!toolPicker) navigate('/apps/library');
            },
            openProjects: () => showSurface('home'),
            retryInstalled: () => {
              void refetchInstalled();
            },
            retryCatalog: () => {
              void refetchAvailable();
            },
            renderKits: () => <KitCatalog />,
          }}
        />
      )}
      {!remoteIsolationActive && remoteBundlesSection}
      {pluginInstallModal}
    </div>
  );
}
