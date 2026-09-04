import type { PermissionTier } from '@kontourai/station-contracts/plugin';
import {
  type PluginProviderDetail,
  type PluginSettingField,
  reloadPlugins,
  useAddProjectLayoutFromPluginMutation,
  useCreateProjectMutation,
  usePluginChangelogQuery,
  usePluginInstallMutation,
  usePluginPreviewMutation,
  usePluginProvidersQuery,
  usePluginProviderToggleMutation,
  usePluginRemoveMutation,
  usePluginSettingsMutation,
  usePluginSettingsQuery,
  usePluginsQuery,
  usePluginUpdateMutation,
  usePluginUpdatesQuery,
  useReloadPluginsMutation,
  useRevokePluginPermissionMutation,
  waitForAgentHealth,
} from '@kontourai/station-sdk';
import { useQueryClient } from '@tanstack/react-query';
import { useMemo, useRef, useState } from 'react';
import { useApiBase } from '../../contexts/ApiBaseContext';
import { useNavigation } from '../../contexts/NavigationContext';
import { useProjects } from '../../contexts/ProjectsContext';
import { usePermissions } from '../../core/PermissionManager';
import { pluginRegistry } from '../../core/PluginRegistry';
import {
  describePermission,
  revokeNeedsConfirmation,
} from '../../core/permission-vocabulary';
import { useUrlSelection } from '../../hooks/useUrlSelection';
import {
  installedDependencyPermissions,
  isRejectedPlugin,
  type Plugin,
  type PluginMessage,
  type PluginUpdateSummary,
  type PreviewData,
} from './types';
import {
  buildPluginListItems,
  filterPlugins,
  pluginSelectionId,
  slugifyProjectName,
  toggleSetValue,
} from './view-utils';

export function consentFailureMessage(
  pluginName: string,
  pending: Array<{ tier: string }>,
) {
  if (pending.some((permission) => permission.tier === 'trusted')) {
    return `${pluginName} is installed but requires host approval before it is ready. Open Plugins, select it, and choose Review Permissions when you're ready.`;
  }

  return `${pluginName} was installed, but required permissions were not approved.`;
}

/**
 * What a DECLINED install left behind (archive#4288): nothing, and the
 * message says so rather than reporting a failure the reader would have to
 * investigate. Consent is now taken before the install request is made, so
 * declining is not an error — it is the operator's answer, honoured.
 */
export function installDeclinedMessage(pluginName: string) {
  return `${pluginName} was not installed. Nothing was added or changed.`;
}

