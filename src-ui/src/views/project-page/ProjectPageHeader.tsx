import { useEffect, useRef, useState } from 'react';
import { GitBadge } from '../../components/badges/GitBadge';
import { splitWorkingDirectoryPath } from '../../components/chat-dock/chat-dock-utils';
import { EditGlyph, SettingsGlyph } from '../../components/icons/Glyph';
import { LayoutIcon } from '../../components/icons/LayoutIcon';
import { PathAutocomplete } from '../../components/PathAutocomplete';
import { copyToClipboard } from '../../lib/clipboard';
import { triggerHaptic } from '../../platform/native/haptics';

export function ProjectPageHeader({
  apiBase,
  project,
  gitStatus,
  editingDir,
  setEditingDir,
  dirDraft,
  setDirDraft,
  updateWorkingDirectory,
  navigateToSettings,
}: {
  apiBase: string;
  project: {
    icon?: string;
    name: string;
    description?: string;
    workingDirectory?: string;
  };
  gitStatus: any;
  editingDir: boolean;
  setEditingDir: (editing: boolean) => void;
  dirDraft: string;
  setDirDraft: (value: string) => void;
  updateWorkingDirectory: (value: string) => void;
  navigateToSettings: () => void;
}) {
  // "Copied" is only ever shown for a clipboard write that resolved. Station is
  // routinely reached over plain http:// from another device, where
  // `navigator.clipboard` does not exist at all, and a permission refusal
  // rejects — both used to render as a successful copy. Same posture as
  // ShareAnswerButton: the path stays on screen either way, and the label says
  // which happened.
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'failed'>(
    'idle',
  );
  const copyResetRef = useRef<number | undefined>(undefined);
  useEffect(
    () => () => {
      if (copyResetRef.current !== undefined) {
        window.clearTimeout(copyResetRef.current);
      }
    },
    [],
  );
  const { parentPath, leafName, hasWorkingDirectory } =
    splitWorkingDirectoryPath(project.workingDirectory);

  const copyPath = async () => {
    if (!project.workingDirectory) return;
    const copied = await copyToClipboard(project.workingDirectory);
    if (copied) triggerHaptic('light');
    setCopyState(copied ? 'copied' : 'failed');
    if (copyResetRef.current !== undefined) {
      window.clearTimeout(copyResetRef.current);
    }
    copyResetRef.current = window.setTimeout(() => setCopyState('idle'), 1500);
  };

  return (
    <>
      <div className="project-page__header">
        <div className="project-page__identity">
          <LayoutIcon layout={project} size={48} />
          <div className="project-page__identity-info">
            <h2 className="project-page__name">{project.name}</h2>
            {!editingDir && (
              <div className="project-page__dir-row">
                <button
                  type="button"
                  className="project-page__dir-display"
                  aria-label={
                    hasWorkingDirectory
                      ? 'Edit working directory'
                      : 'Set working directory'
                  }
                  onClick={() => {
                    setDirDraft(project.workingDirectory ?? '');
                    setEditingDir(true);
                  }}
                >
                  {hasWorkingDirectory ? (
                    <span className="project-page__dir-path">
                      {/* rtl only for start-side ellipsis; the inner ltr
                          isolate restores character order (same treatment as
                          the chat dock's dir split — #304). */}
                      <span className="project-page__dir-parent">
                        <span
                          dir="ltr"
                          className="project-page__dir-parent-text"
                        >
                          {parentPath}
                        </span>
                      </span>
                      <span className="project-page__dir-leaf">{leafName}</span>
                    </span>
                  ) : (
                    <span className="project-page__dir-path project-page__dir-path--unset">
                      Set working directory…
                    </span>
                  )}
                  <span className="project-page__dir-edit-icon">
                    <EditGlyph />
                  </span>
                </button>
                {hasWorkingDirectory && (
                  <>
                    <button
                      type="button"
                      className={`project-page__dir-copy${
                        copyState === 'failed'
                          ? ' project-page__dir-copy--failed'
                          : ''
                      }`}
                      aria-label="Copy working directory path"
                      title={
                        copyState === 'failed'
                          ? 'This browser refused clipboard access — select the path above to copy it manually.'
                          : 'Copy working directory path'
                      }
                      onClick={() => {
                        void copyPath();
                      }}
                    >
                      {copyState === 'copied'
                        ? 'Copied'
                        : copyState === 'failed'
                          ? "Can't copy"
                          : 'Copy'}
                    </button>
                    {/* The button's own name is fixed, so its label change is
                        never announced; this sibling carries the outcome. */}
                    <span
                      role="status"
                      className="project-page__dir-copy-status"
                    >
                      {copyState === 'copied'
                        ? 'Working directory path copied.'
                        : copyState === 'failed'
                          ? 'This browser refused clipboard access. Select the path to copy it manually.'
                          : ''}
                    </span>
                  </>
                )}
              </div>
            )}
            {gitStatus?.isRepo && (
              <GitBadge git={gitStatus} className="project-page__git-badge" />
            )}
            {project.description && (
              <p className="project-page__desc">{project.description}</p>
            )}
          </div>
        </div>
        <button
          type="button"
          className="project-page__settings-btn"
          aria-label="Project settings"
          onClick={navigateToSettings}
        >
          <SettingsGlyph />
          <span className="project-page__settings-label">Settings</span>
        </button>
      </div>

      {editingDir && (
        <div className="project-page__dir-inline">
          <PathAutocomplete
            apiBase={apiBase}
            autoFocus
            value={dirDraft}
            onChange={setDirDraft}
            onSubmit={() => updateWorkingDirectory(dirDraft)}
            onBlur={() => {
              if (dirDraft !== (project.workingDirectory ?? '')) {
                updateWorkingDirectory(dirDraft);
              } else {
                setEditingDir(false);
              }
            }}
            placeholder="/path/to/project"
            className="project-page__dir-input"
          />
        </div>
      )}
    </>
  );
}
