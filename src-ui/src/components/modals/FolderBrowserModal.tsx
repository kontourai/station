import { useFileSystemBrowseQuery } from '@kontourai/station-sdk';
import { type KeyboardEvent, useEffect, useRef, useState } from 'react';
import { nextTabIndex } from '../../utils/tab-navigation';
import { FolderGlyph } from '../icons/Glyph';
import {
  ResponsiveDialogCloseButton,
  ResponsiveDialogSurface,
} from '../ResponsiveDialogSurface';
import { Empty, Skeleton } from '../state';
import './FolderBrowserModal.css';

/**
 * Structural classnames for every named region. Every consumer supplies its
 * own visual language; the component owns behaviour (browsing, selection,
 * roving-focus keyboard navigation) only. Plugin management passes its
 * existing `plugins__*` classnames so the #1014 extraction is behaviour- and
 * pixel-preserving there; a caller that omits `classNames` (New Project) gets
 * the neutral `folder-browser__*` defaults and this component's own
 * stylesheet.
 */
export interface FolderBrowserClassNames {
  overlay?: string;
  panel?: string;
  header?: string;
  title?: string;
  body?: string;
  message?: string;
  messageError?: string;
  pathRow?: string;
  selectButton?: string;
  list?: string;
  entry?: string;
  icon?: string;
  name?: string;
}

const DEFAULT_CLASS_NAMES: Required<FolderBrowserClassNames> = {
  overlay: 'folder-browser__overlay',
  panel: 'folder-browser__panel',
  header: 'folder-browser__header',
  title: 'folder-browser__title',
  body: 'folder-browser__body',
  message: 'folder-browser__message',
  messageError: 'folder-browser__message--error',
  pathRow: 'folder-browser__path',
  selectButton: 'folder-browser__select-btn',
  list: 'folder-browser__list',
  entry: 'folder-browser__entry',
  icon: 'folder-browser__icon',
  name: 'folder-browser__name',
};

export interface FolderBrowserModalProps {
  /** Directory to start browsing from; empty resolves to the server default. */
  initialPath?: string;
  onSelect: (path: string) => void;
  onClose: () => void;
  title?: string;
  titleId?: string;
  closeLabel?: string;
  classNames?: FolderBrowserClassNames;
}

interface Row {
  key: string;
  label: string;
  path: string;
  isParent: boolean;
}

export function FolderBrowserModal({
  initialPath = '',
  onSelect,
  onClose,
  title = 'Select Folder',
  titleId = 'folder-browser-title',
  closeLabel = 'Close folder browser',
  classNames,
}: FolderBrowserModalProps) {
  const cx = { ...DEFAULT_CLASS_NAMES, ...classNames };
  const [currentPath, setCurrentPath] = useState(initialPath);

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

  const rows: Row[] = [
    ...(resolvedPath !== '/'
      ? [{ key: '..', label: '..', path: parentPath, isParent: true }]
      : []),
    ...entries.map((entry) => ({
      key: entry.name,
      label: entry.name,
      path: `${resolvedPath}/${entry.name}`,
      isParent: false,
    })),
  ];

  const [focusedIndex, setFocusedIndex] = useState(0);
  const rowRefs = useRef<Array<HTMLButtonElement | null>>([]);

  // A fresh directory listing invalidates the previous roving-focus
  // position — always land back on the first row (".." when present)
  // rather than an index that may no longer exist in the new listing.
  // biome-ignore lint/correctness/useExhaustiveDependencies: resolvedPath is the intentional trigger; rows is derived from it each render.
  useEffect(() => {
    setFocusedIndex(0);
  }, [resolvedPath]);

  const onEntryKeyDown =
    (index: number) => (event: KeyboardEvent<HTMLButtonElement>) => {
      const next = nextTabIndex(index, rows.length, event.key);
      if (next === null) return;
      event.preventDefault();
      setFocusedIndex(next);
      rowRefs.current[next]?.focus();
    };

  return (
    <ResponsiveDialogSurface
      onClose={onClose}
      ariaLabelledBy={titleId}
      overlayClassName={cx.overlay}
      panelClassName={cx.panel}
    >
      <div className={cx.header}>
        <h3 id={titleId} className={cx.title}>
          {title}
        </h3>
        <ResponsiveDialogCloseButton onClick={onClose} label={closeLabel} />
      </div>
      <div className={cx.pathRow}>
        {/* The environment/location the listing below describes — screen
            readers and other AT can identify it via `aria-current`, matching
            how a breadcrumb marks its current page (#1014). */}
        <code aria-current="location">{resolvedPath}</code>
        <button
          type="button"
          className={cx.selectButton}
          onClick={() => {
            onSelect(resolvedPath);
            onClose();
          }}
        >
          Select This Folder
        </button>
      </div>
      <div className={cx.body}>
        {error && (
          <div className={`${cx.message} ${cx.messageError}`}>
            {(error as Error).message}
          </div>
        )}
        {loading ? (
          <Skeleton variant="line" />
        ) : (
          <div className={cx.list}>
            {rows.map((row, index) => (
              <button
                type="button"
                key={row.key}
                ref={(element) => {
                  rowRefs.current[index] = element;
                }}
                className={cx.entry}
                tabIndex={index === focusedIndex ? 0 : -1}
                onFocus={() => setFocusedIndex(index)}
                onKeyDown={onEntryKeyDown(index)}
                onClick={() => setCurrentPath(row.path)}
              >
                <span className={cx.icon}>
                  {row.isParent ? '↑' : <FolderGlyph />}
                </span>
                <span className={cx.name}>{row.label}</span>
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
