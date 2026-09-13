import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useMemo,
  useState,
} from 'react';
import type { PreviewItem } from '../components/ImagePreviewContent';
import { LazyBoundary } from '../components/LazyBoundary';
import {
  ResponsiveDialogHeader,
  ResponsiveDialogSurface,
} from '../components/ResponsiveDialogSurface';
import { SkeletonBlock } from '../components/state';

const loadImagePreviewContent = () =>
  import('../components/ImagePreviewContent');

interface PreviewContextType {
  openPreview: (item: PreviewItem, items?: PreviewItem[]) => void;
  closePreview: () => void;
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
      {current?.mediaType?.startsWith('image/') && (
        <ResponsiveDialogSurface
          onClose={closePreview}
          ariaLabel="Preview"
          layer="dialog"
          overlayClassName="image-preview-overlay"
          panelClassName="image-preview-panel"
        >
          <ResponsiveDialogHeader
            title={current.name || 'Image preview'}
            closeLabel="Close preview"
            onClose={closePreview}
          />
          <LazyBoundary
            load={loadImagePreviewContent}
            componentProps={{
              current,
              items,
              onSelect: setCurrent,
            }}
            pending={<SkeletonBlock count={1} label="Loading image preview" />}
          />
        </ResponsiveDialogSurface>
      )}
    </PreviewContext.Provider>
  );
}

export function usePreview() {
  const ctx = useContext(PreviewContext);
  if (!ctx) throw new Error('usePreview must be used within PreviewProvider');
  return ctx;
}
