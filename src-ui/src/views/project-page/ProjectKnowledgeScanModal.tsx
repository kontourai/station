import { FolderGlyph, WarningGlyph } from '../../components/icons/Glyph';
import {
  ResponsiveDialogSurface,
  ResponsiveSurfaceActions,
} from '../../components/ResponsiveDialogSurface';
import { describeReadFailure, ErrorState } from '../../components/state';

interface ProjectKnowledgeScanModalProps {
  projectWorkingDirectory?: string;
  scanInclude: string;
  scanExclude: string;
  scanning: boolean;
  scanFailure?: unknown;
  onClose: () => void;
  onScan: () => void;
  onScanIncludeChange: (value: string) => void;
  onScanExcludeChange: (value: string) => void;
}

export function ProjectKnowledgeScanModal({
  projectWorkingDirectory,
  scanInclude,
  scanExclude,
  scanning,
  scanFailure,
  onClose,
  onScan,
  onScanIncludeChange,
  onScanExcludeChange,
}: ProjectKnowledgeScanModalProps) {
  return (
    <ResponsiveDialogSurface
      onClose={onClose}
      ariaLabelledBy="project-knowledge-scan-title"
      overlayClassName="project-page__modal-overlay"
      panelClassName="project-page__modal"
    >
      <h3
        id="project-knowledge-scan-title"
        className="project-page__modal-title"
      >
        Index Working Directory
      </h3>
      <div className="project-page__scan-warning">
        <WarningGlyph /> This will scan and index files from your working
        directory into the project&apos;s vector database. Files are chunked and
        embedded for semantic search.
      </div>
      <div className="project-page__scan-path">
        <FolderGlyph /> {projectWorkingDirectory}
      </div>
      <div className="project-page__scan-fields">
        <label className="project-page__scan-label">
          Include patterns
          <span className="project-page__scan-hint">
            comma-separated globs, e.g. src/**, docs/**
          </span>
          <input
            className="project-page__scan-input"
            type="text"
            value={scanInclude}
            onChange={(event) => onScanIncludeChange(event.target.value)}
            placeholder="Leave empty to include all"
          />
        </label>
        <label className="project-page__scan-label">
          Exclude patterns
          <span className="project-page__scan-hint">
            comma-separated globs, e.g. **/*.test.ts, dist/**
          </span>
          <input
            className="project-page__scan-input"
            type="text"
            value={scanExclude}
            onChange={(event) => onScanExcludeChange(event.target.value)}
            placeholder="node_modules, .git, dist already excluded"
          />
        </label>
      </div>
      {scanFailure != null && (
        <ErrorState
          variant="compact"
          title="Couldn't index the working directory"
          description={describeReadFailure(scanFailure)}
        />
      )}
      <ResponsiveSurfaceActions className="project-page__scan-actions">
        <button
          type="button"
          className="project-page__add-btn"
          onClick={onClose}
          disabled={scanning}
        >
          Cancel
        </button>
        <button
          type="button"
          className="project-page__add-btn project-page__add-btn--primary"
          onClick={onScan}
          disabled={scanning}
        >
          {scanning ? 'Indexing…' : 'Index Files'}
        </button>
      </ResponsiveSurfaceActions>
    </ResponsiveDialogSurface>
  );
}
