import type { WorkspacePaneAvailabilityAction } from '@kontourai/station-contracts/workspace-pane-availability';
import { Button } from '../components/Button';
import { Dialog } from '../components/Dialog';
import { PageCallout } from '../components/PageCallout';
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

/**
 * The pane picker, mounted from BOTH `views/ProjectPage.tsx` and
 * `app-shell/ProjectLayoutRenderer.tsx` — two separately lazy-loaded routes.
 *
 * #1616: it used to hand `ResponsiveDialogSurface` the project page's own
 * `project-page__modal-overlay`/`project-page__modal` classes, which are
 * defined in `views/ProjectPage.css` — a stylesheet only `ProjectPage.tsx`
 * imports, so Vite emits it in the project-page chunk. On
 * `/projects/:slug/layouts/:layout` that chunk never loads, and the overlay
 * fell back to `.responsive-surface-overlay` alone, which sets no `position`:
 * measured `position: static`, `display: block`, transparent background, laid
 * out at x=240 inside the pane instead of covering the 1440x900 viewport. The
 * catalog rendered inline and unstyled, shoving the layout down the page.
 *
 * `scripts/dialog-surface-class-guard.mjs` could not see it: that gate proves
 * a class is DEFINED in some stylesheet under `src-ui/src`, which says nothing
 * about whether the defining chunk is LOADED where the component renders.
 *
 * So this composes `Dialog` instead. Its `station-dialog__*` chrome lives in
 * the eagerly loaded `index.css` precisely so a dialog cannot depend on a
 * lazily imported stylesheet reaching it first — the reason given verbatim in
 * `Dialog`'s own docblock and in `ResponsiveDialogHeader`'s. Every route that
 * mounts this picker gets the overlay geometry by construction, and no rule
 * is duplicated to achieve it.
 */
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
    <Dialog
      title="Add workspace pane"
      subtitle="Every known pane is listed. Available panes open directly; the others carry their state as a badge with the next step."
      closeLabel="Close pane picker"
      size="lg"
      onClose={onClose}
      footer={<Button onClick={onClose}>Cancel</Button>}
    >
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
    </Dialog>
  );
}
