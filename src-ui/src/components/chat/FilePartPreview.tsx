import { authenticatedFetch } from '@kontourai/station-sdk';
import { useEffect, useRef, useState } from 'react';
import { useApiBase } from '../../contexts/ApiBaseContext';
import { usePreview } from '../../contexts/PreviewContext';
import { DocumentGlyph } from '../icons/Glyph';
import {
  type AttachmentObjectUrlSize,
  acquireAttachmentObjectUrl,
  attachmentBlobForObjectUrl,
  attachmentObjectUrlKey,
  attachmentObjectUrlSize,
  attachmentThumbnailKey,
  peekAttachmentObjectUrl,
  releaseAttachmentObjectUrl,
  retireAttachmentObjectUrl,
  storeAttachmentObjectUrl,
} from './attachment-object-urls';
import {
  createAttachmentThumbnail,
  dataUrlBlob,
  dataUrlShape,
  thumbnailWorthMaking,
} from './attachment-thumbnails';

interface FilePart {
  type: string;
  url?: string;
  /** Set when the bytes were not inline in this read — see `MessagePart.blobRef`. */
  blobRef?: string;
  mediaType?: string;
  name?: string;
}

interface FilePartPreviewProps {
  part: FilePart;
  allParts?: FilePart[];
}

/**
 * Fetch an attachment's bytes and hold an object URL for as long as this
 * component is displaying them (archive#3385). `<img src>` cannot carry a
 * bearer token, so the bytes come through `authenticatedFetch` and the URL is
 * minted locally.
 *
 * A failure — a reclaimed blob answering 404, an offline server — resolves to
 * no URL, which renders the same honest chip as an attachment that never had
 * a reference. It never retries in a loop and never blanks the chip.
 */
function useAttachmentObjectUrl(
  ref: string | undefined,
  mediaType: string | undefined,
): string | undefined {
  const { apiBase } = useApiBase();
  const [objectUrl, setObjectUrl] = useState<string | undefined>(undefined);

  useEffect(() => {
    if (!ref) {
      setObjectUrl(undefined);
      return;
    }
    const key = attachmentObjectUrlKey(ref, mediaType);
    let active = true;
    let held = false;

    const cached = acquireAttachmentObjectUrl(key);
    if (cached) {
      held = true;
      setObjectUrl(cached);
    } else {
      void (async () => {
        try {
          const response = await authenticatedFetch(
            `${apiBase}/api/attachments/${encodeURIComponent(ref)}`,
          );
          if (!response.ok) throw new Error('Attachment bytes unavailable');
          // The route serves inert octet-stream and names no type — the
          // declared type belongs to this attachment's metadata, which is
          // right here. Applying it locally is what makes the object URL
          // renderable as an image.
          const bytes = await response.arrayBuffer();
          const blob = new Blob([bytes], {
            type: mediaType ?? 'application/octet-stream',
          });
          const url = storeAttachmentObjectUrl(
            key,
            URL.createObjectURL(blob),
            blob,
          );
          if (!active) {
            releaseAttachmentObjectUrl(key);
            return;
          }
          held = true;
          setObjectUrl(url);
        } catch {
          if (active) setObjectUrl(undefined);
        }
      })();
    }

    return () => {
      active = false;
      if (held) releaseAttachmentObjectUrl(key);
    };
  }, [ref, mediaType, apiBase]);

  // Bytes already cached under this reference show on the very first render,
  // before the effect above claims its hold. A sent bubble switches from its
  // inline bytes to the recorded reference at `turn.started` (the bytes are
  // seeded here then), and waiting a frame for the effect would flash the
  // chip to an untappable placeholder.
  const cached = ref
    ? peekAttachmentObjectUrl(attachmentObjectUrlKey(ref, mediaType))
    : undefined;
  return cached ?? objectUrl;
}

type ChipThumbnail = AttachmentObjectUrlSize & { url: string };

