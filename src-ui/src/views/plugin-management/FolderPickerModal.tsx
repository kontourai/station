import { useFileSystemBrowseQuery } from '@kontourai/station-sdk';
import { useState } from 'react';
import { FolderGlyph } from '../../components/icons/Glyph';
import {
  ResponsiveDialogCloseButton,
  ResponsiveDialogSurface,
} from '../../components/ResponsiveDialogSurface';
import { Empty, Skeleton } from '../../components/state';

export function FolderPickerModal({
  onSelect,
  onClose,
}: {
  onSelect: (path: string) => void;
  onClose: () => void;
}) {
  const [currentPath, setCurrentPath] = useState('');

  const {
    data,
    isLoading: loading,
    error,
  } = useFileSystemBrowseQuery(currentPath);

  const entries = (data?.entries || []).filter((entry) => entry.isDirectory);
  const resolvedPath = data?.path || currentPath;

  const parentPath = resolvedPath
    ? resolvedPath.replace(/\/[^/]+\/?$/, '') || '/'
    : '';

  return (
    <ResponsiveDialogSurface
      onClose={onClose}
      ariaLabelledBy="folder-picker-title"
      overlayClassName="plugins__modal-overlay"
      panelClassName="plugins__modal plugins__folder-modal"
    >
      <div className="plugins__modal-header">
        <h3 id="folder-picker-title" className="plugins__modal-title">
          Select Folder
        </h3>
        <ResponsiveDialogCloseButton
          onClick={onClose}
          label="Close folder picker"
        />
      </div>
      <div className="plugins__folder-path">
        <code>{resolvedPath}</code>
        <button
          type="button"
          className="plugins__folder-select-btn"
          onClick={() => {
            onSelect(resolvedPath);
            onClose();
          }}
        >
          Select This Folder
        </button>
      </div>
      <div className="plugins__modal-body">
        {error && (
          <div className="plugins__modal-message plugins__message--error">
            {(error as Error).message}
          </div>
        )}
        {loading ? (
          <Skeleton variant="line" />
        ) : (
          <div className="plugins__folder-list">
            {resolvedPath !== '/' && (
              <button
                type="button"
                className="plugins__folder-entry"
                onClick={() => setCurrentPath(parentPath)}
              >
                <span className="plugins__folder-icon">↑</span>
                <span className="plugins__folder-name">..</span>
              </button>
            )}
            {entries.map((entry) => (
              <button
                type="button"
                key={entry.name}
                className="plugins__folder-entry"
                onClick={() => setCurrentPath(`${resolvedPath}/${entry.name}`)}
              >
                <span className="plugins__folder-icon">
                  <FolderGlyph />
                </span>
                <span className="plugins__folder-name">{entry.name}</span>
              </button>
            ))}
            {entries.length === 0 && (
              <Empty variant="compact" label="No subdirectories" />
            )}
          </div>
        )}
      </div>
    </ResponsiveDialogSurface>
  );
}
