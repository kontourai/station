import type { LayoutCatalogItem } from '@kontourai/station-contracts/distribution';
import { ProjectLayoutCatalog } from '../registry/ProjectLayoutCatalog';

interface NewProjectStarterPickerProps {
  codingStarter?: LayoutCatalogItem;
  gitWorkspaceDetected: boolean;
  recentLayouts: LayoutCatalogItem[];
  selectedLayoutId: string | null;
  onSelect: (id: string | null) => void;
  onBrowse: () => void;
}

/** Selection-only starter controls shared by the New Project form and browser. */
export function NewProjectStarterPicker({
  codingStarter,
  gitWorkspaceDetected,
  recentLayouts,
  selectedLayoutId,
  onSelect,
  onBrowse,
}: NewProjectStarterPickerProps) {
  return (
    <section
      className="new-project-modal__starter"
      aria-labelledby="new-project-starter-title"
    >
      <div className="new-project-modal__starter-heading">
        <div>
          <h4
            className="new-project-modal__panel-title"
            id="new-project-starter-title"
          >
            Starter layout
          </h4>
          <p className="new-project-modal__panel-copy">
            Choose an installed layout now, or create an empty project.
          </p>
        </div>
        <button
          type="button"
          className="editor-btn editor-btn--small"
          onClick={onBrowse}
        >
          Browse all
        </button>
      </div>

      <button
        type="button"
        className={`new-project-modal__none${selectedLayoutId === null ? ' new-project-modal__none--selected' : ''}`}
        aria-pressed={selectedLayoutId === null}
        onClick={() => onSelect(null)}
      >
        <span>
          <strong>Start without a layout</strong>
          <small>Create the project without a workspace view.</small>
        </span>
      </button>

      {gitWorkspaceDetected && codingStarter && (
        <div className="new-project-modal__starter-group">
          <p className="new-project-modal__starter-label">
            Recommended for this Git directory
          </p>
          <ProjectLayoutCatalog
            available={[codingStarter]}
            adding={null}
            loading={false}
            catalogError={false}
            onRetry={() => undefined}
            onSelect={(layout) => onSelect(layout.id)}
            selectedId={selectedLayoutId}
          />
        </div>
      )}

      {recentLayouts.length > 0 && (
        <div className="new-project-modal__starter-group">
          <p className="new-project-modal__starter-label">
            Recent on this device
          </p>
          <ProjectLayoutCatalog
            available={recentLayouts}
            adding={null}
            loading={false}
            catalogError={false}
            onRetry={() => undefined}
            onSelect={(layout) => onSelect(layout.id)}
            selectedId={selectedLayoutId}
          />
        </div>
      )}
    </section>
  );
}
