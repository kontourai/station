import {
  ResponsiveDialogSurface,
  ResponsiveSurfaceActions,
} from '../../components/ResponsiveDialogSurface';
import { FolderPickerModal } from './FolderPickerModal';
import { InstallPluginModal } from './InstallPluginModal';
import { InstallPreviewModal } from './InstallPreviewModal';
import { LayoutAssignmentModal } from './LayoutAssignmentModal';
import type { PluginMessage, PreviewData } from './types';

export function PluginModalStack({
  apiBase,
  showInstallModal,
  showFolderPicker,
  previewData,
  previewSkips,
  installPending,
  previewPending,
  installSource,
  installMessage,
  message,
  removeConfirm,
  layoutAssignment,
  projects,
  quickProjectName,
  selectedProjects,
  assigningLayout,
  onChangeSource,
  onBrowse,
  onInstall,
  onCloseInstall,
  onSelectFolder,
  onCloseFolderPicker,
  onClosePreview,
  onToggleSkip,
  onConfirmInstall,
  onCancelRemove,
  onConfirmRemove,
  onCloseLayoutAssignment,
  onToggleProject,
  onCreateProject,
  onAddToProjects,
}: {
  apiBase: string;
  showInstallModal: boolean;
  showFolderPicker: boolean;
  previewData: PreviewData | null;
  previewSkips: Set<string>;
  installPending: boolean;
  previewPending: boolean;
  installSource: string;
  installMessage: PluginMessage | null;
  message: PluginMessage | null;
  removeConfirm: string | null;
  layoutAssignment: {
    pluginName: string;
    displayName: string;
    layoutSlug: string;
  } | null;
  projects: Array<{
    slug: string;
    name: string;
    icon?: string;
    layoutCount: number;
  }>;
  quickProjectName: string;
  selectedProjects: Set<string>;
  assigningLayout: boolean;
  onChangeSource: (value: string) => void;
  onBrowse: () => void;
  onInstall: () => void;
  onCloseInstall: () => void;
  onSelectFolder: (value: string) => void;
  onCloseFolderPicker: () => void;
  onClosePreview: () => void;
  onToggleSkip: (key: string) => void;
  onConfirmInstall: () => void;
  onCancelRemove: () => void;
  onConfirmRemove: (name: string) => void;
  onCloseLayoutAssignment: () => void;
  onToggleProject: (slug: string, checked: boolean) => void;
  onCreateProject: () => Promise<void>;
  onAddToProjects: () => Promise<void>;
}) {
  return (
    <>
      {showInstallModal && (
        <InstallPluginModal
          apiBase={apiBase}
          installSource={installSource}
          installMessage={installMessage}
          installPending={installPending}
          previewPending={previewPending}
          onChangeSource={onChangeSource}
          onBrowse={onBrowse}
          onInstall={onInstall}
          onClose={onCloseInstall}
        />
      )}

      {showFolderPicker && (
        <FolderPickerModal
          onSelect={onSelectFolder}
          onClose={onCloseFolderPicker}
        />
      )}

      {previewData && (
        <InstallPreviewModal
          previewData={previewData}
          previewSkips={previewSkips}
          installPending={installPending}
          onClose={onClosePreview}
          onToggleSkip={onToggleSkip}
          onConfirm={onConfirmInstall}
        />
      )}

      {installPending && (
        <ResponsiveDialogSurface
          onClose={() => undefined}
          ariaLabel="Installing plugin"
          overlayClassName="plugins__modal-overlay"
          panelClassName="plugins__installing-card"
          dismissible={false}
          layer="system"
        >
          <div className="plugins__installing-spinner" />
          <p className="plugins__installing-text">
            {message?.text || 'Installing plugin…'}
          </p>
        </ResponsiveDialogSurface>
      )}

      {removeConfirm && (
        <ResponsiveDialogSurface
          onClose={onCancelRemove}
          ariaLabelledBy="remove-plugin-title"
          overlayClassName="plugins__confirm-overlay"
          panelClassName="plugins__confirm"
        >
          <h3 id="remove-plugin-title">Remove Plugin</h3>
          <p>Remove &ldquo;{removeConfirm}&rdquo;? This cannot be undone.</p>
          <ResponsiveSurfaceActions className="plugins__confirm-actions">
            <button
              type="button"
              className="plugins__confirm-cancel"
              onClick={onCancelRemove}
            >
              Cancel
            </button>
            <button
              type="button"
              className="plugins__confirm-delete"
              onClick={() => onConfirmRemove(removeConfirm)}
            >
              Remove
            </button>
          </ResponsiveSurfaceActions>
        </ResponsiveDialogSurface>
      )}

      {layoutAssignment && (
        <LayoutAssignmentModal
          assignment={layoutAssignment}
          projects={projects}
          quickProjectName={quickProjectName}
          selectedProjects={selectedProjects}
          assigningLayout={assigningLayout}
          onClose={onCloseLayoutAssignment}
          onToggleProject={onToggleProject}
          onCreateProject={onCreateProject}
          onAddToProjects={onAddToProjects}
        />
      )}
    </>
  );
}
