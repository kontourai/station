import type { WorkspacePaneAvailabilityAction } from '@kontourai/station-contracts/workspace-pane-availability';
import {
  ResponsiveDialogCloseButton,
  ResponsiveDialogSurface,
  ResponsiveSurfaceActions,
} from '../components/ResponsiveDialogSurface';
import { Empty, ErrorState, SkeletonList } from '../components/state';
import type { ResolvedWorkspacePaneCatalogEntry } from './resolvedWorkspacePaneCatalog';
import { WorkspacePaneAvailabilityList } from './WorkspacePaneAvailabilityList';
import type { WorkspacePaneAvailabilityCatalogEntry } from './workspacePaneAvailabilityPresentation';

interface CatalogProps {
  entries: readonly ResolvedWorkspacePaneCatalogEntry[];
  loading: boolean;
  error: boolean;
  onRetry: () => void;
  onSelect: (entry: WorkspacePaneAvailabilityCatalogEntry) => void;
  onAction: (
    entry: WorkspacePaneAvailabilityCatalogEntry,
    action: WorkspacePaneAvailabilityAction,
  ) => string;
  canExecuteAction: (
    entry: WorkspacePaneAvailabilityCatalogEntry,
    action: WorkspacePaneAvailabilityAction,
  ) => boolean;
  isOpen?: (entry: WorkspacePaneAvailabilityCatalogEntry) => boolean;
  onReviewInRegistry?: () => void;
}

function CatalogContents({
  entries,
  loading,
  error,
  onRetry,
  onSelect,
  onAction,
  canExecuteAction,
  isOpen,
  onReviewInRegistry,
}: CatalogProps) {
  if (loading && entries.length === 0) {
    return <SkeletonList count={2} label="Loading workspace panes" />;
  }
  if (error && entries.length === 0) {
    return (
      <ErrorState
        title="Could not load workspace panes"
        description="Station could not read this Project’s pane catalog."
        action={
          <button type="button" onClick={onRetry}>
            Retry
          </button>
        }
      />
    );
  }
  // The picker's own title already names the noun ("Add workspace pane"), so
  // the label collapses to the family's shared phrasing (#192 ratchet) and the
  // description carries the only information the old "No workspace panes are
  // known…" label added.
  if (entries.length === 0) {
    return (
      <Empty
        variant="compact"
        label="Nothing here yet"
        description="Station has not discovered any panes for this Project."
      />
    );
  }
  return (
    <WorkspacePaneAvailabilityList
      entries={entries}
      aria-label="Workspace panes"
      onSelect={onSelect}
      onAction={onAction}
      canExecuteAction={canExecuteAction}
      isOpen={isOpen}
      onReviewInRegistry={onReviewInRegistry}
    />
  );
}

export function ProjectWorkspacePaneModal({
  show,
  onClose,
  ...catalog
}: CatalogProps & { show: boolean; onClose: () => void }) {
  if (!show) return null;
  return (
    <ResponsiveDialogSurface
      onClose={onClose}
      ariaLabelledBy="project-add-pane-title"
      overlayClassName="project-page__modal-overlay"
      panelClassName="project-page__modal"
    >
      <div className="project-page__modal-header">
        <h3 id="project-add-pane-title" className="project-page__modal-title">
          Add workspace pane
        </h3>
        <ResponsiveDialogCloseButton
          label="Close pane picker"
          onClick={onClose}
        />
      </div>
      <p className="project-page__modal-description">
        Every known pane is listed. Available panes open directly; the others
        carry their state as a badge with the next step.
      </p>
      <CatalogContents {...catalog} />
      <ResponsiveSurfaceActions className="project-page__modal-cancel">
        <button
          type="button"
          className="project-page__add-btn"
          onClick={onClose}
        >
          Cancel
        </button>
      </ResponsiveSurfaceActions>
    </ResponsiveDialogSurface>
  );
}
