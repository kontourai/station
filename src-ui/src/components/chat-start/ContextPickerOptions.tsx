import { useEffect, useRef } from 'react';
import {
  EngineGlyph,
  FolderGlyph,
  GlobeGlyph,
  PlugGlyph,
  TimeGlyph,
} from '../icons/Glyph';
import { LayoutIcon } from '../icons/LayoutIcon';
import {
  GLOBAL_CONTEXT,
  type NewChatModalContextOption,
  splitCwdBreadcrumb,
} from '../modals/new-chat-modal-utils';

/**
 * Filter input + selectable option list shared by the desktop anchored
 * dropdown and the mobile bottom sheet, so the two presentations never drift
 * out of sync with duplicated markup.
 */
export function ContextPickerOptions({
  contextSearch,
  onContextSearchChange,
  autoFocusFilter,
  onEscape,
  filteredContextOptions,
  selectedContext,
  onSelectContext,
  folderlessReason,
}: {
  contextSearch: string;
  onContextSearchChange: (value: string) => void;
  autoFocusFilter: boolean;
  onEscape: () => void;
  filteredContextOptions: NewChatModalContextOption[];
  selectedContext: string;
  onSelectContext: (value: string) => void;
  /**
   * Set where a project without a folder cannot be chosen: its row is
   * disabled and says why. The start composer sets it, because a start
   * context never resolves to a folderless project.
   */
  folderlessReason?: string;
}) {
  const filterRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (autoFocusFilter) filterRef.current?.focus();
  }, [autoFocusFilter]);

  return (
    <>
      <input
        ref={filterRef}
        className="new-chat-modal__dropdown-search"
        type="text"
        placeholder="Filter..."
        value={contextSearch}
        onChange={(e) => onContextSearchChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.preventDefault();
            e.stopPropagation();
            onEscape();
          }
        }}
      />
      {filteredContextOptions.map((opt) => {
        const folderless =
          opt.value !== GLOBAL_CONTEXT && !opt.workingDirectory?.trim();
        const refused = Boolean(folderlessReason) && folderless;
        return (
          <button
            type="button"
            key={opt.value}
            data-context-value={opt.value}
            className={`new-chat-modal__dropdown-item ${opt.value === selectedContext ? 'new-chat-modal__dropdown-item--active' : ''}`}
            disabled={refused}
            aria-describedby={
              refused ? `context-${opt.value}-reason` : undefined
            }
            onClick={() => onSelectContext(opt.value)}
          >
            <span className="new-chat-modal__dropdown-item-main">
              <span className="new-chat-modal__dropdown-item-label">
                <LayoutIcon
                  layout={{ name: opt.label, icon: opt.icon }}
                  fallback={contextGlyph(opt.glyph)}
                  size={24}
                />
                <span>{opt.label}</span>
              </span>
              {opt.workingDirectory && (
                <span className="new-chat-modal__dropdown-item-dir">
                  <CwdBreadcrumb path={opt.workingDirectory} />
                </span>
              )}
              {refused && (
                <span
                  id={`context-${opt.value}-reason`}
                  className="new-chat-modal__dropdown-item-dir"
                >
                  {folderlessReason}
                </span>
              )}
            </span>
            {folderless && !refused && (
              <span className="new-chat-modal__no-cwd-badge">~/</span>
            )}
          </button>
        );
      })}
    </>
  );
}

export function contextGlyph(
  name: 'engine' | 'folder' | 'globe' | 'plug' | 'time' | undefined,
) {
  switch (name) {
    case 'engine':
      return <EngineGlyph />;
    case 'folder':
      return <FolderGlyph />;
    case 'globe':
      return <GlobeGlyph />;
    case 'plug':
      return <PlugGlyph />;
    case 'time':
      return <TimeGlyph />;
    default:
      return undefined;
  }
}

/** Working directory breadcrumb with explicit, semantically complete separators. */
export function CwdBreadcrumb({ path }: { path: string }) {
  const { parent, separator, leaf } = splitCwdBreadcrumb(path);
  return (
    <output
      className="new-chat-modal__cwd-breadcrumb"
      aria-label={`Working directory: ${path}`}
      title={path}
    >
      <span className="new-chat-modal__dir-parent" aria-hidden="true">
        {parent}
      </span>
      <span className="new-chat-modal__dir-separator" aria-hidden="true">
        {separator}
      </span>
      <span className="new-chat-modal__dir-leaf" aria-hidden="true">
        {leaf}
      </span>
    </output>
  );
}

/**
 * The dot between the workspace's name and its directory hint. Without it,
 * "No workspace" and its "Home folder" fallback rendered flush and read as
 * one invented phrase — "No workspace Home folder".
 */
export function ContextLabelSeparator() {
  return (
    <span className="new-chat-modal__context-sep" aria-hidden="true">
      ·
    </span>
  );
}
