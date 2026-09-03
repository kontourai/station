import { Button } from '../components/Button';
import { PlugGlyph } from '../components/icons/Glyph';
import { SplitPaneLayout } from '../components/SplitPaneLayout';
import type { NavigationView } from '../types';
import './PluginManagementView.css';
import './page-layout.css';
import './editor-layout.css';
import { ConfirmModal } from '../components/modals/ConfirmModal';
import { describePermission } from '../core/permission-vocabulary';
import { PluginDetailPanel } from './plugin-management/PluginDetailPanel';
import { PluginEmptyState } from './plugin-management/PluginEmptyState';
import { PluginModalStack } from './plugin-management/PluginModalStack';
import { usePluginManagementViewModel } from './plugin-management/usePluginManagementViewModel';

/* ── Main View ── */
export function PluginManagementView({
  onNavigate,
}: {
  onNavigate: (view: NavigationView) => void;
}) {
  const {
    addLayoutToProjects,
    apiBase,
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
    items,
    layoutAssignment,
    loadingProviderDetails,
    message,
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
    setPreviewData,
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
    updateMutation,
    updatePlugin,
    updates,
  } = usePluginManagementViewModel();

  return (
    <>
      <SplitPaneLayout
        label="plugins"
        title="Plugins"
        subtitle="Manage installed plugins"
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
        listEmptyDescription="Install one from a folder or Git URL, or browse Registry."
        headerActions={
          <Button
            variant="secondary"
            size="sm"
            className="plugins__registry-btn"
            onClick={() => onNavigate({ type: 'registry', tab: 'plugins' })}
          >
            Browse Registry
          </Button>
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
            updateTarget={updateMutation.variables}
            onUpdate={updatePlugin}
            onCheckUpdates={() =>
              queryClient.invalidateQueries({
                queryKey: ['plugin-updates'],
              })
            }
            onRemove={setRemoveConfirm}
            onToggleProviders={toggleExpandedProviders}
            onToggleProvider={toggleProvider}
            onSaveSetting={savePluginSetting}
            onToggleChangelog={() => setChangelogExpanded((value) => !value)}
            revokingPermissions={revokingPermissions}
            onRevokePermission={(entry) =>
              requestRevokePermission(
                selected.name,
                entry,
                describePermission(entry.permission),
              )
            }
            onReviewPermissions={async () => {
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
            ? `${revokeConfirm.label} will stop being usable for new work immediately. Station will drain running module work and retire registered providers before reporting completion; if that takes longer, the result will say it is still winding down. Granting it again needs the separate host review page.`
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

      <PluginModalStack
        apiBase={apiBase}
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
        layoutAssignment={layoutAssignment}
        projects={projects}
        quickProjectName={quickProjectName}
        selectedProjects={selectedProjects}
        assigningLayout={assigningLayout}
        onChangeSource={(value) => {
          setInstallSourceAndReset(value);
          setInstallMessage(null);
        }}
        onBrowse={() => setShowFolderPicker(true)}
        onInstall={() => install()}
        onCloseInstall={() => setShowInstallModal(false)}
        onSelectFolder={setInstallSourceAndReset}
        onCloseFolderPicker={() => setShowFolderPicker(false)}
        onClosePreview={() => setPreviewData(null)}
        onToggleSkip={togglePreviewSkip}
        onConfirmInstall={() => install(Array.from(previewSkips))}
        onCancelRemove={() => setRemoveConfirm(null)}
        onConfirmRemove={remove}
        onCloseLayoutAssignment={() => setLayoutAssignment(null)}
        onToggleProject={toggleProjectSelection}
        onCreateProject={createProjectForLayout}
        onAddToProjects={addLayoutToProjects}
      />
    </>
  );
}
