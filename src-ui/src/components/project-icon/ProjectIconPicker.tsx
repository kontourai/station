import {
  PROJECT_ICON_IMAGE_MEDIA_TYPES,
  PROJECT_ICON_MAX_IMAGE_BYTES,
  PROJECT_ICON_PROBLEM_MESSAGES,
  type ProjectIconCandidate,
  projectIconProblem,
} from '@kontourai/station-contracts/project';
import { useId, useRef, useState } from 'react';
import { PlusGlyph } from '../icons/Glyph';
import { ProjectIcon } from '../icons/ProjectIcon';
import './ProjectIconPicker.css';

/**
 * The problem with a picker value, or `undefined` when it can be saved.
 * `''` is "no icon" and always saves. Exported so the forms that host the
 * picker gate their submit on the SAME rule the routes apply.
 */
export function projectIconInputProblem(icon: string): string | undefined {
  if (icon === '') return undefined;
  const problem = projectIconProblem(icon);
  return problem ? PROJECT_ICON_PROBLEM_MESSAGES[problem] : undefined;
}

/**
 * What the file chooser offers: the allowed media types, the label a browser
 * gives an ICO file (relabelled on read, below), and the extensions, since a
 * platform picker may not map every type to its extension.
 */
const UPLOAD_ACCEPT = [
  ...PROJECT_ICON_IMAGE_MEDIA_TYPES,
  'image/vnd.microsoft.icon',
  '.png',
  '.jpg',
  '.jpeg',
  '.webp',
  '.ico',
].join(',');

/**
 * A browser names an ICO file `image/vnd.microsoft.icon`; the icon rule (and
 * discovery) spell it `image/x-icon`. Rewriting the label is all this does —
 * the rule still checks the bytes' signature against it.
 */
function normalizedImageDataUrl(dataUrl: string): string {
  return dataUrl.replace(
    /^data:image\/vnd\.microsoft\.icon;/,
    'data:image/x-icon;',
  );
}

function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ''));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

export interface ProjectIconPickerProps {
  /** The project's name, for the preview of the current choice. */
  name: string;
  /** The chosen icon; `''` is no icon. */
  value: string;
  onChange: (icon: string) => void;
  /** Artwork discovered in the project's folder (`useProjectIconCandidatesQuery`). */
  candidates: readonly ProjectIconCandidate[];
  /** True while discovery is reading the folder. */
  fetching: boolean;
  /** Prefix for the field ids, so two pickers never share one. */
  idPrefix: string;
}

/**
 * Choose a project's icon: artwork found in its folder, an uploaded image, an
 * emoji or symbol, or none. Shared by New Project and project settings; it
 * suggests and never applies — nothing changes until the person picks.
 *
 * Every value it hands `onChange` from a candidate or an upload has already
 * passed the icon rule; a typed glyph is passed through as typed (trimmed) and
 * its problem shown inline, so the host's submit gate and the server agree.
 */
export function ProjectIconPicker({
  name,
  value,
  onChange,
  candidates,
  fetching,
  idPrefix,
}: ProjectIconPickerProps) {
  const fileInput = useRef<HTMLInputElement>(null);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const hintId = useId();
  const glyphErrorId = useId();
  const isImage = value.startsWith('data:');
  const candidateSelected = candidates.some(
    (candidate) => candidate.dataUrl === value,
  );
  const glyphProblem = isImage ? undefined : projectIconInputProblem(value);
  const choose = (icon: string) => {
    setUploadError(null);
    onChange(icon);
  };

  async function upload(file: File) {
    // Refused before reading: an oversized file is never decoded.
    if (file.size > PROJECT_ICON_MAX_IMAGE_BYTES) {
      setUploadError(PROJECT_ICON_PROBLEM_MESSAGES['image-too-large']);
      return;
    }
    let dataUrl: string;
    try {
      dataUrl = normalizedImageDataUrl(await readFileAsDataUrl(file));
    } catch {
      setUploadError(PROJECT_ICON_PROBLEM_MESSAGES['image-encoding']);
      return;
    }
    const problem = projectIconProblem(dataUrl);
    if (problem) {
      setUploadError(PROJECT_ICON_PROBLEM_MESSAGES[problem]);
      return;
    }
    choose(dataUrl);
  }

  return (
    <div className="project-icon-picker">
      <div className="project-icon-picker__header">
        <div>
          <strong>Project icon</strong>
          <span id={hintId}>
            {fetching
              ? 'Looking for artwork in the project folder…'
              : 'Optional. Without one, Station shows the project’s colour or initials.'}
          </span>
        </div>
        <button
          type="button"
          className="editor-btn editor-btn--small project-icon-picker__none"
          aria-pressed={value === ''}
          onClick={() => choose('')}
        >
          No icon
        </button>
      </div>
      <fieldset
        className="project-icon-picker__artwork-list"
        aria-label="Artwork"
        aria-describedby={hintId}
      >
        {candidates.map((candidate) => (
          <button
            type="button"
            key={candidate.relativePath}
            className={`project-icon-picker__artwork-choice${value === candidate.dataUrl ? ' project-icon-picker__artwork-choice--selected' : ''}`}
            aria-label={`Use ${candidate.relativePath}`}
            aria-pressed={value === candidate.dataUrl}
            title={candidate.relativePath}
            onClick={() => choose(candidate.dataUrl)}
          >
            <img src={candidate.dataUrl} alt="" />
          </button>
        ))}
        {isImage && !candidateSelected && (
          // The current image (stored, or just uploaded) when it is not one
          // of this folder's candidates — otherwise choosing a candidate
          // would make the current icon unrecoverable from here.
          <span className="project-icon-picker__artwork-choice project-icon-picker__artwork-choice--selected">
            <ProjectIcon
              project={{ name, icon: value }}
              size={40}
              label="Current image"
            />
          </span>
        )}
        <button
          type="button"
          className="project-icon-picker__artwork-choice project-icon-picker__upload"
          aria-label="Upload image"
          title="Upload image"
          onClick={() => fileInput.current?.click()}
        >
          <PlusGlyph />
        </button>
        <input
          ref={fileInput}
          type="file"
          className="sr-only"
          tabIndex={-1}
          aria-hidden="true"
          accept={UPLOAD_ACCEPT}
          data-testid={`${idPrefix}-upload`}
          onChange={(event) => {
            const file = event.target.files?.[0];
            // Cleared so choosing the same file again still fires `change`.
            event.target.value = '';
            if (file) void upload(file);
          }}
        />
      </fieldset>
      {uploadError && (
        <p className="project-icon-picker__error" role="alert">
          {uploadError}
        </p>
      )}
      <label
        className="editor-label project-icon-picker__glyph-label"
        htmlFor={`${idPrefix}-glyph`}
      >
        Emoji or symbol <span className="editor-hint">optional</span>
      </label>
      <input
        id={`${idPrefix}-glyph`}
        className="editor-input project-icon-picker__glyph-input"
        type="text"
        value={isImage ? '' : value}
        placeholder="Type or paste an emoji"
        aria-invalid={glyphProblem ? true : undefined}
        aria-describedby={glyphProblem ? glyphErrorId : undefined}
        onChange={(event) => choose(event.target.value.trim())}
      />
      {glyphProblem && (
        <p
          className="project-icon-picker__error"
          id={glyphErrorId}
          role="alert"
        >
          {glyphProblem}
        </p>
      )}
    </div>
  );
}
