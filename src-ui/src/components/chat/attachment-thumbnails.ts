/**
 * Thumbnails for image attachments.
 *
 * The chip shows an image at most 80px square, but an `<img>` given the
 * original bytes keeps the full decode for as long as it is mounted: a
 * 12-megapixel phone photo is about 48 MB of pixels, per chip, and iOS
 * WebKit reloads the page under that memory pressure. A thumbnail is decoded
 * once, drawn at twice the chip's size, and the full bytes stay only as the
 * compressed blob the previewer opens.
 */

/** The chip's 80px box at a 2x display. */
export const ATTACHMENT_THUMBNAIL_EDGE_PX = 160;
/** The chip's CSS box (`.file-part-preview__thumbnail`). */
export const ATTACHMENT_CHIP_EDGE_PX = 80;

/**
 * Below this an image decodes to little enough that a thumbnail saves less
 * than making it costs, so the chip shows the bytes themselves.
 */
const MIN_SOURCE_BYTES = 256 * 1024;

/** Still images only: a thumbnail would freeze an animation on its first frame. */
const RESIZABLE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);

export interface AttachmentThumbnail {
  readonly blob: Blob;
  /** The size to render the chip at, fitted inside its 80px box. */
  readonly width: number;
  readonly height: number;
}

export function thumbnailWorthMaking(source: {
  readonly type: string;
  readonly size: number;
}): boolean {
  return RESIZABLE_TYPES.has(source.type) && source.size >= MIN_SOURCE_BYTES;
}

/** A `data:` URL's media type and decoded size, read without decoding it. */
export function dataUrlShape(
  url: string,
): { type: string; size: number } | null {
  const match = /^data:([^;,]*)(;base64)?,/.exec(url);
  if (!match) return null;
  const payload = url.length - match[0].length;
  return {
    type: match[1],
    size: match[2] ? Math.floor((payload * 3) / 4) : payload,
  };
}

function fitWithin(width: number, height: number, edge: number) {
  const scale = Math.min(1, edge / Math.max(width, height));
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

async function encode(
  bitmap: ImageBitmap,
  width: number,
  height: number,
): Promise<Blob | null> {
  if (typeof OffscreenCanvas === 'function') {
    const canvas = new OffscreenCanvas(width, height);
    const context = canvas.getContext('2d');
    if (!context) return null;
    context.drawImage(bitmap, 0, 0, width, height);
    return canvas.convertToBlob({ type: 'image/png' });
  }
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d');
  if (!context) return null;
  context.drawImage(bitmap, 0, 0, width, height);
  return new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
}

/**
 * A small PNG of `source`, or `null` when this browser cannot make one or
 * the image is not worth it; the chip then shows the bytes as before.
 */
export async function createAttachmentThumbnail(
  source: Blob,
): Promise<AttachmentThumbnail | null> {
  if (!thumbnailWorthMaking(source) || typeof createImageBitmap !== 'function')
    return null;
  let bitmap: ImageBitmap | undefined;
  try {
    // Asking for the width lets the browser decode at the smaller size; one
    // that ignores the option hands back the full image, which `fitWithin` scales.
    bitmap = await createImageBitmap(source, {
      resizeWidth: ATTACHMENT_THUMBNAIL_EDGE_PX,
      resizeQuality: 'medium',
    });
    const drawn = fitWithin(
      bitmap.width,
      bitmap.height,
      ATTACHMENT_THUMBNAIL_EDGE_PX,
    );
    const blob = await encode(bitmap, drawn.width, drawn.height);
    if (!blob) return null;
    return {
      blob,
      ...fitWithin(drawn.width, drawn.height, ATTACHMENT_CHIP_EDGE_PX),
    };
  } catch {
    return null;
  } finally {
    bitmap?.close();
  }
}

/** The bytes of a `data:` URL, without `fetch` (the app CSP refuses `data:`). */
export function dataUrlBlob(url: string): Blob | null {
  const match = /^data:([^;,]*)(;base64)?,/.exec(url);
  if (!match) return null;
  const payload = url.slice(match[0].length);
  try {
    if (!match[2])
      return new Blob([decodeURIComponent(payload)], { type: match[1] });
    const binary = atob(payload);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1)
      bytes[index] = binary.charCodeAt(index);
    return new Blob([bytes], { type: match[1] });
  } catch {
    return null;
  }
}
