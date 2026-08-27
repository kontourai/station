import {
  type RefObject,
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react';
import { filesFromDataTransfer } from '../utils/attachment-file-transfer';

type DragEventLike = {
  currentTarget: EventTarget & HTMLElement;
  dataTransfer: DataTransfer;
  nativeEvent: DragEvent;
  preventDefault(): void;
};

type DirectoryItem = DataTransferItem & {
  webkitGetAsEntry?: () => { isDirectory?: boolean } | null;
};

function isFileDrag(dataTransfer: DataTransfer): boolean {
  return (
    Array.from(dataTransfer.types).includes('Files') ||
    Array.from(dataTransfer.items ?? []).some((item) => item.kind === 'file')
  );
}

export function isChatPaneForeignFrameDrop(path: EventTarget[]): boolean {
  return path.some((node) => node instanceof HTMLIFrameElement);
}

function hasForeignFrame(event: DragEvent): boolean {
  return isChatPaneForeignFrameDrop(
    typeof event.composedPath === 'function' ? event.composedPath() : [],
  );
}

function hasDirectory(dataTransfer: DataTransfer): boolean {
  return Array.from(dataTransfer.items ?? []).some(
    (item) => (item as DirectoryItem).webkitGetAsEntry?.()?.isDirectory,
  );
}

function staysInsideRoot(event: DragEventLike): boolean {
  const related = event.nativeEvent.relatedTarget;
  return Boolean(related && event.currentTarget.contains(related as Node));
}

/** One full-pane external-file drop owner for the Station chat workspace. */
export function useChatPaneFileDrop({
  selectFiles,
  reportError,
  resetKey,
  rootRef,
  enabled = true,
}: {
  selectFiles: (files: File[]) => Promise<void>;
  reportError: (message: string | null) => void;
  /** Any identity/presentation change must synchronously remove the affordance. */
  resetKey: string;
  rootRef: RefObject<HTMLElement | null>;
  enabled?: boolean;
}) {
  const [fileCount, setFileCount] = useState(0);
  const lifecycleReady = useRef(true);
  const clear = useCallback(() => {
    setFileCount(0);
  }, []);

  useEffect(() => {
    if (resetKey === '') {
      clear();
      return;
    }
    clear();
  }, [clear, resetKey]);
  useEffect(() => {
    const root = rootRef.current;
    const lifecycleRoot = root?.closest<HTMLElement>(
      '[data-workspace-pane-lifecycle]',
    );
    if (!lifecycleRoot) {
      lifecycleReady.current = true;
      return;
    }
    const sync = () => {
      const ready = lifecycleRoot.dataset.workspacePaneLifecycle === 'ready';
      lifecycleReady.current = ready;
      if (!ready) clear();
    };
    sync();
    const observer = new MutationObserver(sync);
    observer.observe(lifecycleRoot, {
      attributes: true,
      attributeFilter: ['data-workspace-pane-lifecycle'],
    });
    return () => observer.disconnect();
  }, [clear, rootRef]);
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') clear();
    };
    const onWindowLeave = (event: DragEvent) => {
      if (event.relatedTarget === null) clear();
    };
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('dragend', clear);
    window.addEventListener('dragleave', onWindowLeave);
    window.addEventListener('blur', clear);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('dragend', clear);
      window.removeEventListener('dragleave', onWindowLeave);
      window.removeEventListener('blur', clear);
    };
  }, [clear]);

  const active = () => enabled && lifecycleReady.current;
  const reject = (event: DragEventLike, message: string) => {
    event.preventDefault();
    clear();
    reportError(message);
  };
  const onDragEnter = (event: DragEventLike) => {
    if (!active() || !isFileDrag(event.dataTransfer)) return;
    if (staysInsideRoot(event)) return;
    if (hasForeignFrame(event.nativeEvent)) {
      reject(event, 'Files from an embedded frame cannot be attached.');
      return;
    }
    if (hasDirectory(event.dataTransfer)) {
      reject(event, 'Folders cannot be attached. Choose individual files.');
      return;
    }
    const files = filesFromDataTransfer(event.dataTransfer);
    if (files.length === 0) return;
    event.preventDefault();
    setFileCount(files.length);
  };
  const onDragOver = (event: DragEventLike) => {
    if (active() && isFileDrag(event.dataTransfer)) event.preventDefault();
  };
  const onDragLeave = (event: DragEventLike) => {
    if (!active() || !isFileDrag(event.dataTransfer)) return;
    if (staysInsideRoot(event)) return;
    clear();
  };
  const onDrop = (event: DragEventLike) => {
    if (!active() || !isFileDrag(event.dataTransfer)) return;
    if (hasForeignFrame(event.nativeEvent)) {
      reject(event, 'Files from an embedded frame cannot be attached.');
      return;
    }
    if (hasDirectory(event.dataTransfer)) {
      reject(event, 'Folders cannot be attached. Choose individual files.');
      return;
    }
    event.preventDefault();
    const files = filesFromDataTransfer(event.dataTransfer);
    clear();
    if (files.length === 0) return;
    void selectFiles(files);
  };

  return {
    fileCount,
    isDraggingFiles: fileCount > 0,
    onDragEnter,
    onDragOver,
    onDragLeave,
    onDrop,
    onDragEnd: clear,
  };
}
