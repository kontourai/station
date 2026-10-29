import {
  type CodingFileEntry as FileEntry,
  useCodingFilesQuery,
  useCreateCodingFileMutation,
  useDeleteCodingFileMutation,
  useRenameCodingFileMutation,
} from '@kontourai/station-sdk';
import { previewProjectWorkspaceFile } from '@kontourai/station-sdk/workspace-file-preview';
import { memo, useCallback, useDeferredValue, useMemo, useState } from 'react';
import { useApiBase } from '../../contexts/ApiBaseContext';
import { copyToClipboard } from '../../lib/clipboard';
import { useCodingFilesContext } from '../../providers/context/CodingFilesContextProvider';
import { ConfirmModal } from '../modals/ConfirmModal';
import { PromptModal } from '../modals/PromptModal';
import { activeTerminalWriter } from './activeTerminal';
import './FileTreePanel.css';
import { parseWorkspaceOpenFilePreviewIntent } from '@kontourai/station-contracts/workspace-file-preview';
import { createPortal } from 'react-dom';
import {
  type ContextMenuPoint,
  useContextMenuGesture,
} from '../../hooks/useContextMenuGesture';
import { wantsNativeContextMenu } from '../../lib/native-context-menu';
import type { OpenFilePreviewIntent } from '../../workspace-panes/openFilePreviewIntent';
import { usePaneHeadSlots } from '../../workspace-panes/PaneHeadSlots';
import {
  ContextMenu,
  type ContextMenuAction,
  contextMenuAnchor,
} from '../ContextMenu';
import { SkeletonList } from '../state';
import { filterTree } from './fileTreeFilter';

const EMPTY_TREE: FileEntry[] = [];

/** Parent directory of a workspace-relative path ('' for a top-level entry). */
function parentDir(path: string): string {
  const i = path.lastIndexOf('/');
  return i > 0 ? path.slice(0, i) : '';
}

type MenuState = {
  entry: FileEntry | null;
  at: ContextMenuPoint;
  origin: HTMLElement;
};
type PromptState = {
  mode: 'create-file' | 'create-folder' | 'rename';
  entry: FileEntry | null;
};

const FileTreeNode = memo(function FileTreeNodeView({
  entry,
  projectSlug,
  depth,
  forceOpen,
  selectedPath,
  attachedPaths,
  onSelect,
  onContextMenu,
}: {
  entry: FileEntry;
  projectSlug: string;
  depth: number;
  forceOpen: Set<string>;
  selectedPath: string | null;
  attachedPaths: Set<string>;
  onSelect: (intent: OpenFilePreviewIntent) => void;
  onContextMenu: (
    entry: FileEntry,
    at: ContextMenuPoint,
    origin: HTMLElement,
  ) => void;
}) {
  const [open, setOpen] = useState(depth === 0);

  const isOpen =
    open ||
    forceOpen.has(entry.path) ||
    Boolean(selectedPath?.startsWith(`${entry.path}/`));

  // Right-click, the keyboard's menu key, or a hold on touch. The hook also
  // swallows the click a hold ends in, which used to open the file (or fold
  // the folder) under the menu the hold had just opened.
  const gesture = useContextMenuGesture({
    onOpen: (row, point) => {
      onContextMenu(entry, contextMenuAnchor(row, point), row);
    },
  });

  const rowProps = {
    ...gesture,
    style: { '--depth': depth } as React.CSSProperties,
  };

  if (entry.type === 'directory') {
    return (
      <div>
        <button
          type="button"
          className="file-tree-row file-tree-row--dir"
          onClick={() => setOpen((v) => !v)}
          {...rowProps}
        >
          <span className="file-tree-row__chevron">{isOpen ? '▾' : '▸'}</span>
          <span className="file-tree-row__name" title={entry.name}>
            {entry.name}
          </span>
        </button>
        {isOpen &&
          entry.children?.map((child) => (
            <FileTreeNode
              key={child.path}
              entry={child}
              projectSlug={projectSlug}
              depth={depth + 1}
              forceOpen={forceOpen}
              selectedPath={
                selectedPath === child.path ||
                selectedPath?.startsWith(`${child.path}/`)
                  ? selectedPath
                  : null
              }
              attachedPaths={attachedPaths}
              onSelect={onSelect}
              onContextMenu={onContextMenu}
            />
          ))}
      </div>
    );
  }

  const attached = attachedPaths.has(entry.path);
  return (
    <button
      type="button"
      className={`file-tree-row file-tree-row--file${
        selectedPath === entry.path ? ' file-tree-row--selected' : ''
      }`}
      onClick={() => {
        const intent = parseWorkspaceOpenFilePreviewIntent({
          projectSlug,
          path: entry.path,
        });
        if (intent) onSelect(intent);
      }}
      {...rowProps}
    >
      <span className="file-tree-row__bullet">·</span>
      <span className="file-tree-row__name" title={entry.name}>
        {entry.name}
      </span>
      {attached && (
        <span
          className="file-tree-row__attached"
          role="img"
          title="Attached to chat context"
          aria-label="Attached to chat context"
        >
          ◆
        </span>
      )}
    </button>
  );
});

