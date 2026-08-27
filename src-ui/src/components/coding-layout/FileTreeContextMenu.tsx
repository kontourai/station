import { useEffect } from 'react';

export interface FileTreeMenuAction {
  label: string;
  danger?: boolean;
  onClick: () => void;
}

/**
 * A lightweight right-click / long-press menu for the file tree. Rendered
 * fixed-position at (x, y) with a full-screen scrim that closes it on any
 * outside interaction; Escape also closes. Actions are supplied by the caller
 * so the same menu serves files, directories, and the empty area.
 */
export function FileTreeContextMenu({
  x,
  y,
  actions,
  onClose,
}: {
  x: number;
  y: number;
  actions: FileTreeMenuAction[];
  onClose: () => void;
}) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <>
      <button
        type="button"
        aria-label="Close menu"
        className="file-tree-context-scrim"
        onClick={onClose}
        onContextMenu={(e) => {
          e.preventDefault();
          onClose();
        }}
      />
      <div
        className="file-tree-context-menu"
        role="menu"
        style={{ left: x, top: y }}
      >
        {actions.map((action) => (
          <button
            type="button"
            key={action.label}
            role="menuitem"
            className={`file-tree-context-menu__item${
              action.danger ? ' file-tree-context-menu__item--danger' : ''
            }`}
            onClick={() => {
              action.onClick();
              onClose();
            }}
          >
            {action.label}
          </button>
        ))}
      </div>
    </>
  );
}
