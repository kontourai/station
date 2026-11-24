import {
  type RegistryCatalogTab,
  useInstalledRegistryItemsQuery,
  useInvalidateQuery,
  useRegistryIntegrationActionMutation,
  useRegistryItemsQuery,
  useRegistryLayoutActionMutation,
  useRegistrySkillActionMutation,
} from '@kontourai/station-sdk';
import { useEffect, useMemo, useState } from 'react';
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
import { useNavigation } from '../contexts/NavigationContext';
import { AgentToolCatalog } from './agent-editor/AgentToolCatalog';
import { usePluginCatalogInstall } from './plugin-management/usePluginCatalogInstall';
import './PluginManagementView.css';
import './RegistryView.css';
import './page-layout.css';

/**
 * The source kind each catalogue page lists sources of. Of the pages that
 * remain only skills come from sources; tool servers, layouts and kits do
 * not, so those pages have no source picker. Every source, of any kind, is
 * managed from Apps › Discover.
 */
const PAGE_SOURCE_KINDS: Partial<
  Record<RegistryCatalogTab, readonly ['skills']>
> = { skills: ['skills'] };

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
  const invalidateQuery = useInvalidateQuery();
  const [activeTab, setActiveTab] = useState<RegistryCatalogTab>(
    initialTab ?? 'skills',
  );
  // The URL is authoritative: Back/Forward (or any in-app navigation that
  // changes /registry/:tab while this view stays mounted) must re-sync the
  // rendered tab — initializer-only state desyncs on popstate (archive#2678).
  useEffect(() => {
    setActiveTab(initialTab ?? 'skills');
  }, [initialTab]);
  // The agent editor's tool picker switches its own tabs in place.
  const selectTab = (tab: RegistryCatalogTab) => setActiveTab(tab);
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
  const {
    data: availableData,
    error: availableError,
    isLoading: loadingAvailable,
    dataUpdatedAt: availableUpdatedAt,
    refetch: refetchAvailable,
  } = useRegistryItemsQuery<RegistryItem>(
    activeTab === 'kits' ? 'skills' : activeTab,
    { enabled: activeTab !== 'kits' },
  );
  const {
    data: installedData,
    error: installedError,
    isLoading: loadingInstalled,
    refetch: refetchInstalled,
  } = useInstalledRegistryItemsQuery<RegistryItem>(
    activeTab === 'kits' ? 'skills' : activeTab,
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
    activeTab === 'skills'
      ? skillMutation.variables?.id
      : activeTab === 'integrations'
        ? integrationMutation.variables?.id
        : activeTab === 'layouts'
          ? layoutMutation.variables?.id
          : pluginMutation.variables?.id;
  const mutationPending =
    activeTab === 'skills'
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
    // Installing a plugin (the tool picker's Plugins tab) starts at the
    // preview: the decision the server needs is about the previewed bytes,
    // so there is nothing honest to send until the preview has been shown.
    if (action === 'install' && activeTab === 'plugins') {
      startInstall(activeTab, item, itemId);
      return;
    }
    const callbacks = actionCallbacks(activeTab, item, itemId, isInstalled);
    if (activeTab === 'skills') {
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

  // Each catalogue is a page entered from where its kind is used. The
  // remote extension code controls live with installed apps (Apps ›
  // Library) and Discover, where extension code is added and runs.
  return (
    <div className="registry-view">
      {/* A source narrows this page's own list; choosing one never opens
          another page. */}
      {!toolPicker && PAGE_SOURCE_KINDS[activeTab] && (
        <MarketplaceSources
          selected={selectedSource}
          onSelect={(id) => setSelectedSource(id)}
          kinds={PAGE_SOURCE_KINDS[activeTab]}
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
            retryInstalled: () => {
              void refetchInstalled();
            },
            retryCatalog: () => {
              void refetchAvailable();
            },
            renderKits: () => <KitCatalog />,
            openOwner: navigate,
          }}
        />
      )}
      {pluginInstallModal}
    </div>
  );
}
