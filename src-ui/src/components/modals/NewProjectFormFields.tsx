import type { ProjectIconCandidate } from '@kontourai/station-contracts/project';
import { ProjectIcon } from '../icons/ProjectIcon';
import { PathAutocomplete } from '../PathAutocomplete';
import { ProjectIconPicker } from '../project-icon/ProjectIconPicker';

export { EnvironmentPicker as NewProjectEnvironmentPicker } from '../EnvironmentPicker';

interface DirectoryFieldProps {
  directory: string;
  /** The server's reason this exact directory was refused (4-HOME-008). */
  error?: string | null;
  /**
   * #765 F7-class: the check could not be performed (no verdict). Same slot
   * as `error`, but the input is NOT marked invalid — nothing established
   * the path is wrong — and Create stays enabled so "Try again." is true.
   */
  notice?: string | null;
  onDirectoryChange: (value: string) => void;
}

export function NewProjectDirectoryField({
  directory,
  error,
  notice,
  onDirectoryChange,
}: DirectoryFieldProps) {
  const described = error ?? notice;
  return (
    <div className="new-project-modal__hero">
      <section className="new-project-modal__panel new-project-modal__panel--featured">
        <div className="editor-field">
          <label className="editor-label" htmlFor="new-project-directory">
            Working Directory <span className="editor-hint"> optional</span>
          </label>
          <PathAutocomplete
            id="new-project-directory"
            value={directory}
            onChange={onDirectoryChange}
            placeholder="/path/to/project"
            className="editor-input path-autocomplete__input new-project-modal__working-dir-input"
            browsable
            aria-invalid={error ? true : undefined}
            aria-describedby={
              described ? 'new-project-directory-error' : undefined
            }
          />
          {described && (
            <p
              className="new-project-modal__field-error"
              id="new-project-directory-error"
              role="alert"
            >
              {described}
            </p>
          )}
        </div>
      </section>
    </div>
  );
}

interface IdentityFieldProps {
  candidates: ProjectIconCandidate[];
  icon: string;
  name: string;
  derivedName: string;
  /** The duplicate-name sentence a REFRESHED project list supported. */
  nameConflict?: string | null | undefined;
  /** The same suspicion from the possibly-stale cache: a warning, not a veto. */
  nameAdvisory?: string | undefined;
  showIconChoices: boolean;
  iconCandidatesFetching: boolean;
  onIconChange: (icon: string) => void;
  onNameChange: (name: string) => void;
  onToggleIconChoices: () => void;
  /** When the host path is hidden, name is the identity — not a folder leaf. */
  identityHint?: string;
}

export function NewProjectIdentityField({
  candidates,
  icon,
  name,
  derivedName,
  nameConflict,
  nameAdvisory,
  showIconChoices,
  iconCandidatesFetching,
  onIconChange,
  onNameChange,
  onToggleIconChoices,
  identityHint,
}: IdentityFieldProps) {
  return (
    <div className="editor-field">
      <label className="editor-label" htmlFor="new-project-name">
        Project identity
      </label>
      <div className="new-project-modal__identity-row">
        <button
          type="button"
          className="new-project-modal__identity-icon"
          aria-label="Choose project icon"
          aria-expanded={showIconChoices}
          onClick={onToggleIconChoices}
        >
          <ProjectIcon
            project={{ name: name || derivedName || 'New Project', icon }}
            size={44}
            fallback="initials"
          />
        </button>
        <input
          id="new-project-name"
          className="editor-input new-project-modal__name-input"
          type="text"
          value={name}
          placeholder="My Project"
          required
          aria-invalid={nameConflict ? true : undefined}
          aria-describedby={nameConflict ? 'new-project-name-error' : undefined}
          onChange={(event) => onNameChange(event.target.value)}
        />
      </div>
      {nameConflict ? (
        <p
          className="new-project-modal__field-error"
          id="new-project-name-error"
          role="alert"
        >
          {nameConflict}
        </p>
      ) : (
        nameAdvisory && (
          <p
            className="new-project-modal__field-advisory"
            id="new-project-name-advisory"
            role="status"
          >
            {nameAdvisory}
          </p>
        )
      )}
      <p className="editor-field-hint">
        {identityHint ??
          'Follows the working directory until you edit it. Without an icon, Station shows its initials and colour.'}
      </p>
      {showIconChoices && (
        <ProjectIconPicker
          idPrefix="new-project-icon"
          name={name || derivedName || 'New Project'}
          value={icon}
          onChange={onIconChange}
          candidates={candidates}
          fetching={iconCandidatesFetching}
        />
      )}
    </div>
  );
}

export function NewProjectDescriptionField({
  description,
  onChange,
}: {
  description: string;
  onChange: (description: string) => void;
}) {
  return (
    <div className="editor-field">
      <label className="editor-label" htmlFor="new-project-description">
        Description <span className="editor-hint">optional</span>
      </label>
      <textarea
        id="new-project-description"
        className="editor-textarea"
        value={description}
        placeholder="A short note about what lives in this workspace."
        rows={3}
        onChange={(event) => onChange(event.target.value)}
      />
    </div>
  );
}
