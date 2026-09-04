import type {
  SkillImportFile,
  SkillImportResultRow,
} from '@kontourai/station-sdk';
import { useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Button } from '../Button';
import { Dialog } from '../Dialog';
import { SkeletonBlock } from '../state';
import './ImportSkillsModal.css';

interface ImportSkillsModalProps {
  isOpen: boolean;
  pending: boolean;
  /**
   * Per-file outcomes from the last import, or `null` before one has run.
   * Rendered rather than summarised: `POST /api/skills/import` answers 207 when
   * some files landed and some did not, and a toast saying "imported 3" over a
   * 207 hides which two failed and why.
   */
  results: SkillImportResultRow[] | null;
  error: string | null;
  onImport: (files: SkillImportFile[]) => void;
  onCancel: () => void;
}

/**
 * Import `.md` files as skills.
 *
 * The files are sent VERBATIM, in one request. Frontmatter is read by the
 * server's own parser — the same one discovery uses — so an imported file's
 * `command:` block means exactly what it would mean on disk, and a client-side
 * re-parse cannot disagree with it.
 */
export function ImportSkillsModal({
  isOpen,
  pending,
  results,
  error,
  onImport,
  onCancel,
}: ImportSkillsModalProps) {
  const [files, setFiles] = useState<SkillImportFile[]>([]);
  const [isReading, setIsReading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  async function handleFileSelect(event: React.ChangeEvent<HTMLInputElement>) {
    const chosen = Array.from(event.target.files || []).filter((file) =>
      file.name.endsWith('.md'),
    );
    setIsReading(true);
    const read: SkillImportFile[] = [];
    for (const file of chosen) {
      read.push({ filename: file.name, content: await file.text() });
    }
    setFiles(read);
    setIsReading(false);
  }

  function handleCancel() {
    setFiles([]);
    onCancel();
  }

  if (!isOpen) return null;

  // #1180: rendered where `SkillsView` places it — a plain sibling of
  // `SplitPaneLayout`, inside the route frame `PageFrame` marks `inert`
  // while that layout's mobile detail sheet is open (PageFrame.tsx:155).
  // Unlike `SkillRunModal`, this dialog's OWN trigger ("Import .md") lives in
  // the list pane, which a phone hides the instant a sheet is showing — so
  // the exposure here needs the opposite ordering: open this dialog while
  // the list is up, then let the URL selection (`useUrlSelection`, e.g. a
  // deep link or Back/Forward) select a skill underneath it. That selection
  // does not touch this dialog, but it does turn its ancestor `inert` —
  // silently dropping it from focus and hit testing. `createPortal` to
  // `document.body`, the same escape `ConfirmModal` and `PluginModalStack`
  // (#1131) already use, moves the DOM node out of that ancestor; React
  // context and event bubbling still follow the component tree.
  return createPortal(
    <Dialog
      title="Import Skills"
      closeLabel="Close import skills"
      onClose={handleCancel}
      size="lg"
      panelClassName="import-modal__dialog"
      footer={
        <>
          <Button variant="secondary" onClick={handleCancel}>
            Cancel
          </Button>
          <Button
            variant="primary"
            onClick={() => onImport(files)}
            pending={pending}
            pendingLabel="Importing…"
            disabled={files.length === 0}
          >
            Import {files.length > 0 ? files.length : ''}
          </Button>
        </>
      }
    >
      <div className="import-modal__body">
        <input
          ref={fileInputRef}
          type="file"
          accept=".md"
          multiple
          onChange={handleFileSelect}
          hidden
        />
        {files.length === 0 && !isReading && (
          <Button
            variant="secondary"
            className="import-modal__file-btn"
            onClick={() => fileInputRef.current?.click()}
          >
            Choose .md files
          </Button>
        )}

        {isReading && <SkeletonBlock count={2} label="Reading files" />}

        {files.length > 0 && !isReading && (
          <div className="import-modal__preview-header">
            <strong className="import-modal__preview-title">
              {files.length} file{files.length !== 1 ? 's' : ''} to import
            </strong>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => fileInputRef.current?.click()}
            >
              Add more
            </Button>
          </div>
        )}

        {files.length > 0 && !isReading && (
          <div className="import-modal__preview-list">
            {files.map((file) => (
              <div key={file.filename} className="import-modal__preview-item">
                <span className="import-modal__file-label">
                  {file.filename}
                </span>
              </div>
            ))}
          </div>
        )}

        {results && (
          <div className="import-modal__preview-list">
            {results.map((row) => (
              <div key={row.filename} className="import-modal__preview-item">
                <span className="import-modal__file-label">
                  {row.filename} —{' '}
                  {row.success
                    ? `imported as ${row.name}`
                    : (row.error ?? 'failed')}
                </span>
              </div>
            ))}
          </div>
        )}
        {error && (
          <p className="editor-error" role="alert">
            {error}
          </p>
        )}
      </div>
    </Dialog>,
    document.body,
  );
}
