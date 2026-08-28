import type { PermissionTier } from '@kontourai/station-contracts/plugin';
import {
  type PluginProviderDetail,
  type PluginSettingField,
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
import { useMemo, useState } from 'react';
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
import type {
  Plugin,
  PluginMessage,
  PluginUpdateSummary,
  PreviewData,
} from './types';
import {
  buildPluginListItems,
  filterPlugins,
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
    refetch: () => unknown;
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

  const selected = plugins.find((plugin) => plugin.name === selectedPlugin);

  const { data: settingsData } = usePluginSettingsQuery(
    selectedPlugin ?? undefined,
    {
      enabled: !!selectedPlugin && !!selected?.hasSettings,
    },
  );

  const { data: changelogData } = usePluginChangelogQuery(
    selectedPlugin ?? undefined,
    {
      enabled: !!selectedPlugin && !!selected?.git,
    },
  );

  const saveSettingsMutation = usePluginSettingsMutation();
  const previewMutation = usePluginPreviewMutation();
  const installMutation = usePluginInstallMutation();
  const createProjectMutation = useCreateProjectMutation();
  const addLayoutFromPluginMutation = useAddProjectLayoutFromPluginMutation();
  const reloadPluginsMutation = useReloadPluginsMutation();
  const revokePermissionMutation = useRevokePluginPermissionMutation();
  // archive#3815: the permission being withdrawn, so its own row shows the
  // pending state instead of the whole section going busy.
  // A SET, not one string : the UI deliberately leaves every
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
    usePluginProvidersQuery(selectedPlugin ?? undefined, {
      enabled: !!selectedPlugin && expandedProviders.has(selectedPlugin),
    });

  const filtered = useMemo(
    () => filterPlugins(plugins, search),
    [plugins, search],
  );
  const items = useMemo(() => buildPluginListItems(filtered), [filtered]);

  async function reloadClientPluginRegistry() {
    try {
      await pluginRegistry.reload();
    } catch (error) {
      console.warn('Plugin registry reload failed', error);
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
    const pendingConsent = basis.permissions.pendingConsent;
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
        },
      },
      {
        onSuccess: async (data) => {
          const pluginName = data.plugin.displayName || data.plugin.name;
          const pending = data.permissions?.pendingConsent;
          setShowInstallModal(false);

          if (pending?.length) {
            const approved = await requestConsent(
              data.plugin.name,
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

          const agents = data.plugin.agents || [];
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
              pluginName: data.plugin.name,
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
      await revokePermissionMutation.mutateAsync({
        name: pluginName,
        permissions: [permission],
      });
    } catch (error) {
      // A failed withdrawal used to be silent: the row stopped spinning, the
      // confirmation closed, and the permission was still there (
      //). Nothing is more misleading on a permission surface than a
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
