import { Checkbox } from '../../components/Checkbox';
import { CheckGlyph, WarningGlyph } from '../../components/icons/Glyph';
import {
  ResponsiveDialogCloseButton,
  ResponsiveDialogSurface,
  ResponsiveSurfaceActions,
} from '../../components/ResponsiveDialogSurface';
import type { PreviewData } from './types';

export function InstallPreviewModal({
  previewData,
  previewSkips,
  installPending,
  onClose,
  onToggleSkip,
  onConfirm,
}: {
  previewData: PreviewData;
  previewSkips: Set<string>;
  installPending: boolean;
  onClose: () => void;
  onToggleSkip: (key: string) => void;
  onConfirm: () => void;
}) {
  const hasBlockingConflict = previewData.components.some(
    (component) => component.skippable === false && !!component.conflict,
  );
  return (
    <ResponsiveDialogSurface
      onClose={onClose}
      ariaLabelledBy="install-preview-title"
      overlayClassName="plugins__modal-overlay"
      panelClassName="plugins__modal"
    >
      <div className="plugins__modal-header">
        <h3 id="install-preview-title" className="plugins__modal-title">
          Install Preview
        </h3>
        <ResponsiveDialogCloseButton
          onClick={onClose}
          label="Close install preview"
        />
      </div>
      <div className="plugins__modal-body">
        <div className="plugins__preview-header">
          <strong>
            {previewData.manifest?.displayName || previewData.manifest?.name}
          </strong>
          <span className="plugins__card-version plugins__preview-version">
            v{previewData.manifest?.version}
          </span>
          {previewData.git && (
            <span className="plugins__cap plugins__cap--ref plugins__preview-version">
              {previewData.git.branch}@{previewData.git.hash}
            </span>
          )}
          {previewData.manifest?.description && (
            <div className="plugins__card-desc plugins__preview-desc">
              {previewData.manifest.description}
            </div>
          )}
        </div>
        {previewData.conflicts.length > 0 && (
          <div className="plugins__modal-message plugins__message--error plugins__preview-conflicts">
            {previewData.conflicts.length} conflict
            {previewData.conflicts.length > 1 ? 's' : ''} detected — conflicting
            components are unchecked by default
          </div>
        )}
        <div className="plugins__registry-list">
          {previewData.components.map((component) => {
            const key = `${component.type}:${component.id}`;
            const skippable = component.skippable !== false;
            const skipped = skippable && previewSkips.has(key);
            return (
              <div
                key={key}
                className={`plugins__registry-item${skipped ? ' plugins__registry-item--skipped' : ''}`}
              >
                <div className="plugins__preview-label">
                  <Checkbox
                    checked={!skipped}
                    disabled={!skippable}
                    onChange={() => {
                      if (skippable) onToggleSkip(key);
                    }}
                  >
                    <span
                      className={`plugins__cap plugins__cap--${component.type === 'agent' ? 'agent' : component.type === 'workspace' ? 'workspace' : component.type === 'provider' ? 'provider' : 'bundle'}`}
                    >
                      {component.type}
                    </span>
                    <span>{component.id}</span>
                  </Checkbox>
                </div>
                {component.conflict && (
                  <span className="plugins__preview-conflict-tag">
                    <WarningGlyph /> conflict
                    {component.conflict.existingSource
                      ? ` (${component.conflict.existingSource})`
                      : ''}
                  </span>
                )}
                {!skippable && (
                  <span className="plugins__preview-conflict-tag">
                    Required package declaration — resolve the conflict before
                    install
                  </span>
                )}
              </div>
            );
          })}
        </div>
        {previewData.dependencies && previewData.dependencies.length > 0 && (
          <div className="plugins__preview-deps">
            <div className="plugins__preview-deps-label">
              Dependencies ({previewData.dependencies.length})
            </div>
            <div className="plugins__registry-list">
              {previewData.dependencies.map((dependency) => (
                <div
                  key={dependency.id}
                  className="plugins__registry-item plugins__preview-dep-item"
                >
                  <div className="plugins__preview-dep-row">
                    <span className="plugins__cap plugins__cap--bundle">
                      dep
                    </span>
                    <span>{dependency.id}</span>
                    {dependency.git && (
                      <span className="plugins__cap plugins__cap--ref plugins__cap--sm">
                        {dependency.git.branch}@{dependency.git.hash}
                      </span>
                    )}
                    <span className="plugins__preview-dep-status">
                      {dependency.status === 'installed' ? (
                        <>
                          <CheckGlyph /> installed
                        </>
                      ) : dependency.status === 'will-install' ? (
                        '↓ will install'
                      ) : (
                        <>
                          <WarningGlyph /> missing
                        </>
                      )}
                    </span>
                  </div>
                  {dependency.components &&
                    dependency.components.length > 0 && (
                      <div className="plugins__preview-dep-components">
                        {dependency.components.map((component) => (
                          <span
                            key={`${component.type}:${component.id}`}
                            className={`plugins__cap plugins__cap--sm plugins__cap--${component.type === 'agent' ? 'agent' : component.type === 'workspace' ? 'workspace' : 'provider'}`}
                          >
                            {component.type}:{component.id}
                          </span>
                        ))}
                      </div>
                    )}
                </div>
              ))}
            </div>
          </div>
        )}
        <ResponsiveSurfaceActions className="plugins__preview-actions">
          <button
            type="button"
            className="plugins__confirm-cancel"
            onClick={onClose}
          >
            Cancel
          </button>
          <button
            type="button"
            className="plugins__install-btn"
            onClick={onConfirm}
            disabled={installPending || hasBlockingConflict}
          >
            {installPending ? 'Installing...' : 'Confirm Install'}
          </button>
        </ResponsiveSurfaceActions>
      </div>
    </ResponsiveDialogSurface>
  );
}
