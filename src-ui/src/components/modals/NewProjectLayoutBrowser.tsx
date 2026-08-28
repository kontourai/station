import type { LayoutCatalogItem } from '@kontourai/station-contracts/distribution';
import { useLayoutEffect, useRef } from 'react';
import {
  ResponsiveDialogCloseButton,
  ResponsiveSurfaceActions,
} from '../ResponsiveDialogSurface';
import { ProjectLayoutCatalog } from '../registry/ProjectLayoutCatalog';

interface NewProjectLayoutBrowserBodyProps {
  available: LayoutCatalogItem[];
  loading: boolean;
  catalogError: unknown;
  selectedId: string | null;
  onRetry: () => void;
  onSelect: (id: string) => void;
  /**
   * Returns to the project draft form without closing the New Project modal
   * this is ALSO what the header's own close button does here
   * (archive#1825 2): the old nested dialog's close
   * button was already scoped this way ("Close layout browser", never
   * "Close new project") — fully exiting the flow is only reachable one
   * step back, from the draft form's own close button.
   */
  onBack: () => void;
}

/**
 * The New Project modal's "Browse all" step (archive#1825).
 *
 * Swaps in as this SAME modal's body — replacing `NewProjectForm` inside the
 * one `ResponsiveDialogSurface` `NewProjectModalContent` renders — instead of
 * opening a second, independently positioned dialog. The previous nested
 * `ResponsiveDialogSurface` never got the fixed/centered overlay geometry
 * `.new-project-modal__overlay` has (that CSS lived only on the outer
 * modal's own overlay class), so it fell into normal document flow and
 * rendered as a panel appended below the form's own Cancel/Create row — the
 * exact defect this fixes. A true body swap also directly matches what this
 * step's own copy already promised ("Your project details stay here while
 * you browse") and keeps the primary action (Create) entirely out of this
 * view rather than merely repositioned, since there's no "primary action"
 * while browsing — only "Back to project", still the last element on the
 * page either way.
 */
export function NewProjectLayoutBrowserBody({
  available,
  loading,
  catalogError,
  selectedId,
  onRetry,
  onSelect,
  onBack,
}: NewProjectLayoutBrowserBodyProps) {
  const headingRef = useRef<HTMLHeadingElement>(null);

  // The modal frame itself doesn't remount when swapping bodies (unlike the
  // old nested-dialog approach, which got a fresh focus trap for free) — move
  // focus onto the new heading so screen reader / keyboard users land inside
  // the content that just replaced the form instead of on a stale target.
  // `NewProjectModalContent` mirrors this for the reverse transition.
  useLayoutEffect(() => {
    headingRef.current?.focus();
  }, []);

  return (
    <>
      <div className="new-project-modal__header new-project-layout-browser__header">
        <div>
          <p className="new-project-modal__eyebrow">Starter layout</p>
          <h3
            ref={headingRef}
            className="new-project-modal__title"
            id="new-project-layout-browser-title"
            tabIndex={-1}
          >
            Browse installed layouts
          </h3>
          <p className="new-project-modal__subtitle">
            Choose one eligible layout for this project. Your project details
            stay here while you browse.
          </p>
        </div>
        <ResponsiveDialogCloseButton
          onClick={onBack}
          label="Close layout browser"
        />
      </div>
      <ProjectLayoutCatalog
        available={available}
        adding={null}
        loading={loading}
        catalogError={catalogError}
        onRetry={onRetry}
        onSelect={(layout) => onSelect(layout.id)}
        selectedId={selectedId}
      />
      <ResponsiveSurfaceActions className="new-project-layout-browser__actions">
        <button type="button" className="editor-btn" onClick={onBack}>
          Back to project
        </button>
      </ResponsiveSurfaceActions>
    </>
  );
}