export function FileTreePanel({
  projectSlug,
  workingDir,
  selectedPath = null,
  onFileSelect,
}: {
  projectSlug: string;
  workingDir: string;
  selectedPath?: string | null;
  onFileSelect: (intent: OpenFilePreviewIntent) => void;
}) {
  const { apiBase } = useApiBase();
  // #2412: file reads and edits name the Project they act in.
  const location = useMemo(
    () => ({ projectSlug, workingDir }),
    [projectSlug, workingDir],
  );
  const {
    data: tree = EMPTY_TREE,
    isLoading: loading,
    error: queryError,
  } = useCodingFilesQuery(location, apiBase);

  const createMut = useCreateCodingFileMutation(location, apiBase);
  const renameMut = useRenameCodingFileMutation(location, apiBase);
  const deleteMut = useDeleteCodingFileMutation(location, apiBase);

  const {
    files: attachedFiles,
    addFile,
    removeFile,
    removeFilesAtPath,
  } = useCodingFilesContext();
  const attachedPaths = useMemo(
    () =>
      new Set(
        attachedFiles
          .filter((file) => file.projectSlug === projectSlug)
          .map((file) => file.path),
      ),
    [attachedFiles, projectSlug],
  );

  const [search, setSearch] = useState('');
  const deferredSearch = useDeferredValue(search);
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [prompt, setPrompt] = useState<PromptState | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<FileEntry | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const { tree: visibleTree, expanded } = useMemo(
    () => filterTree(tree, deferredSearch),
    [tree, deferredSearch],
  );

  const loadError = queryError?.message ?? null;
  const opError =
    actionError ??
    createMut.error?.message ??
    renameMut.error?.message ??
    deleteMut.error?.message ??
    null;

  const openMenu = useCallback(
    (entry: FileEntry | null, at: ContextMenuPoint, origin: HTMLElement) =>
      setMenu({ entry, at, origin }),
    [],
  );

  // Attach a file's current content to the chat context provider.
  const addToChat = async (entry: FileEntry) => {
    setActionError(null);
    const intent = parseWorkspaceOpenFilePreviewIntent({
      projectSlug,
      path: entry.path,
    });
    if (!intent) {
      setActionError('This file cannot be added to the active conversation.');
      return;
    }
    try {
      const preview = await previewProjectWorkspaceFile(apiBase, projectSlug, {
        path: intent.path,
      });
      if (!addFile(intent, preview)) {
        setActionError(
          'This preview cannot be added to the active conversation.',
        );
      }
    } catch (e) {
      setActionError(e instanceof Error ? e.message : 'Failed to attach file');
    }
  };

  const copyPath = async (entry: FileEntry) => {
    // The old `?.` short-circuited its own `.catch`, so the one origin that
    // actually has no clipboard — plain http:// from another device — was the
    // one case this error never reported (archive#3341).
    //
    // Clearing on success is deliberate and matches every other action in this
    // panel (`addToChat`, `sendToTerminal` both `setActionError(null)` first):
    // `actionError` is a single slot for "the last thing you asked for went
    // wrong", so a successful copy must not leave a stale sentence from an
    // earlier failure sitting under the tree.
    setActionError(
      (await copyToClipboard(entry.path)) ? null : 'Clipboard unavailable',
    );
  };

  // Type the path into the active terminal (trailing space to keep typing).
  const sendToTerminal = (entry: FileEntry) => {
    setActionError(null);
    if (!activeTerminalWriter.write(`${entry.path} `)) {
      setActionError('No active terminal');
    }
  };

  const menuActions = (entry: FileEntry | null): ContextMenuAction[] => {
    const actions: ContextMenuAction[] = [
      {
        key: 'new-file',
        label: 'New File',
        onSelect: () => setPrompt({ mode: 'create-file', entry }),
      },
      {
        key: 'new-folder',
        label: 'New Folder',
        onSelect: () => setPrompt({ mode: 'create-folder', entry }),
      },
    ];
    if (entry) {
      if (entry.type === 'file') {
        const attachmentsForPath = attachedFiles.filter(
          (file) =>
            file.projectSlug === projectSlug && file.path === entry.path,
        );
        const hasWholeFile = attachmentsForPath.some((file) => !file.lineRange);

        if (attachmentsForPath.length === 0) {
          actions.push({
            key: 'add-to-chat',
            label: 'Add to chat',
            onSelect: () => void addToChat(entry),
          });
        } else {
          if (hasWholeFile) {
            actions.push({
              key: 'remove-from-chat',
              label:
                attachmentsForPath.length === 1
                  ? 'Remove from chat'
                  : 'Remove whole file from chat',
              onSelect: () => removeFile({ projectSlug, path: entry.path }),
            });
          }
          if (attachmentsForPath.length > (hasWholeFile ? 1 : 0)) {
            const attachmentNoun =
              attachmentsForPath.length === 1 ? 'attachment' : 'attachments';
            actions.push({
              key: 'remove-all-from-chat',
              label: `Remove all ${attachmentsForPath.length} ${attachmentNoun} from chat`,
              onSelect: () => removeFilesAtPath(projectSlug, entry.path),
            });
          }
        }
        actions.push({
          key: 'copy-path',
          label: 'Copy path',
          onSelect: () => {
            void copyPath(entry);
          },
        });
        actions.push({
          key: 'send-to-terminal',
          label: 'Send to terminal',
          onSelect: () => sendToTerminal(entry),
        });
      }
      actions.push({
        key: 'rename',
        label: 'Rename',
        onSelect: () => setPrompt({ mode: 'rename', entry }),
      });
      actions.push({
        key: 'delete',
        label: 'Delete',
        tone: 'danger',
        onSelect: () => setDeleteTarget(entry),
      });
    }
    return actions;
  };

  // Directory a new entry should be created in, given the context entry.
  const createBase = (entry: FileEntry | null): string => {
    if (!entry) return '';
    return entry.type === 'directory' ? entry.path : parentDir(entry.path);
  };

  const confirmPrompt = (name: string) => {
    if (!prompt) return;
    const { mode, entry } = prompt;
    if (mode === 'rename' && entry) {
      const base = parentDir(entry.path);
      renameMut.mutate({
        from: entry.path,
        to: base ? `${base}/${name}` : name,
      });
    } else {
      const base = createBase(entry);
      createMut.mutate({
        target: base ? `${base}/${name}` : name,
        type: mode === 'create-folder' ? 'directory' : 'file',
      });
    }
    setPrompt(null);
  };

  const promptTitle =
    prompt?.mode === 'rename'
      ? 'Rename'
      : prompt?.mode === 'create-folder'
        ? 'New folder'
        : 'New file';

  // Inside a host that draws the pane's head itself (the Coding layout's
  // side panel), the title is the host's and the one control goes into its
  // row; the panel then draws no title row of its own (#3046 round).
  const headSlots = usePaneHeadSlots();
  const addAction = (
    <button
      type="button"
      className="file-tree-panel__action"
      title="New file or folder"
      aria-label="New file or folder"
      onClick={(e) => {
        const r = e.currentTarget.getBoundingClientRect();
        openMenu(null, { x: r.left, y: r.bottom + 2 }, e.currentTarget);
      }}
    >
      +
    </button>
  );

  return (
    <div className="file-tree-panel">
      {headSlots ? (
        headSlots.trailing ? (
          createPortal(addAction, headSlots.trailing)
        ) : null
      ) : (
        <div className="file-tree-panel__header">
          <span className="file-tree-panel__title">Files</span>
          {addAction}
        </div>
      )}

      <div className="file-tree-panel__search">
        <input
          type="search"
          className="file-tree-panel__search-input"
          aria-label="Filter files"
          placeholder="Filter files…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      </div>

      {opError && <div className="file-tree-panel__error">{opError}</div>}

      <section
        className="file-tree-panel__scroll"
        aria-label="File tree"
        onContextMenu={(e) => {
          // Right-click on the empty area → root-level menu.
          if (e.target === e.currentTarget && !wantsNativeContextMenu(e)) {
            e.preventDefault();
            openMenu(null, { x: e.clientX, y: e.clientY }, e.currentTarget);
          }
        }}
      >
        {loading && (
          <SkeletonList count={5} withIcon={false} label="Loading files" />
        )}
        {loadError && <div className="file-tree-panel__error">{loadError}</div>}
        {!loading && !loadError && tree.length === 0 && (
          <div className="file-tree-panel__hint">
            {workingDir ? 'No files found' : 'No working directory configured'}
          </div>
        )}
        {!loading &&
          !loadError &&
          tree.length > 0 &&
          visibleTree.length === 0 && (
            <div className="file-tree-panel__hint">
              No files match “{deferredSearch}”
            </div>
          )}
        {visibleTree.map((entry) => (
          <FileTreeNode
            key={entry.path}
            entry={entry}
            projectSlug={projectSlug}
            depth={0}
            forceOpen={expanded}
            selectedPath={
              selectedPath === entry.path ||
              selectedPath?.startsWith(`${entry.path}/`)
                ? selectedPath
                : null
            }
            attachedPaths={attachedPaths}
            onSelect={onFileSelect}
            onContextMenu={openMenu}
          />
        ))}
      </section>

      {menu && (
        <ContextMenu
          at={menu.at}
          origin={menu.origin}
          label={
            menu.entry ? `Actions for ${menu.entry.name}` : 'File tree actions'
          }
          actions={menuActions(menu.entry)}
          onClose={() => setMenu(null)}
        />
      )}

      <PromptModal
        isOpen={prompt !== null}
        title={promptTitle}
        label={prompt?.mode === 'rename' ? 'New name' : 'Name'}
        initialValue={
          prompt?.mode === 'rename' ? (prompt.entry?.name ?? '') : ''
        }
        placeholder={
          prompt?.mode === 'create-folder' ? 'components' : 'file.ts'
        }
        confirmLabel={prompt?.mode === 'rename' ? 'Rename' : 'Create'}
        validate={(v) =>
          v.includes('/') ? 'Name cannot contain a slash' : null
        }
        onConfirm={confirmPrompt}
        onCancel={() => setPrompt(null)}
      />

      <ConfirmModal
        isOpen={deleteTarget !== null}
        title="Delete"
        message={`Delete “${deleteTarget?.name ?? ''}”? This cannot be undone.`}
        confirmLabel="Delete"
        variant="danger"
        onConfirm={() => {
          if (deleteTarget) deleteMut.mutate({ target: deleteTarget.path });
          setDeleteTarget(null);
        }}
        onCancel={() => setDeleteTarget(null)}
      />
    </div>
  );
}
