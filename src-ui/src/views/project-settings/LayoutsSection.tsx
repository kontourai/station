import type { LayoutMetadata } from '@kontourai/station-contracts/layout';
import {
  useApplyProjectLayoutMutation,
  useAvailableProjectLayoutsQuery,
  useDeleteProjectLayoutMutation,
  useProjectLayoutsQuery,
} from '@kontourai/station-sdk';
import { useState } from 'react';
import { ConfirmModal } from '../../components/modals/ConfirmModal';
import { PageSection } from '../../components/PageSection';
import {
  ResponsiveDialogCloseButton,
  ResponsiveDialogSurface,
  ResponsiveSurfaceActions,
} from '../../components/ResponsiveDialogSurface';
import { ProjectLayoutCatalog } from '../../components/registry/ProjectLayoutCatalog';
import { Empty, ErrorState } from '../../components/state';
import { trackRecentLayout } from '../../hooks/useRecentLayouts';

export function LayoutsSection({ slug }: { slug: string }) {
  const [showAdd, setShowAdd] = useState(false);
  const [adding, setAdding] = useState<string | null>(null);
  const [applyError, setApplyError] = useState<unknown>(null);
  const [pendingRemoval, setPendingRemoval] = useState<LayoutMetadata | null>(
    null,
  );
  const [removeError, setRemoveError] = useState<string | null>(null);
  const layoutCatalog = useAvailableProjectLayoutsQuery({ enabled: showAdd });
  const availableLayouts = layoutCatalog.data ?? [];

  const { data: projectLayouts = [] } = useProjectLayoutsQuery(slug) as {
    data?: LayoutMetadata[];
  };

  // 4-HOME-014: removal had no error path at all — `mutate` with no callbacks
  // meant a refused delete left the row in place with nothing said.
  const removeMutation = useDeleteProjectLayoutMutation(slug, {
    onSuccess: () => setRemoveError(null),
    onError: (error) =>
      setRemoveError(
        error?.message || 'Station could not remove this layout. Try again.',
      ),
  });
  const applyLayoutMutation = useApplyProjectLayoutMutation(slug);

  async function addLayout(item: (typeof availableLayouts)[0]) {
    setAdding(item.slug);
    setApplyError(null);
    try {
      await applyLayoutMutation.mutateAsync(item.id);
      trackRecentLayout(item.id);
      setShowAdd(false);
    } catch (error: unknown) {
      // 4-HOME-014: this was `catch { /* ignore */ }`. The picker stayed open
      // with no message, which is indistinguishable from a click that never
      // registered.
      setApplyError(error);
    }
    setAdding(null);
  }

  function confirmRemoval() {
    const layout = pendingRemoval;
    setPendingRemoval(null);
    if (!layout) return;
    setRemoveError(null);
    removeMutation.mutate(layout.slug);
  }

  return (
    <PageSection
      id="section-layouts"
      className="project-settings__section knowledge-section"
      eyebrow="Workspace views"
      title="Layouts"
      description="Add focused views for the work this project needs."
      actions={
        <button
          type="button"
          className="knowledge-section__action-btn"
          onClick={() => {
            setApplyError(null);
            setShowAdd(true);
          }}
        >
          + Add Layout
        </button>
      }
    >
      {projectLayouts.length > 0 ? (
        <div className="knowledge-section__doc-list">
          {projectLayouts.map((layout) => (
            <div key={layout.id} className="knowledge-section__doc">
              <span className="knowledge-section__doc-name">
                {layout.icon && `${layout.icon} `}
                {layout.name}
              </span>
              <span className="knowledge-section__badge">{layout.type}</span>
              <button
                type="button"
                className="knowledge-section__doc-remove"
                onClick={() => setPendingRemoval(layout)}
                title="Remove layout"
                aria-label={`Remove ${layout.name}`}
              >
                ×
              </button>
            </div>
          ))}
        </div>
      ) : (
        <Empty
          variant="compact"
          label="This project doesn't have any layouts yet"
          description="Add a layout to give this project its own workspace arrangement."
          action={
            <button
              type="button"
              className="knowledge-section__action-btn"
              onClick={() => setShowAdd(true)}
            >
              Add Layout
            </button>
          }
        />
      )}

      {removeError && (
        <ErrorState
          variant="compact"
          title="Couldn't remove that layout"
          description={removeError}
        />
      )}

      {showAdd && (
        <ResponsiveDialogSurface
          onClose={() => setShowAdd(false)}
          ariaLabelledBy="project-settings-add-layout-title"
          overlayClassName="project-dashboard__modal-overlay"
          panelClassName="project-dashboard__modal"
        >
          <div className="project-settings__modal-header">
            <h3
              id="project-settings-add-layout-title"
              className="knowledge-section__title"
            >
              Add Layout
            </h3>
            <ResponsiveDialogCloseButton
              label="Close layout picker"
              onClick={() => setShowAdd(false)}
            />
          </div>
          <p className="project-settings__modal-description">
            Choose an installed, enabled workspace view from this distribution.
          </p>
          <ProjectLayoutCatalog
            available={availableLayouts}
            appliedLayouts={projectLayouts}
            adding={adding}
            applyError={applyError}
            loading={layoutCatalog.isLoading}
            catalogError={layoutCatalog.error}
            onRetry={() => void layoutCatalog.refetch()}
            onSelect={addLayout}
          />
          <ResponsiveSurfaceActions className="project-settings__actions">
            <button
              type="button"
              className="knowledge-section__action-btn"
              onClick={() => setShowAdd(false)}
            >
              Cancel
            </button>
          </ResponsiveSurfaceActions>
        </ResponsiveDialogSurface>
      )}

      {/* Removal is destructive and was a bare `×` with no confirmation,
          while Delete Project on this same page has one. */}
      <ConfirmModal
        isOpen={pendingRemoval !== null}
        role="alertdialog"
        variant="danger"
        title="Remove layout"
        message={`Remove "${pendingRemoval?.name ?? ''}" from this project? Its workspace arrangement is deleted.`}
        confirmLabel="Remove"
        onConfirm={confirmRemoval}
        onCancel={() => setPendingRemoval(null)}
      />
    </PageSection>
  );
}
