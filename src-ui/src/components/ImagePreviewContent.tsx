import { Button } from './Button';
import { useRetainedAttachmentObjectUrls } from './chat/attachment-object-urls';
import { ImageInspector } from './ImageInspector';
import { PreviewDownloadLink } from './PreviewDownloadLink';
import { ResponsiveDialogCloseButton } from './ResponsiveDialogSurface';

export interface PreviewItem {
  url: string;
  mediaType: string;
  name?: string;
}

function imageExtension(mediaType: string): string {
  const subtype = mediaType.toLowerCase().split(';')[0].split('/')[1] ?? '';
  return subtype === 'jpeg' ? 'jpg' : subtype || 'png';
}

/** Gallery controls and inspection load only when an image preview is opened. */
export default function ImagePreviewContent({
  current,
  items,
  onSelect,
  onClose,
}: {
  current: PreviewItem;
  items: readonly PreviewItem[];
  onSelect: (item: PreviewItem) => void;
  onClose: () => void;
}) {
  // Same hold as the file preview (see FilePreviewContent), over the whole
  // gallery: prev/next must not land on a sibling eviction revoked.
  useRetainedAttachmentObjectUrls([
    current.url,
    ...items.map((item) => item.url),
  ]);
  const currentIdx = items.findIndex((item) => item.url === current.url);
  const selectAdjacentImage = (direction: -1 | 1) => {
    const next = items[currentIdx + direction];
    if (next) onSelect(next);
  };

  return (
    <>
      <ImageInspector
        src={current.url}
        name={current.name || 'Preview'}
        onNavigate={items.length > 1 ? selectAdjacentImage : undefined}
        galleryHeader={
          <>
            <ResponsiveDialogCloseButton
              label="Close preview"
              onClick={onClose}
            />
            <strong className="image-preview-title" title={current.name}>
              {current.name || 'Image preview'}
            </strong>
            <PreviewDownloadLink
              href={current.url}
              name={
                current.name || `image.${imageExtension(current.mediaType)}`
              }
            />
          </>
        }
      />
      {items.length > 1 && (
        <fieldset
          className="image-preview-navigation"
          aria-label="Image navigation"
        >
          <Button
            variant="ghost"
            aria-label="Previous image"
            title="Previous image"
            aria-disabled={currentIdx <= 0}
            onClick={() => selectAdjacentImage(-1)}
          >
            <svg aria-hidden="true" viewBox="0 0 20 20">
              <path d="m12 4-6 6 6 6" />
            </svg>
          </Button>
          <output aria-live="polite">
            {currentIdx + 1} / {items.length}
          </output>
          <Button
            variant="ghost"
            aria-label="Next image"
            title="Next image"
            aria-disabled={currentIdx >= items.length - 1}
            onClick={() => selectAdjacentImage(1)}
          >
            <svg aria-hidden="true" viewBox="0 0 20 20">
              <path d="m8 4 6 6-6 6" />
            </svg>
          </Button>
        </fieldset>
      )}
    </>
  );
}
