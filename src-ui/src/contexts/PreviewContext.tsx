import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from 'react';
import { retainAttachmentObjectUrl } from '../components/chat/attachment-object-urls';
import type { PreviewItem } from '../components/ImagePreviewContent';
import { LazyBoundary } from '../components/LazyBoundary';
import {
  ResponsiveDialogHeader,
  ResponsiveDialogSurface,
} from '../components/ResponsiveDialogSurface';
import { SkeletonBlock } from '../components/state';

const loadImagePreviewContent = () =>
  import('../components/ImagePreviewContent');
const loadFilePreviewContent = () => import('../components/FilePreviewContent');

interface PreviewContextType {
  openPreview: (item: PreviewItem, items?: PreviewItem[]) => void;
  closePreview: () => void;
}

function isImage(item: PreviewItem): boolean {
  return item.mediaType.startsWith('image/');
}

const PreviewContext = createContext<PreviewContextType | undefined>(undefined);

export function PreviewProvider({ children }: { children: ReactNode }) {
  const [current, setCurrent] = useState<PreviewItem | null>(null);
  const [items, setItems] = useState<PreviewItem[]>([]);

  const openPreview = useCallback(
    (item: PreviewItem, allItems?: PreviewItem[]) => {
      setCurrent(item);
      setItems(allItems || [item]);
    },
    [],
  );

  const closePreview = useCallback(() => {
    setCurrent(null);
    setItems([]);
  }, []);

  // The dialog holds what it shows. The opening chip's hold ends when the chip
  // unmounts, and cache eviction then revokes the URL under an open preview.
  const currentUrl = current?.url;
  useEffect(
    () => (currentUrl ? retainAttachmentObjectUrl(currentUrl) : undefined),
    [currentUrl],
  );

  // archive#3796: one memoised value per provider — a fresh object literal
  // here republishes the context to every consumer on any render of this
  // provider, whatever the render was actually about.
  const value = useMemo(
    () => ({ openPreview, closePreview }),
    [openPreview, closePreview],
  );

  return (
    <PreviewContext.Provider value={value}>
      {children}
      {current && (
        <ResponsiveDialogSurface
          onClose={closePreview}
          ariaLabel="Preview"
          layer="dialog"
          overlayClassName="image-preview-overlay"
          panelClassName="image-preview-panel"
        >
          <ResponsiveDialogHeader
            title={
              current.name ||
              (isImage(current) ? 'Image preview' : 'File preview')
            }
            closeLabel="Close preview"
            onClose={closePreview}
          />
          {isImage(current) ? (
            <LazyBoundary
              load={loadImagePreviewContent}
              componentProps={{
                current,
                items,
                onSelect: setCurrent,
              }}
              pending={
                <SkeletonBlock count={1} label="Loading image preview" />
              }
            />
          ) : (
            <LazyBoundary
              load={loadFilePreviewContent}
              componentProps={{ current }}
              pending={<SkeletonBlock count={1} label="Loading file preview" />}
            />
          )}
        </ResponsiveDialogSurface>
      )}
    </PreviewContext.Provider>
  );
}

/**
 * The previewer when one is mounted, else `undefined` — for renderers (such as
 * markdown) that also appear outside the chat shell and must degrade to plain
 * content there rather than throw.
 */
export function useOptionalPreview() {
  return useContext(PreviewContext);
}

export function usePreview() {
  const ctx = useContext(PreviewContext);
  if (!ctx) throw new Error('usePreview must be used within PreviewProvider');
  return ctx;
}