export function usePluginManagementViewModel() {
  const { apiBase } = useApiBase();
  const { setLayout } = useNavigation();
  const queryClient = useQueryClient();
  const { requestConsent, requestInstallConsent } = usePermissions();
  const { projects } = useProjects();
  const {
    selectedId: selectedPlugin,
    select: selectPlugin,
    deselect: deselectPlugin,
  } = useUrlSelection('/plugins');
  const selectedPluginRef = useRef(selectedPlugin);
  selectedPluginRef.current = selectedPlugin;

  // `error`/`refetch` too, or a failed read renders the definitive
  // "No plugins installed yet" over plugins Station simply could not read.
  const {
    data: plugins = [],
    error: pluginsError,
    isLoading,
    refetch: refetchPlugins,
  } = usePluginsQuery() as {
    data: Plugin[];
    error?: unknown;
    isLoading: boolean;
    refetch: () => Promise<{
      data?: Plugin[];
      error: unknown;
      isError: boolean;
    }>;
  };
  const { data: updates = [] } = usePluginUpdatesQuery() as {
    data: PluginUpdateSummary[];
  };

  const [installSource, setInstallSource] = useState('');
  const [showFolderPicker, setShowFolderPicker] = useState(false);
  const [showInstallModal, setShowInstallModal] = useState(false);
  const [previewData, setPreviewData] = useState<PreviewData | null>(null);
  const [previewSkips, setPreviewSkips] = useState<Set<string>>(new Set());
  const [expandedProviders, setExpandedProviders] = useState<Set<string>>(
    new Set(),
  );
  const [removeConfirm, setRemoveConfirm] = useState<string | null>(null);
  const [message, setMessage] = useState<PluginMessage | null>(null);
  const [search, setSearch] = useState('');
  const [layoutAssignment, setLayoutAssignment] = useState<{
    pluginName: string;
    displayName: string;
    layoutSlug: string;
  } | null>(null);
  const [selectedProjects, setSelectedProjects] = useState<Set<string>>(
    new Set(),
  );
  const [quickProjectName, setQuickProjectName] = useState('');
  const [assigningLayout, setAssigningLayout] = useState(false);
  const [installMessage, setInstallMessage] = useState<PluginMessage | null>(
    null,
  );
  const [changelogExpanded, setChangelogExpanded] = useState(false);
  const rejectedReloadInFlight = useRef(false);
  const [reloadRejectedPending, setReloadRejectedPending] = useState(false);

  const selected = plugins.find(
    (plugin) => pluginSelectionId(plugin) === selectedPlugin,
  );
  const selectedReady =
    selected && !isRejectedPlugin(selected) ? selected : undefined;

  const { data: settingsData } = usePluginSettingsQuery(selectedReady?.name, {
    enabled: !!selectedReady?.hasSettings,
  });

  const { data: changelogData } = usePluginChangelogQuery(selectedReady?.name, {
    enabled: !!selectedReady?.git,
  });

  const saveSettingsMutation = usePluginSettingsMutation();
  const previewMutation = usePluginPreviewMutation();
  const installMutation = usePluginInstallMutation();
  const createProjectMutation = useCreateProjectMutation();
  const addLayoutFromPluginMutation = useAddProjectLayoutFromPluginMutation();
  const reloadPluginsMutation = useReloadPluginsMutation();
  const revokePermissionMutation = useRevokePluginPermissionMutation();
  // archive#3815: the permission being withdrawn, so its own row shows the
  // pending state instead of the whole section going busy.
  // A SET, not one string — the UI deliberately leaves every
  // other row actionable, so two removals can be in flight at once. With a
  // single slot the second replaced the first, and whichever settled first
  // cleared the pending state of the one still running.
  const [revokingPermissions, setRevokingPermissions] = useState<Set<string>>(
    () => new Set(),
  );
  // A trusted grant is cheap to remove and expensive to restore (the
  // isolated host review page), so that one asks first. The others do not:
  // making the safe direction slow is how people stop taking it.
  const [revokeConfirm, setRevokeConfirm] = useState<{
    pluginName: string;
    permission: string;
    label: string;
  } | null>(null);
  const updateMutation = usePluginUpdateMutation();
  const removeMutation = usePluginRemoveMutation();
  const toggleProviderMutation = usePluginProviderToggleMutation();

  const { data: providerDetails, isLoading: loadingProviderDetails } =
    usePluginProvidersQuery(selectedReady?.name, {
      enabled: !!selectedReady && expandedProviders.has(selectedReady.name),
    });

  const filtered = useMemo(
    () => filterPlugins(plugins, search),
    [plugins, search],
  );
  const items = useMemo(() => buildPluginListItems(filtered), [filtered]);

  async function reloadClientPluginRegistry() {
    try {
      const registryState = await pluginRegistry.reload();
      if (registryState === 'degraded') {
        throw new Error('browser plugin registry is still degraded');
      }
    } catch (error) {
      console.warn('Plugin registry reload failed', error);
    }
  }

  async function reloadRejectedPlugin() {
    if (rejectedReloadInFlight.current) return;
    const selectionAtStart = selectedPlugin;
    const rejectedDirectoryAtStart =
      selected && isRejectedPlugin(selected) ? selected.name : null;
    rejectedReloadInFlight.current = true;
    setReloadRejectedPending(true);
    setMessage(null);
    try {
      // Use the direct request rather than the generic mutation hook here.
      // That hook invalidates the collection as soon as the server answers,
      // which can refetch before the browser registry has finished reloading.
      await reloadPlugins();
      // Recovery is one ordered operation. A stale client registry means the
      // repaired package is not ready even if the server reload succeeded.
      const registryState = await pluginRegistry.reload();
      if (registryState === 'degraded') {
        throw new Error('browser plugin registry is still degraded');
      }
      // The canonical reload mutation invalidates these plugin-derived graph
      // caches. Preserve that contract after the ordered server -> browser
      // registry boundary; the plugin collection itself is explicitly
      // refetched below so its failure remains observable here.
      for (const queryKey of [
        ['plugin-updates'],
        ['layouts'],
        ['agents'],
        ['projects'],
      ]) {
        queryClient.invalidateQueries({ queryKey });
      }
      const refreshed = await refetchPlugins();
      if (refreshed.isError) {
        throw refreshed.error instanceof Error
          ? refreshed.error
          : new Error('Plugin collection refresh failed');
      }
      if (
        selectionAtStart &&
        selectedPluginRef.current === selectionAtStart &&
        rejectedDirectoryAtStart
      ) {
        const repaired = refreshed.data?.find(
          (plugin) =>
            !isRejectedPlugin(plugin) &&
            plugin.name === rejectedDirectoryAtStart,
        );
        const stillRejected = refreshed.data?.find(
          (plugin): plugin is Extract<Plugin, { status: 'rejected' }> =>
            isRejectedPlugin(plugin) &&
            pluginSelectionId(plugin) === selectionAtStart,
        );
        // A valid manifest in another directory can use this directory's
        // name. The exact rejected selection remains authoritative until its
        // row disappears; a same-name valid row alone does not prove repair.
        if (stillRejected) {
          setMessage({
            type: 'error',
            text: `${stillRejected.displayName} is still rejected. ${stillRejected.rejection.reason}`,
          });
        } else if (repaired) selectPlugin(repaired.name);
        else deselectPlugin();
      }
    } catch (error) {
      setMessage({
        type: 'error',
        text:
          error instanceof Error
            ? `Plugins were not reloaded: ${error.message}`
            : 'Plugins were not reloaded.',
      });
    } finally {
      rejectedReloadInFlight.current = false;
      setReloadRejectedPending(false);
    }
  }

  function toggleProvider(
    pluginName: string,
    providerType: string,
    currentlyEnabled: boolean,
  ) {
    if (!providerDetails) return;
    const disabled = providerDetails
      .filter((provider) =>
        provider.type === providerType ? currentlyEnabled : !provider.enabled,
      )
      .map((provider) => provider.type);
    toggleProviderMutation.mutate(
      { pluginName, disabled },
      {
        onSuccess: () =>
          queryClient.invalidateQueries({
            queryKey: ['plugin-providers', pluginName],
          }),
      },
    );
  }

  async function install(skipList?: string[]) {
    const source = installSource.trim();
    if (!source) return;

    if (!previewData && !skipList) {
      setInstallMessage(null);
      previewMutation.mutate(source, {
        onSuccess: (data: PreviewData) => {
          if (!data.valid) {
            setInstallMessage({
              type: 'error',
              text: data.error || 'Invalid plugin',
            });
            return;
          }
          setPreviewSkips(
            new Set(data.conflicts.map((entry) => `${entry.type}:${entry.id}`)),
          );
          setPreviewData(data);
        },
        onError: (error) =>
          setInstallMessage({ type: 'error', text: error.message }),
      });
      return;
    }

    // archive#4288. The gate, and the reason it is HERE rather than in
    // `onSuccess`: `installMutation.mutate` is the mutation. Asking after it
    // resolves asks about a plugin that is already on disk — and for the
    // contributions that run in the browser, already able to have run. So the
    // decision is taken first, and it travels with the request as the thing
    // the server refuses to mutate without.
    //
    // `previewData` is the whole basis: the server derived it from the copy it
    // staged, and it carries the digest that binds the answer to those bytes.
    // No preview, no basis, no install — the client cannot assemble a decision
    // it never showed anyone.
    const basis = previewData;
    if (!basis?.contentDigest || !basis.permissions) {
      setInstallMessage({
        type: 'error',
        text: 'Preview this plugin before installing it — approval happens on what the preview found.',
      });
      return;
    }

    const displayName =
      basis.manifest?.displayName || basis.manifest?.name || source;
    const pendingConsent = [
      ...basis.permissions.pendingConsent,
      ...(basis.dependencies ?? []).flatMap((dependency) =>
        (dependency.consent?.pendingConsent ?? []).map((entry) => ({
          ...entry,
          permission: `${dependency.id}: ${entry.permission}`,
        })),
      ),
    ];
    if (pendingConsent.length > 0) {
      const approved = await requestInstallConsent(
        basis.manifest?.name || displayName,
        displayName,
        pendingConsent,
      );
      if (!approved) {
        setPreviewData(null);
        setShowInstallModal(false);
        setMessage({
          type: 'success',
          text: installDeclinedMessage(displayName),
        });
        return;
      }
    }

    setMessage(null);
    setPreviewData(null);
    installMutation.mutate(
      {
        source,
        skip: skipList || Array.from(previewSkips),
        consent: {
          permissions: basis.permissions.required,
          contentDigest: basis.contentDigest,
          dependencies: (basis.dependencies ?? []).map(
            (dependency) => dependency.id,
          ),
          ...((basis.dependencies ?? []).some(
            (dependency) => dependency.consent,
          )
            ? {
                dependencyApprovals: (basis.dependencies ?? []).flatMap(
                  (dependency) =>
                    dependency.consent
                      ? [
                          {
                            id: dependency.id,
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
      },
      {
        onSuccess: async (data) => {
          setShowInstallModal(false);
          const installedPlugin = data.plugin;
          if (!installedPlugin) {
            setMessage({
              type: 'error',
              text: 'Station did not return installed plugin details. Refresh Plugins before continuing.',
            });
            await reloadPluginsMutation.mutateAsync().catch(() => {});
            await reloadClientPluginRegistry();
            return;
          }
          const pluginName =
            installedPlugin.displayName || installedPlugin.name;
          const pending = data.permissions?.pendingConsent;

          if (pending?.length) {
            const approved = await requestConsent(
              installedPlugin.name,
              pluginName,
              pending,
            );
            if (!approved) {
              setMessage({
                type: 'error',
                text: consentFailureMessage(pluginName, pending),
              });
              await reloadPluginsMutation.mutateAsync().catch((error) => {
                console.warn('Plugin reload failed', error);
              });
              await reloadClientPluginRegistry();
              return;
            }
          }
          const dependencyStatus = installedDependencyPermissions(data);
          if (
            dependencyStatus === undefined &&
            (basis.dependencies?.length ?? 0) > 0
          ) {
            setMessage({
              type: 'error',
              text: `${pluginName} is installed, but Station did not report current dependency approval status. Check Plugins on the Station host.`,
            });
            await reloadPluginsMutation.mutateAsync().catch(() => {});
            await reloadClientPluginRegistry();
            return;
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
              setMessage({
                type: 'error',
                text: consentFailureMessage(
                  `Dependency ${dependency.id}`,
                  dependencyPending,
                ),
              });
              await reloadPluginsMutation.mutateAsync().catch(() => {});
              await reloadClientPluginRegistry();
              return;
            }
          }

          setInstallSource('');
          setMessage({
            type: 'success',
            text: `Installed ${pluginName}. Setting up tools...`,
          });

          try {
            await reloadPluginsMutation.mutateAsync();
          } catch (error) {
            console.warn('Plugin reload failed', error);
          }
          await reloadClientPluginRegistry();

          const agents = installedPlugin.agents || [];
          if (agents.length > 0) {
            const slug = agents[0].slug;
            const health = await waitForAgentHealth(slug);
            if (!health) {
              console.warn('Agent health poll timed out', { slug });
            }
          }

          queryClient.invalidateQueries({ queryKey: ['agents'] });
          queryClient.invalidateQueries({ queryKey: ['projects'] });
          setMessage({ type: 'success', text: `${pluginName} is ready.` });

          if (data.layout?.slug) {
            setQuickProjectName(pluginName);
            setSelectedProjects(new Set());
            setLayoutAssignment({
              pluginName: installedPlugin.name,
              displayName: pluginName,
              layoutSlug: data.layout.slug,
            });
          }
        },
        onError: (error) =>
          setInstallMessage({ type: 'error', text: error.message }),
      },
    );
  }

  function updatePlugin(name: string) {
    setMessage(null);
    updateMutation.mutate(name, {
      onSuccess: (data) => {
        setMessage({
          type: 'success',
          text: `Updated ${data.plugin?.name || name} to v${data.plugin?.version}`,
        });
      },
      onError: (error) => setMessage({ type: 'error', text: error.message }),
    });
  }

  function remove(name: string) {
    setRemoveConfirm(null);
    removeMutation.mutate(name, {
      onSuccess: async () => {
        setMessage({ type: 'success', text: `Removed ${name}.` });
        deselectPlugin();
        await reloadClientPluginRegistry();
      },
      onError: (error) => setMessage({ type: 'error', text: error.message }),
    });
  }

  async function revokePermission(pluginName: string, permission: string) {
    setRevokingPermissions((current) => new Set(current).add(permission));
    setMessage(null);
    try {
      const outcome = await revokePermissionMutation.mutateAsync({
        name: pluginName,
        permissions: [permission],
      });
      const label = describePermission(permission);
      const operation = outcome.reconciliation.operationId
        ? ` Cleanup operation ${outcome.reconciliation.operationId}.`
        : '';
      const action =
        outcome.reconciliation.status === 'winding-down' ||
        outcome.reconciliation.status === 'incomplete'
          ? {
              label:
                outcome.reconciliation.status === 'winding-down'
                  ? 'Check cleanup'
                  : 'Retry cleanup',
              invoke: () => {
                void revokePermission(pluginName, permission);
              },
            }
          : undefined;
      setMessage({
        type: 'success',
        text:
          outcome.reconciliation.status === 'completed'
            ? `${label} was removed and its runtime capability is retired.`
            : outcome.reconciliation.status === 'winding-down'
              ? `${label} was removed. Existing work is still winding down.${operation}`
              : outcome.reconciliation.status === 'superseded'
                ? `${label} changed again while runtime state was reconciling; the latest grant state won.`
                : `${label} was removed, but runtime cleanup is incomplete.${operation}`,
        ...(action ? { action } : {}),
      });
    } catch (error) {
      // A failed withdrawal used to be silent: the row stopped spinning, the
      // confirmation closed, and the permission was still there. Nothing is more misleading on a permission surface than a
      // removal that looks like it happened.
      setMessage({
        type: 'error',
        text:
          error instanceof Error
            ? `${describePermission(permission)} was not removed: ${error.message}`
            : `${describePermission(permission)} was not removed.`,
      });
    } finally {
      setRevokingPermissions((current) => {
        const next = new Set(current);
        next.delete(permission);
        return next;
      });
      setRevokeConfirm(null);
    }
  }

  function requestRevokePermission(
    pluginName: string,
    entry: { permission: string; tier: PermissionTier },
    label: string,
  ) {
    if (revokeNeedsConfirmation(entry.tier)) {
      setRevokeConfirm({ pluginName, permission: entry.permission, label });
      return;
    }
    void revokePermission(pluginName, entry.permission);
  }

  function savePluginSetting(name: string, key: string, value: unknown) {
    saveSettingsMutation.mutate({
      name,
      settings: {
        ...(settingsData?.values || {}),
        [key]: value,
      },
    });
  }

  async function createProjectForLayout() {
    if (!layoutAssignment) return;
    setAssigningLayout(true);
    try {
      const slug = slugifyProjectName(quickProjectName);
      await createProjectMutation.mutateAsync({
        name: quickProjectName,
        slug,
      });
      await addLayoutFromPluginMutation.mutateAsync({
        projectSlug: slug,
        plugin: layoutAssignment.pluginName,
      });
      setLayoutAssignment(null);
      setLayout(slug, layoutAssignment.layoutSlug);
    } catch (error) {
      console.warn('Quick project creation failed', error);
      setMessage({
        type: 'error',
        text: 'Failed to create a project for the plugin layout.',
      });
    } finally {
      setAssigningLayout(false);
    }
  }

  async function addLayoutToProjects() {
    if (!layoutAssignment) return;
    setAssigningLayout(true);
    try {
      for (const slug of selectedProjects) {
        await addLayoutFromPluginMutation.mutateAsync({
          projectSlug: slug,
          plugin: layoutAssignment.pluginName,
        });
      }
      setLayoutAssignment(null);
      setLayout([...selectedProjects][0], layoutAssignment.layoutSlug);
    } catch (error) {
      console.warn('Layout assignment failed', error);
      setMessage({
        type: 'error',
        text: 'Failed to add the plugin layout to one or more projects.',
      });
    } finally {
      setAssigningLayout(false);
    }
  }

  return {
    apiBase,
    assigningLayout,
    pluginsError,
    refetchPlugins,
    reloadRejectedPlugin,
    reloadRejectedPending,
    changelogData,
    changelogExpanded,
    createProjectForLayout,
    filtered,
    install,
    installMessage,
    installMutation,
    installSource,
    isLoading,
    items,
    layoutAssignment,
    loadingProviderDetails,
    message,
    plugins,
    previewData,
    previewMutation,
    previewSkips,
    projects,
    providerDetails: providerDetails as PluginProviderDetail[] | undefined,
    queryClient,
    quickProjectName,
    remove,
    removeConfirm,
    requestConsent,
    revokeConfirm,
    revokePermission,
    revokingPermissions,
    requestRevokePermission,
    setRevokeConfirm,
    savePluginSetting,
    search,
    selected,
    selectedPlugin,
    selectedProjects,
    selectPlugin,
    deselectPlugin,
    setChangelogExpanded,
    setInstallMessage,
    setLayoutAssignment,
    setPreviewData,
    setQuickProjectName,
    setRemoveConfirm,
    setSearch,
    setShowFolderPicker,
    setShowInstallModal,
    settingsData: settingsData
      ? {
          schema: settingsData.schema as PluginSettingField[],
          values: settingsData.values,
        }
      : undefined,
    showFolderPicker,
    showInstallModal,
    setInstallSourceAndReset: (value: string) => {
      setInstallSource(value);
      setPreviewData(null);
    },
    toggleExpandedProviders: (pluginName: string) =>
      setExpandedProviders((current) => toggleSetValue(current, pluginName)),
    expandedProviders,
    togglePreviewSkip: (key: string) =>
      setPreviewSkips((current) => toggleSetValue(current, key)),
    toggleProjectSelection: (slug: string, checked: boolean) =>
      setSelectedProjects((current) =>
        checked ? new Set(current).add(slug) : toggleSetValue(current, slug),
      ),
    toggleProvider,
    updateMutation,
    updatePlugin,
    updates,
    addLayoutToProjects,
  };
}
