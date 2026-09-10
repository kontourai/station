import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useMemo,
  useState,
} from 'react';
import { Button } from '../components/Button';
import { LazyBoundary } from '../components/LazyBoundary';
import {
  ResponsiveDialogHeader,
  ResponsiveDialogSurface,
} from '../components/ResponsiveDialogSurface';
import { SkeletonBlock } from '../components/state';

const loadImageInspector = () =>
  import('../components/ImageInspector').then((module) => ({
    default: module.ImageInspector,
  }));

interface PreviewItem {
  url: string;
  mediaType: string;
  name?: string;
}

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

  const currentIdx = current
    ? items.findIndex((i) => i.url === current.url)
    : -1;
  const canPrev = currentIdx > 0;
  const canNext = currentIdx < items.length - 1;

  const selectAdjacentImage = (direction: -1 | 1) => {
    const next = items[currentIdx + direction];
    if (next) setCurrent(next);
  };

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
          {items.length > 1 && (
            <fieldset
              className="image-preview-navigation"
              aria-label="Image navigation"
            >
              <Button
                aria-disabled={!canPrev}
                onClick={() => selectAdjacentImage(-1)}
              >
                Previous image
              </Button>
              <span>
                {currentIdx + 1} / {items.length}
              </span>
              <Button
                aria-disabled={!canNext}
                onClick={() => selectAdjacentImage(1)}
              >
                Next image
              </Button>
            </fieldset>
          )}
          <LazyBoundary
            load={loadImageInspector}
            componentProps={{
              src: current.url,
              name: current.name || 'Preview',
              onNavigate: selectAdjacentImage,
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
