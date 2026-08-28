import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useMemo,
  useState,
} from 'react';
import { ResponsiveDialogCloseButton } from '../components/ResponsiveDialogSurface';

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

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') closePreview();
    else if (e.key === 'ArrowLeft' && canPrev)
      setCurrent(items[currentIdx - 1]);
    else if (e.key === 'ArrowRight' && canNext)
      setCurrent(items[currentIdx + 1]);
  };

  const canPreview = (mediaType?: string) => mediaType?.startsWith('image/');

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
      {current && canPreview(current.mediaType) && (
        <div
          className="image-preview-modal"
          data-escape-owner
          onClick={closePreview}
          onKeyDown={handleKeyDown}
          role="dialog"
          aria-label="Preview"
          ref={(el) => el?.focus()}
        >
          <ResponsiveDialogCloseButton
            className="image-preview-modal__close"
            onClick={closePreview}
            label="Close preview"
          />
          {canPrev && (
            <button
              type="button"
              className="image-preview-modal__nav image-preview-modal__nav--prev"
              onClick={(e) => {
                e.stopPropagation();
                setCurrent(items[currentIdx - 1]);
              }}
            >
              ‹
            </button>
          )}
          <img
            src={current.url}
            alt={current.name || 'Preview'}
            className="image-preview-modal__image"
            onClick={(e) => e.stopPropagation()}
            onKeyDown={(event) => {
              if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                event.currentTarget.click();
              }
            }}
          />
          {canNext && (
            <button
              type="button"
              className="image-preview-modal__nav image-preview-modal__nav--next"
              onClick={(e) => {
                e.stopPropagation();
                setCurrent(items[currentIdx + 1]);
              }}
            >
              ›
            </button>
          )}
        </div>
      )}
    </PreviewContext.Provider>
  );
}

export function usePreview() {
  const ctx = useContext(PreviewContext);
  if (!ctx) throw new Error('usePreview must be used within PreviewProvider');
  return ctx;
}
