import { pluginLifecycleTargetName } from '@kontourai/station-sdk';
import { useState } from 'react';
import { Button } from '../components/Button';
import { PlugGlyph } from '../components/icons/Glyph';
import { SplitPaneLayout } from '../components/SplitPaneLayout';
import './PluginManagementView.css';
import './page-layout.css';
import './editor-layout.css';
import { ConfirmModal } from '../components/modals/ConfirmModal';
import { describePermission } from '../core/permission-vocabulary';
import { APPS_SUBTITLE } from './apps/appsCopy';
import { NewPluginModal } from './plugin-management/NewPluginModal';
import { PluginDetailPanel } from './plugin-management/PluginDetailPanel';
import { PluginEmptyState } from './plugin-management/PluginEmptyState';
import { PluginModalStack } from './plugin-management/PluginModalStack';
import { isRejectedPlugin } from './plugin-management/types';
import { usePluginManagementViewModel } from './plugin-management/usePluginManagementViewModel';
import { soleLayoutTargetProject } from './plugin-management/view-utils';

/* ── Main View ── */
export function PluginManagementView() {
  const {
    activeProposal,
    cancelProposedUpdate,
    cancelRemove,
    closeInstallModal,
    closePreview,
    reinstall,
    reinstallFromSource,
    selectedLocalSource,
    confirmProposedUpdate,
    updateConfirm,
    addLayoutToProjects,
    addPluginLayout,
    assigningLayout,
    changelogData,
    changelogExpanded,
    createProjectForLayout,
    deselectPlugin,
    expandedProviders,
    filtered,
    install,
    installMessage,
    installMutation,
    installSource,
    isLoading,
    pluginsError,
    refetchPlugins,
    reloadRejectedPending,
    reloadRejectedPlugin,
    items,
    layoutAssignment,
    loadingProviderDetails,
    message,
    setMessage,
    plugins,
    previewData,
    previewMutation,
    previewSkips,
    projects,
    providerDetails,
    queryClient,
    quickProjectName,
    remove,
    removeConfirm,
    requestRevokePermission,
    revokeConfirm,
    revokePermission,
    revokingPermissions,
    setRevokeConfirm,
    requestConsent,
    savePluginSetting,
    search,
    selected,
    selectedPlugin,
    selectedProjects,
    selectPlugin,
    setChangelogExpanded,
    setInstallMessage,
    setInstallSourceAndReset,
    setLayoutAssignment,
    setRemoveConfirm,
    setSearch,
    setShowFolderPicker,
    setShowInstallModal,
    showFolderPicker,
    showInstallModal,
    settingsData,
    toggleExpandedProviders,
    togglePreviewSkip,
    toggleProjectSelection,
    toggleProvider,
    updateCheck,
    updateMutation,
    updatePlugin,
    updates,
  } = usePluginManagementViewModel();
  const [showNewPlugin, setShowNewPlugin] = useState(false);
  const checkStatus = updateCheck.isError
    ? 'unavailable'
    : updateCheck.data?.status;
  const checkMessage = updateCheck.isFetching
    ? 'Checking for plugin updates…'
    : checkStatus === 'unavailable'
      ? 'Plugin update check unavailable.'
      : checkStatus === 'partial'
        ? 'Some plugin update sources could not be checked.'
        : checkStatus === 'unknown'
          ? 'This Station did not report whether the update check completed.'
          : updateCheck.data?.managedByPolicy?.length
            ? 'Some plugin updates are managed by policy.'
            : checkStatus === 'complete' && updates.length === 0
              ? 'No plugin updates found.'
              : null;

  return (
    <>
      <SplitPaneLayout
        label="apps"
        listClassName="plugins__list"
        title="Apps"
        subtitle={APPS_SUBTITLE}
        items={items}
        loading={isLoading}
        error={pluginsError}
        onRetry={() => void refetchPlugins()}
        listErrorTitle="Unable to load plugins"
        selectedId={selectedPlugin}
        onSelect={selectPlugin}
        onDeselect={deselectPlugin}
        onSearch={setSearch}
        searchValue={search}
        listFilteredEmptyNoun="plugins"
        collectionEmpty={plugins.length === 0}
        searchPlaceholder="Search plugins..."
        onAdd={() => {
          setInstallMessage(null);
          setShowInstallModal(true);
        }}
        addLabel="Install plugin"
        listEmptyTitle="No plugins installed yet"
        listEmptyDescription="Find apps in Discover, or install a plugin from a folder or Git URL."
        headerActions={
          <>
            {/* Beside Install plugin: someone looking to add a plugin is
                also the person who might want to build one. */}
            <Button
              variant="secondary"
              size="sm"
              className="plugins__registry-btn"
              onClick={() => setShowNewPlugin(true)}
            >
              New plugin
            </Button>
          </>
        }
        listIntro={
          checkMessage && (
            <div className="plugins__update-check">
              <span role="status">{checkMessage}</span>
              {checkStatus && checkStatus !== 'complete' && (
                <Button
                  size="sm"
                  disabled={updateCheck.isFetching}
                  onClick={() => void updateCheck.refetch()}
                >
                  Retry update check
                </Button>
              )}
            </div>
          )
        }
        emptyIcon={<PlugGlyph />}
        emptyDescription="Select a plugin from the list or install a new one"
        emptyContent={
          <PluginEmptyState
            updates={updates}
            filteredPlugins={filtered}
            message={message}
            onUpdateAll={() =>
              updates.forEach((update) => updatePlugin(update.name))
            }
          />
        }
      >
        {selected && (
          <PluginDetailPanel
            selected={selected}
            updates={updates}
            message={message}
            settingsData={settingsData}
            changelogData={changelogData}
            expandedProviders={expandedProviders}
            providerDetails={providerDetails}
            loadingProviderDetails={loadingProviderDetails}
            changelogExpanded={changelogExpanded}
            updatePending={updateMutation.isPending}
            updateTarget={
              updateMutation.variables === undefined
                ? undefined
                : pluginLifecycleTargetName(updateMutation.variables)
            }
            onUpdate={updatePlugin}
            onCheckUpdates={() =>
              queryClient.invalidateQueries({
                queryKey: ['plugin-updates'],
              })
            }
            onRemove={setRemoveConfirm}
            onRecoveryOutcome={setMessage}
            onToggleProviders={toggleExpandedProviders}
            onToggleProvider={toggleProvider}
            onSaveSetting={savePluginSetting}
            onToggleChangelog={() => setChangelogExpanded((value) => !value)}
            revokingPermissions={revokingPermissions}
            onReloadRejected={() => void reloadRejectedPlugin()}
            reloadRejectedPending={reloadRejectedPending}
            layoutTargetProjectName={
              soleLayoutTargetProject(projects)?.name ?? null
            }
            addLayoutPending={assigningLayout}
            localSource={selectedLocalSource}
            localSourceProjectName={
              projects.find(
                (project) => project.slug === selectedLocalSource?.projectSlug,
              )?.name
            }
            reinstallPending={!!reinstall && previewMutation.isPending}
            onReinstallFromSource={() => {
              if (isRejectedPlugin(selected) || !selectedLocalSource) return;
              reinstallFromSource(selected, selectedLocalSource);
            }}
            onAddLayout={() => {
              if (isRejectedPlugin(selected)) return;
              void addPluginLayout(selected);
            }}
            onRevokePermission={(entry) =>
              requestRevokePermission(
                selected.name,
                entry,
                describePermission(entry.permission),
              )
            }
            onReviewPermissions={async () => {
              if (isRejectedPlugin(selected)) return;
              const approved = await requestConsent(
                selected.name,
                selected.displayName || selected.name,
                selected.permissions?.missing || [],
              );
              if (approved) {
                queryClient.invalidateQueries({
                  queryKey: ['plugins'],
                });
              }
            }}
          />
        )}
      </SplitPaneLayout>

      {/* archive#3815: only a TRUSTED withdrawal asks. Removing any grant
          is safe — it narrows what a plugin may do — but a trusted one is
          expensive to restore (the separate host review page), and that
          asymmetry is what the prompt is about. It says so, rather than
          asking "are you sure" about something the person already decided. */}
      <ConfirmModal
        isOpen={revokeConfirm !== null}
        role="alertdialog"
        variant="warning"
        title="Remove this trusted permission?"
        message={
          revokeConfirm
            ? `${revokeConfirm.label} stops for new work immediately. Running work finishes and registered providers are removed; the result says if cleanup is still winding down. Granting it again needs the separate host review page.`
            : ''
        }
        confirmLabel="Remove"
        onConfirm={() => {
          if (!revokeConfirm) return;
          void revokePermission(
            revokeConfirm.pluginName,
            revokeConfirm.permission,
          );
        }}
        onCancel={() => setRevokeConfirm(null)}
      />

      {showNewPlugin && (
        <NewPluginModal onClose={() => setShowNewPlugin(false)} />
      )}

      <PluginModalStack
        showInstallModal={showInstallModal}
        showFolderPicker={showFolderPicker}
        previewData={previewData}
        previewSkips={previewSkips}
        installPending={installMutation.isPending}
        previewPending={previewMutation.isPending}
        installSource={installSource}
        installMessage={installMessage}
        message={message}
        removeConfirm={removeConfirm}
        removalRetainsData={plugins.some(
          (plugin) =>
            plugin.name === removeConfirm &&
            !('status' in plugin) &&
            plugin.retainedOnRemoval === true,
        )}
        layoutAssignment={layoutAssignment}
        projects={projects.flatMap((project) =>
          project.layoutCount === undefined
            ? []
            : [{ ...project, layoutCount: project.layoutCount }],
        )}
        quickProjectName={quickProjectName}
        selectedProjects={selectedProjects}
        assigningLayout={assigningLayout}
        onChangeSource={(value) => {
          setInstallSourceAndReset(value);
          setInstallMessage(null);
        }}
        onBrowse={() => setShowFolderPicker(true)}
        onInstall={() => install()}
        onCloseInstall={closeInstallModal}
        onSelectFolder={setInstallSourceAndReset}
        onCloseFolderPicker={() => setShowFolderPicker(false)}
        onClosePreview={closePreview}
        onToggleSkip={togglePreviewSkip}
        onConfirmInstall={(dataPolicy) =>
          install(Array.from(previewSkips), dataPolicy)
        }
        onCancelRemove={cancelRemove}
        onConfirmRemove={remove}
        onCloseLayoutAssignment={() => setLayoutAssignment(null)}
        onToggleProject={toggleProjectSelection}
        onCreateProject={createProjectForLayout}
        onAddToProjects={addLayoutToProjects}
        proposal={activeProposal}
        updateConfirm={updateConfirm}
        onConfirmUpdate={confirmProposedUpdate}
        onCancelUpdate={cancelProposedUpdate}
        reinstall={reinstall}
      />
    </>
  );
}