/** What a resolved image URL holds: its type and size, read without decoding. */
function imageSourceShape(url: string, mediaType: string | undefined) {
  if (url.startsWith('data:')) return dataUrlShape(url);
  const blob = attachmentBlobForObjectUrl(url);
  return blob ? { type: mediaType ?? blob.type, size: blob.size } : null;
}

/**
 * The chip's thumbnail for a large still image (see `attachment-thumbnails`),
 * cached beside the full bytes so a row scrolled back into view does not
 * decode the photo again. `undefined` means show the image itself (small,
 * animated, or no thumbnail possible here); `'pending'` means one is being
 * made, and the chip keeps its icon rather than decode the full image for it.
 */
function useAttachmentThumbnail(
  key: string | undefined,
  url: string | undefined,
): ChipThumbnail | 'pending' | undefined {
  const [made, setMade] = useState<{
    key: string;
    value: ChipThumbnail | 'failed';
  } | null>(null);
  // The latest run, so a run can learn that this chip moved on to other bytes
  // (as opposed to unmounting, or StrictMode re-running the same key).
  const lastRun = useRef<{ key: string; switched: boolean } | null>(null);

  useEffect(() => {
    if (lastRun.current && lastRun.current.key !== key)
      lastRun.current.switched = true;
    if (!key || !url) {
      lastRun.current = null;
      return;
    }
    const thumbnailKey = attachmentThumbnailKey(key);
    const run = { key, switched: false };
    lastRun.current = run;
    let active = true;
    let held = false;
    const settle = (objectUrl: string) => {
      held = true;
      const size = attachmentObjectUrlSize(thumbnailKey);
      setMade({
        key,
        value: size ? { url: objectUrl, ...size } : 'failed',
      });
    };
    const cached = acquireAttachmentObjectUrl(thumbnailKey);
    if (cached) settle(cached);
    else {
      const source = url.startsWith('data:')
        ? dataUrlBlob(url)
        : attachmentBlobForObjectUrl(url);
      void (
        source ? createAttachmentThumbnail(source) : Promise.resolve(null)
      ).then((thumbnail) => {
        if (!thumbnail) {
          if (active) setMade({ key, value: 'failed' });
          return;
        }
        const objectUrl = storeAttachmentObjectUrl(
          thumbnailKey,
          URL.createObjectURL(thumbnail.blob),
          thumbnail.blob,
          { width: thumbnail.width, height: thumbnail.height },
        );
        if (!active) {
          releaseAttachmentObjectUrl(thumbnailKey);
          // This chip switched from inline bytes to their recorded reference
          // while the thumbnail was being made: it will not ask for the
          // data-URL name again, and keeping that name would retain the bytes
          // as the key. Another chip holding it keeps it until it lets go.
          if (run.switched && key.startsWith('data:'))
            retireAttachmentObjectUrl(thumbnailKey);
          return;
        }
        settle(objectUrl);
      });
    }
    return () => {
      active = false;
      if (held) releaseAttachmentObjectUrl(thumbnailKey);
    };
  }, [key, url]);

  if (!key || !url) return undefined;
  if (made?.key !== key) {
    // A thumbnail already cached for these bytes shows on the first render,
    // as the full bytes do above: a sent bubble's thumbnail moves to its
    // reference at `turn.started`, and a 'pending' frame would flash the icon.
    const cachedKey = attachmentThumbnailKey(key);
    const cachedUrl = peekAttachmentObjectUrl(cachedKey);
    const size = attachmentObjectUrlSize(cachedKey);
    return cachedUrl && size ? { url: cachedUrl, ...size } : 'pending';
  }
  return made.value === 'failed' ? undefined : made.value;
}

/** The thumbnail cache key for a large still image's bytes, if it gets one. */
function thumbnailKey(
  part: FilePart,
  resolvedUrl: string | undefined,
): string | undefined {
  if (part.type !== 'file' || !resolvedUrl) return undefined;
  if (part.mediaType?.startsWith('image/') !== true) return undefined;
  const shape = imageSourceShape(resolvedUrl, part.mediaType);
  if (!shape || !thumbnailWorthMaking(shape)) return undefined;
  return part.url ?? attachmentObjectUrlKey(part.blobRef ?? '', part.mediaType);
}

