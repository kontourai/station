import type { PluginLifecycleProposal } from '@kontourai/station-contracts/plugin';
import { createPortal } from 'react-dom';
import { FolderBrowserModal } from '../../components/modals/FolderBrowserModal';
import { PluginProposalSummary } from '../../components/plugins/PluginProposalSummary';
import {
  ResponsiveDialogSurface,
  ResponsiveSurfaceActions,
} from '../../components/ResponsiveDialogSurface';
import { InstallPluginModal } from './InstallPluginModal';
import { InstallPreviewModal } from './InstallPreviewModal';
import { LayoutAssignmentModal } from './LayoutAssignmentModal';
import type { PluginMessage, PreviewData } from './types';

export function PluginModalStack({
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
  removalRetainsData = false,
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
  proposal = null,
  updateConfirm = null,
  onConfirmUpdate = () => undefined,
  onCancelUpdate = () => undefined,
}: {
  /** #2323 S5: the agent proposal being completed, for provenance only. */
  proposal?: PluginLifecycleProposal | null;
  /** #2323 S5: an open update proposal awaiting the person's confirmation. */
  updateConfirm?: PluginLifecycleProposal | null;
  onConfirmUpdate?: () => void;
  onCancelUpdate?: () => void;
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
  removalRetainsData?: boolean;
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
  onConfirmInstall: (dataPolicy?: 'preserve' | 'retain-and-reset') => void;
  onCancelRemove: () => void;
  onConfirmRemove: (name: string) => void;
  onCloseLayoutAssignment: () => void;
  onToggleProject: (slug: string, checked: boolean) => void;
  onCreateProject: () => Promise<void>;
  onAddToProjects: () => Promise<void>;
}) {
  // #1131: rendered where `PluginManagementView` places it — a plain sibling
  // of `SplitPaneLayout`, inside the route frame `PageFrame` marks `inert`
  // while that layout's mobile detail sheet is open (PageFrame.tsx). The
  // sheet's own content escapes through `usePageFrameMobileDetailSlot`, a
  // portal target `PageFrame` renders as a SIBLING of the inert frame div —
  // but this stack is not that content; it opens from actions (Install,
  // Remove, …) that live inside the sheet, and rendered in place it was a
  // descendant of the inert subtree. `inert` makes a focusable, connected,
  // correctly-sized panel silently refuse `.focus()` and drop out of hit
  // testing, so `ResponsiveDialogSurface`'s own focus/return-focus machinery
  // ran without any visible effect and every button in these dialogs stopped
  // being clickable. Portalling to `document.body` — the same escape
  // `ConfirmModal` already uses, for the same reason — moves the DOM node
  // out of the inert ancestor without touching `inert` itself (still needed
  // to keep the backdrop out of the accessibility tree). This changes DOM
  // placement only: React context and event bubbling still follow the
  // React tree, so nothing else here needed to change.
  return createPortal(
    <>
      {showInstallModal && (
        <InstallPluginModal
          installSource={installSource}
          installMessage={installMessage}
          installPending={installPending}
          previewPending={previewPending}
          onChangeSource={onChangeSource}
          onBrowse={onBrowse}
          onInstall={onInstall}
          onClose={onCloseInstall}
          proposal={proposal?.kind === 'install' ? proposal : null}
        />
      )}

      {showFolderPicker && (
        <FolderBrowserModal
          onSelect={onSelectFolder}
          onClose={onCloseFolderPicker}
          titleId="folder-picker-title"
          closeLabel="Close folder picker"
          classNames={{
            overlay: 'plugins__modal-overlay',
            panel: 'plugins__modal plugins__folder-modal',
            header: 'plugins__modal-header',
            title: 'plugins__modal-title',
            body: 'plugins__modal-body',
            message: 'plugins__modal-message',
            messageError: 'plugins__message--error',
            pathRow: 'plugins__folder-path',
            selectButton: 'plugins__folder-select-btn',
            list: 'plugins__folder-list',
            entry: 'plugins__folder-entry',
            icon: 'plugins__folder-icon',
            name: 'plugins__folder-name',
          }}
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
          proposal={proposal?.kind === 'install' ? proposal : null}
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
          layer="dialog"
          onClose={onCancelRemove}
          ariaLabelledBy="remove-plugin-title"
          overlayClassName="plugins__confirm-overlay"
          panelClassName="plugins__confirm"
        >
          <h3 id="remove-plugin-title">Remove Plugin</h3>
          <p>
            Remove &ldquo;{removeConfirm}&rdquo; from Station?
            {removalRetainsData
              ? ' Its stored data and code versions will be retained.'
              : ' This cannot be undone.'}
          </p>
          {proposal?.kind === 'remove' &&
            proposal.pluginName === removeConfirm && (
              <PluginProposalSummary
                author={proposal.author}
                rationale={proposal.rationale}
                testId="remove-plugin-proposal"
              />
            )}
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

      {updateConfirm && (
        <ResponsiveDialogSurface
          layer="dialog"
          onClose={onCancelUpdate}
          ariaLabelledBy="update-plugin-title"
          overlayClassName="plugins__confirm-overlay"
          panelClassName="plugins__confirm"
        >
          <h3 id="update-plugin-title">Update Plugin</h3>
          <p>
            Update &ldquo;{updateConfirm.pluginName}&rdquo;? Station pulls the
            plugin&rsquo;s latest code from its source.
          </p>
          <PluginProposalSummary
            author={updateConfirm.author}
            rationale={updateConfirm.rationale}
            testId="update-plugin-proposal"
          />
          <ResponsiveSurfaceActions className="plugins__confirm-actions">
            <button
              type="button"
              className="plugins__confirm-cancel"
              onClick={onCancelUpdate}
            >
              Cancel
            </button>
            <button
              type="button"
              className="plugins__install-btn"
              onClick={onConfirmUpdate}
            >
              Update
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
    </>,
    document.body,
  );
}
