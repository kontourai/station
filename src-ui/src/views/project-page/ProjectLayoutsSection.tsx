import type { LayoutMetadata } from '@kontourai/station-contracts/layout';
import {
  ResponsiveDialogCloseButton,
  ResponsiveDialogSurface,
  ResponsiveSurfaceActions,
} from '../../components/ResponsiveDialogSurface';
import { ProjectLayoutCatalog } from '../../components/registry/ProjectLayoutCatalog';
import { Empty, ErrorState, SkeletonList } from '../../components/state';
import type { AvailableLayout } from './types';

export function ProjectLayoutsSection({
  slug,
  layouts,
  loading,
  error,
  onRetry,
  setLayout,
  onOpenAddLayout,
  embedded = false,
}: {
  slug: string;
  layouts: LayoutMetadata[];
/**
* True while the layouts query is still in flight. Without it an unresolved
* fetch is indistinguishable from a project that genuinely has no layouts,
* and the section states "No layouts yet" for a project that has some
 * (archive#801).
*/
  loading?: boolean;
/**
* True when the layouts query failed. A failure is not emptiness — react
* query clears `isLoading` on error, so without this the section would state
* "No layouts yet" for a project whose layouts merely could not be fetched
 * (archive#801).
*/
  error?: boolean;
  onRetry?: () => void;
  setLayout: (projectSlug: string, layoutSlug: string) => void;
  onOpenAddLayout: () => void;
  embedded?: boolean;
}) {
  const contents = (
    <div className="project-page__cards">
      {loading && layouts.length === 0 ? (
        <SkeletonList count={2} />
      ) : error && layouts.length === 0 ? (
        <ErrorState
          title="Could not load layouts"
          description="Station could not read this project's layouts."
          action={
            onRetry ? (
              <button type="button" onClick={onRetry}>
                Retry
              </button>
            ) : undefined
          }
        />
      ) : layouts.length > 0 ? (
        layouts.map((layout) => (
          <button
            type="button"
            key={layout.slug}
            className="project-page__card"
            onClick={() => setLayout(slug, layout.slug)}
          >
            {layout.icon && (
              <span className="project-page__card-icon">{layout.icon}</span>
            )}
            <span className="project-page__card-name">{layout.name}</span>
            {layout.description && (
              <span className="project-page__card-desc">
                {layout.description}
              </span>
            )}
            <span className="project-page__card-type">{layout.type}</span>
          </button>
        ))
      ) : (
        <Empty
          variant="prominent"
          label="No layouts yet"
          action={
            <button
              type="button"
              className="button button--primary"
              onClick={onOpenAddLayout}
            >
              Add layout
            </button>
          }
        />
      )}
    </div>
  );
  if (embedded) return contents;
  return (
    <div className="project-page__layouts">
      <div className="project-page__section-header">
        <span className="project-page__section-label">Open</span>
        <button
          type="button"
          className="project-page__add-btn"
          onClick={onOpenAddLayout}
        >
          + Add layout
        </button>
      </div>
      {contents}
    </div>
  );
}

export function ProjectAddLayoutModal({
  show,
  available,
  appliedLayouts = [],
  adding,
  applyError,
  loading,
  catalogError,
  onClose,
  onRetry,
  onAddLayout,
}: {
  show: boolean;
  available: AvailableLayout[];
  appliedLayouts?: LayoutMetadata[];
  adding: string | null;
/** The last apply failure, surfaced in the picker (4-HOME-014). */
  applyError?: unknown;
  loading: boolean;
  catalogError: unknown;
  onClose: () => void;
  onRetry: () => void;
  onAddLayout: (item: AvailableLayout) => void;
}) {
  if (!show) {
    return null;
  }

  return (
    <ResponsiveDialogSurface
      onClose={onClose}
      ariaLabelledBy="project-add-layout-title"
      overlayClassName="project-page__modal-overlay"
      panelClassName="project-page__modal"
    >
      <div className="project-page__modal-header">
        <h3 id="project-add-layout-title" className="project-page__modal-title">
          Add Layout
        </h3>
        <ResponsiveDialogCloseButton
          label="Close layout picker"
          onClick={onClose}
        />
      </div>
      <p className="project-page__modal-description">
        Choose an installed, enabled workspace view from this distribution.
      </p>
      <ProjectLayoutCatalog
        available={available}
        appliedLayouts={appliedLayouts}
        adding={adding}
        applyError={applyError}
        loading={loading}
        catalogError={catalogError}
        onRetry={onRetry}
        onSelect={onAddLayout}
      />
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
