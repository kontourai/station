import type { WorkspacePaneAvailabilityAction } from '@kontourai/station-contracts/workspace-pane-availability';
import { PageCallout } from '../components/PageCallout';
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
  notice,
  ...catalog
}: CatalogProps & {
  show: boolean;
  onClose: () => void;
  /**
   * One sentence about the last selection this picker could not complete
   * (#1596). The list stays interactive underneath it: a refusal is
   * information, not the end of the task, and one of the reasons
   * (`no-lease`) can resolve while the picker is still on screen.
   */
  notice?: string | null;
}) {
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
      {notice ? (
        <PageCallout
          calloutId="workspace-pane-open-refused"
          tone="warning"
          // `alert`, not `status`: this callout is MOUNTED by the click it
          // answers, and a polite region inserted already holding its text is
          // not reliably announced — which would leave a screen-reader user
          // with the "nothing happened" #1596 exists to close. The Browser
          // Preview launcher's refusal already uses `alert` for the same
          // reason.
          role="alert"
          ariaLabel="Workspace pane could not open"
        >
          {notice}
        </PageCallout>
      ) : null}
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
