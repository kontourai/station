import { authenticatedFetch } from '@kontourai/station-sdk';
import { useEffect, useState } from 'react';
import { useApiBase } from '../../contexts/ApiBaseContext';
import { usePreview } from '../../contexts/PreviewContext';
import { DocumentGlyph } from '../icons/Glyph';
import {
  acquireAttachmentObjectUrl,
  peekAttachmentObjectUrl,
  releaseAttachmentObjectUrl,
  storeAttachmentObjectUrl,
} from './attachment-object-urls';

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
 * The cache key is the reference AND the declared type, because the object URL
 * carries the type into the Blob. Content addressing alone would let two parts
 * that share bytes but declare different types resolve to one URL typed after
 * whichever rendered first.
 */
function cacheKey(ref: string, mediaType: string | undefined): string {
  return `${ref} ${mediaType ?? ''}`;
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
    const key = cacheKey(ref, mediaType);
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
          const url = storeAttachmentObjectUrl(
            key,
            URL.createObjectURL(
              new Blob([bytes], {
                type: mediaType ?? 'application/octet-stream',
              }),
            ),
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

  return objectUrl;
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

  // A part with neither bytes nor a resolvable reference is an attachment whose
  // blob retention has reclaimed (archive#3374). It still renders: the name and
  // type are what the turn provably carried, and dropping the chip would turn a
  // missing preview into a missing attachment. It deliberately claims nothing
  // about why the bytes are absent, because the causes are indistinguishable
  // from here.
  if (part.type !== 'file' || !(resolvedUrl || part.name || part.mediaType)) {
    return null;
  }

  const canPreview =
    Boolean(resolvedUrl) && part.mediaType?.startsWith('image/');
  const fileName = part.name || 'Attachment';
  const allPreviewable = (allParts || [])
    .filter((p) => p.type === 'file' && p.mediaType?.startsWith('image/'))
    .flatMap((p) => {
      // `peek` takes no hold, so a sibling URL read here is only guaranteed
      // for as long as that sibling stays mounted — which, for chips in the
      // same message list, is exactly as long as this one. The gallery is
      // built at click time from what its siblings have already published; a
      // sibling that has not resolved yet is omitted rather than shown broken.
      const url =
        p.url ??
        (p.blobRef
          ? peekAttachmentObjectUrl(cacheKey(p.blobRef, p.mediaType))
          : undefined);
      return url
        ? [{ url, mediaType: p.mediaType as string, name: p.name }]
        : [];
    });

  const handleClick = canPreview
    ? () =>
        openPreview(
          { url: resolvedUrl!, mediaType: part.mediaType!, name: fileName },
          allPreviewable,
        )
    : undefined;

  const previewContent = (
    <>
      {canPreview ? (
        <img
          src={resolvedUrl}
          alt={fileName}
          className="file-part-preview__thumbnail"
        />
      ) : (
        <div className="file-part-preview__icon">
          <DocumentGlyph />
        </div>
      )}
      <div className="file-part-preview__info">
        <div className="file-part-preview__name">{fileName}</div>
        <div className="file-part-preview__type">{part.mediaType}</div>
      </div>
    </>
  );

  if (canPreview) {
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
