import { pluginLifecycleUnapplied } from '@kontourai/station-contracts/plugin';
import {
  type RegistryCatalogTab,
  usePluginRegistryInstallMutation,
  usePluginRegistryPreviewMutation,
  usePluginsQuery,
  useReloadPluginsMutation,
} from '@kontourai/station-sdk';
import { type ReactNode, useState } from 'react';
import type { RegistryItem } from '../../components/registry/RegistryCatalog';
import { useNavigation } from '../../contexts/NavigationContext';
import { useToast } from '../../contexts/ToastContext';
import { usePermissions } from '../../core/PermissionManager';
import { pluginRegistry } from '../../core/PluginRegistry';
import { describeStationFailure } from '../../utils/stationFailure';
import { InstallPreviewExtensionAccess } from './InstallPreviewExtensionAccess';
import { InstallPreviewModal } from './InstallPreviewModal';
import { installedDependencyPermissions, type PreviewData } from './types';
import { unappliedMessage, unappliedTone } from './view-utils';

/** The catalog whose entries install as plugins, through the preview. */
export type PluginCatalogTab = Extract<RegistryCatalogTab, 'plugins'>;

/**
 * How a caller reports an install's outcome: the same callbacks it gives its
 * other catalog actions. `reportSuccess` replaces its default success line.
 */
export type PluginCatalogActionCallbacks = (
  tab: RegistryCatalogTab,
  item: RegistryItem,
  itemId: string,
  isInstalled: boolean,
  reportSuccess?: () => void,
) => { onError: (error: Error) => void; onSuccess: () => void };

/**
 * The one way a catalog entry that resolves as a plugin is installed, shared
 * by Apps › Discover and the catalogue pages that still list plugins. It
 * previews the resolved source, takes the person's decision on what the
 * preview found, and sends that decision with the install (archive#4288).
 * Without it the server refuses any plugin that contributes code; the old
 * one-click path never built the bundle, so its layout components could never
 * register (#765 D1).
 */
export function usePluginCatalogInstall({
  actionCallbacks,
  setMessage,
  onInstalled,
}: {
  actionCallbacks: PluginCatalogActionCallbacks;
  setMessage: (message: string | null) => void;
  onInstalled?: () => void;
}) {
  const { navigate } = useNavigation();
  const { showToast } = useToast();
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
  const pluginMutation = usePluginRegistryInstallMutation();
  // Which installed plugins read Needs recovery, so an install of one offers
  // Recover instead of a second copy.
  const { data: installedPluginRows } = usePluginsQuery();

  /**
   * Starts an install at the preview: the decision the server needs is about
   * the previewed bytes, so there is nothing honest to send until the preview
   * has been shown.
   */
  const startInstall = (
    tab: PluginCatalogTab,
    item: RegistryItem,
    itemId: string,
  ) => {
    setMessage(null);
    // A failed preview is terminal mutation state, not a disabled install
    // action. Clear it before each attempt so the selected-card entry point
    // remains live after a refusal, transport error, or malformed response.
    previewMutation.reset();
    previewMutation.mutate(itemId, {
      onSuccess: (data: PreviewData & { code?: string }) => {
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
  };

  const confirmPluginInstall = async (installAgainWhileInactive = false) => {
    const preview = pluginInstallPreview;
    if (!preview) return;
    const { data, item, itemId, tab } = preview;
    if (!data.contentDigest || !data.permissions) return;
    const displayName =
      data.manifest?.displayName ||
      data.manifest?.name ||
      item.displayName ||
      itemId;
    const inactiveName = (installedPluginRows ?? []).find(
      (row) =>
        !('status' in row && row.status === 'rejected') &&
        row.name === data.manifest?.name &&
        'installationReadiness' in row &&
        row.installationReadiness?.state === 'pending' &&
        !('activationInFlight' in row && row.activationInFlight),
    )?.name;
    if (inactiveName && !installAgainWhileInactive) {
      // Recovered, not installed again: see Library's install.
      showToast(
        `${displayName} is already installed but not active. Recover it to activate it; installing it again adds another copy of its code.`,
        undefined,
        undefined,
        [
          {
            label: 'Recover plugin',
            variant: 'primary' as const,
            onClick: () => {
              setPluginInstallPreview(null);
              navigate(`/apps/library/${encodeURIComponent(inactiveName)}`);
            },
          },
          {
            label: 'Install again anyway',
            onClick: () => void confirmPluginInstall(true),
          },
        ],
        'warning',
      );
      return;
    }
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
          `Install declined for ${displayName}. Nothing was added or changed.`,
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
        // Named for what it DOES. It navigates to the installed
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
                    `/apps/library/${encodeURIComponent(installedPluginName)}`,
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
        const unapplied = pluginLifecycleUnapplied(result);
        if (unapplied) {
          // Saved, not applied: the same outcome Library reports.
          // No dependency host review now; it refuses a plugin that is not
          // active, and the plugin's own row finishes the activation.
          actionCallbacks(tab, item, itemId, false, () => {
            setMessage(null);
            showToast(
              unappliedMessage('installed', displayName, unapplied),
              undefined,
              undefined,
              installedPluginName
                ? [
                    {
                      label: 'Open plugin',
                      variant: 'primary' as const,
                      onClick: () =>
                        navigate(
                          `/apps/library/${encodeURIComponent(installedPluginName)}`,
                        ),
                    },
                  ]
                : undefined,
              unappliedTone(unapplied),
            );
          }).onSuccess();
          if (unapplied.kind === 'projection')
            await reloadPluginsMutation.mutateAsync().catch(() => {});
          return;
        }
        baseCallbacks.onSuccess();
        void pluginRegistry.reload();
        const dependencyStatus = installedDependencyPermissions(result);
        if (
          dependencyStatus === undefined &&
          (data.dependencies?.length ?? 0) > 0
        ) {
          setMessage(
            `${displayName} is installed, but Station did not report current dependency approval status. Check the app in Library on the Station host.`,
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
            `Installed ${displayName}, but plugin activation could not be refreshed: ${describeStationFailure(error).body}`,
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
    pluginMutation.mutate(variables, callbacks);
  };

  const modal: ReactNode = pluginInstallPreview ? (
    <InstallPreviewModal
      previewData={pluginInstallPreview.data}
      extensionAccess={
        <InstallPreviewExtensionAccess preview={pluginInstallPreview.data} />
      }
      previewSkips={previewSkips}
      installPending={pluginMutation.isPending}
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
  ) : null;

  return {
    startInstall,
    previewMutation,
    pluginMutation,
    modal,
  };
}
