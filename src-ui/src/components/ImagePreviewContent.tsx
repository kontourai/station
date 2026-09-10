import { Button } from './Button';
import { ImageInspector } from './ImageInspector';

export interface PreviewItem {
  url: string;
  mediaType: string;
  name?: string;
}

/** Gallery controls and inspection load only when an image preview is opened. */
export default function ImagePreviewContent({
  current,
  items,
  onSelect,
}: {
  current: PreviewItem;
  items: readonly PreviewItem[];
  onSelect: (item: PreviewItem) => void;
}) {
  const currentIdx = items.findIndex((item) => item.url === current.url);
  const selectAdjacentImage = (direction: -1 | 1) => {
    const next = items[currentIdx + direction];
    if (next) onSelect(next);
  };

  return (
    <>
      {items.length > 1 && (
        <fieldset
          className="image-preview-navigation"
          aria-label="Image navigation"
        >
          <Button
            aria-disabled={currentIdx <= 0}
            onClick={() => selectAdjacentImage(-1)}
          >
            Previous image
          </Button>
          <span>
            {currentIdx + 1} / {items.length}
          </span>
          <Button
            aria-disabled={currentIdx >= items.length - 1}
            onClick={() => selectAdjacentImage(1)}
          >
            Next image
          </Button>
        </fieldset>
      )}
      <ImageInspector
        src={current.url}
        name={current.name || 'Preview'}
        onNavigate={selectAdjacentImage}
      />
    </>
  );
}