/**
 * The message's images for the previewer's prev/next. `peek` takes no hold,
 * so a sibling URL read here is only guaranteed for as long as that sibling
 * stays mounted — which, for chips in the same message list, is exactly as
 * long as this one. The gallery is built at click time from what its siblings
 * have already published; a sibling that has not resolved yet is omitted
 * rather than shown broken.
 */
function previewGallery(allParts: FilePart[] | undefined) {
  return (allParts || [])
    .filter((p) => p.type === 'file' && p.mediaType?.startsWith('image/'))
    .flatMap((p) => {
      const url =
        p.url ??
        (p.blobRef
          ? peekAttachmentObjectUrl(
              attachmentObjectUrlKey(p.blobRef, p.mediaType),
            )
          : undefined);
      return url
        ? [{ url, mediaType: p.mediaType as string, name: p.name }]
        : [];
    });
}

/** The chip's picture: its thumbnail, the image itself, or the icon. */
function ChipVisual({
  image,
  thumbnail,
  name,
}: {
  image: string | undefined;
  thumbnail: ChipThumbnail | 'pending' | undefined;
  name: string;
}) {
  if (!image || thumbnail === 'pending')
    return (
      <div className="file-part-preview__icon">
        <DocumentGlyph />
      </div>
    );
  return (
    <img
      src={thumbnail?.url ?? image}
      alt={name}
      className="file-part-preview__thumbnail"
      decoding="async"
      {...(thumbnail
        ? { width: thumbnail.width, height: thumbnail.height }
        : {})}
    />
  );
}

export function FilePartPreview({ part, allParts }: FilePartPreviewProps) {
  const { openPreview } = usePreview();
  // Inline bytes win: a read that already carried the data URL has nothing to
  // fetch. Only a reference without bytes reaches the blob route.
  const fetchedUrl = useAttachmentObjectUrl(
    part.url ? undefined : part.blobRef,
    part.mediaType,
  );
  const resolvedUrl = part.url ?? fetchedUrl;
  const isImage = part.mediaType?.startsWith('image/') === true;
  const thumbnail = useAttachmentThumbnail(
    thumbnailKey(part, resolvedUrl),
    resolvedUrl,
  );

  // A part with neither bytes nor a resolvable reference is an attachment whose
  // blob retention has reclaimed (archive#3374). It still renders: the name and
  // type are what the turn provably carried, and dropping the chip would turn a
  // missing preview into a missing attachment. It deliberately claims nothing
  // about why the bytes are absent, because the causes are indistinguishable
  // from here.
  if (part.type !== 'file' || !(resolvedUrl || part.name || part.mediaType)) {
    return null;
  }

  // Every attachment whose bytes resolved opens the previewer, whatever its
  // type: the previewer picks an inline view it can honestly render (image,
  // PDF, text) and otherwise offers the bytes as a download.
  const canOpen = Boolean(resolvedUrl);
  const showThumbnail = canOpen && isImage;
  const fileName = part.name || 'Attachment';
  const handleClick = canOpen
    ? () =>
        openPreview(
          {
            url: resolvedUrl!,
            mediaType: part.mediaType ?? 'application/octet-stream',
            name: fileName,
          },
          // Prev/next walks the images of this message; any other type opens
          // on its own.
          isImage ? previewGallery(allParts) : undefined,
        )
    : undefined;

  const previewContent = (
    <>
      <ChipVisual
        image={showThumbnail ? resolvedUrl : undefined}
        thumbnail={thumbnail}
        name={fileName}
      />
      <div className="file-part-preview__info">
        <div className="file-part-preview__name">{fileName}</div>
        <div className="file-part-preview__type">{part.mediaType}</div>
      </div>
    </>
  );

  if (canOpen) {
    return (
      <button
        type="button"
        className="file-part-preview file-part-preview--clickable"
        onClick={handleClick}
        aria-label={`Preview ${fileName}`}
      >
        {previewContent}
      </button>
    );
  }

  return <div className="file-part-preview">{previewContent}</div>;
}
