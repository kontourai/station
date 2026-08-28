/**
 * Client-side image shrinking for the composer (archive#3375).
 *
 * COVERAGE BOUNDARY — read before changing `browserDecoder` or
 * `browserReencoder`. Everything above the seam (the ladder, the format policy,
 * the byte accounting, the refusals) is unit-tested in
 * `src-ui/src/__tests__/downscaleImage.test.ts` against substituted decode and
 * re-encode functions. The two default implementations at that seam are NOT
 * covered by any checked-in test: they need `createImageBitmap` and a canvas
 * 2D context, neither of which jsdom provides, and this repo has no `canvas`
 * dev dependency. No E2E spec pastes an image either.
 *
 * They were proven by hand: this module bundled verbatim and run in Chromium
 * against a 41 MB 4000x3000 PNG of random pixels ( re-run against
 * this file after the decode hoist). It produced WebP 2048x1536 at 1,997,934
 * bytes under the 5 MB cap; the same pixels as a 12 MB JPEG source stayed JPEG
 * at 1,739,485 bytes; a 400 KB cap produced 1024x768; a 64-byte cap refused.
 * Every result round-tripped through `createImageBitmap` at its reported
 * dimensions with `bytes` equal to its decoded length. (The source is randomly
 * generated, so the exact byte counts move a little run to run.) That probe is
 * not in the tree and does not run in CI, so it defends nothing going forward.
 *
 * What that leaves: a regression in these two functions would not be caught
 * here. It would surface as `downscaleImageToFit` answering `null` — every
 * oversized paste refused with "could not be resized on this device" — because
 * the caller treats a throw and a null identically (see `chatAttachments.ts`).
 * A silent WRONG result is the case to watch for, and the guard against it is
 * the `blob.type !== attempt.mimeType` check below plus the caller's re-derived
 * byte count, both of which the server independently re-validates.
 */
import {
  CHAT_ATTACHMENT_MAX_BYTES,
  type ChatImageMimeType,
  parseChatAttachmentDataUrl,
} from '@kontourai/station-contracts/chat-attachment';

/**
 * Longest edge of the first attempt — a 4K screenshot lands here, which is
 * still more resolution than any model reads.
 */
export const DOWNSCALE_MAX_EDGE = 2048;

const EDGE_LADDER = [DOWNSCALE_MAX_EDGE, 1440, 1024] as const;
const QUALITY_LADDER = [0.85, 0.6] as const;
/** `toBlob` ignores quality for PNG; passing one would suggest otherwise. */
const LOSSLESS_QUALITY = 1;

export interface DownscaleAttempt {
  /** Longest edge to fit within. A smaller source is never enlarged. */
  maxEdge: number;
  mimeType: ChatImageMimeType;
  quality: number;
}

export interface ReencodedImage {
  blob: Blob;
  width: number;
  height: number;
}

/**
 * Re-encode one already-decoded image at the requested size, format and
 * quality, or answer `null` when this environment cannot produce exactly that.
 * The seam exists so the ladder above it — which format to keep, which to fall
 * back to, when to give up — is testable without a canvas.
 *
 * It takes a decoded `source`, not the file: the ladder can run up to 13
 * attempts, and decoding a 4000x3000 image once per attempt is the difference
 * between one decode and thirteen on a phone.
 */
export type ImageReencoder = (
  source: DecodedImage,
  attempt: DownscaleAttempt,
) => Promise<ReencodedImage | null>;

/** A source decoded once, reused by every attempt in the ladder. */
export interface DecodedImage {
  readonly width: number;
  readonly height: number;
  /** Released once the ladder is done with it. */
  close(): void;
}

export type ImageDecoder = (file: Blob) => Promise<DecodedImage | null>;

export interface DownscaledImage {
  dataUrl: string;
  mimeType: ChatImageMimeType;
  /**
   * Decoded byte count of `dataUrl`, read back off the encoded string rather
   * than taken from the blob. It is the number the attachment's `size` must
   * carry, and the server independently re-derives it the same way.
   */
  bytes: number;
  width: number;
  height: number;
}

/**
 * The formats to try, in order, for a source of `mimeType`.
 *
 * Keeping the source format is one attempt, not a ladder: a photograph saved
 * as PNG does not get materially smaller by being re-encoded as a smaller PNG,
 * and the fallbacks are where the size actually comes from. WebP precedes JPEG
 * because it keeps the alpha channel a PNG may be carrying — a screenshot with
 * a transparent corner turning black is not "resized", it is altered.
 *
 * GIF is deliberately absent. Canvas re-encoding reads one frame, so an
 * oversized animated GIF would arrive as a still image while the composer
 * claimed only that it had been resized. Refusing it is the honest answer.
 */
export function downscaleAttempts(
  mimeType: ChatImageMimeType,
): DownscaleAttempt[] {
  if (mimeType === 'image/gif') return [];

  const attempts: DownscaleAttempt[] = [];
  if (mimeType === 'image/png') {
    attempts.push({
      maxEdge: DOWNSCALE_MAX_EDGE,
      mimeType: 'image/png',
      quality: LOSSLESS_QUALITY,
    });
  }
  const lossy: ChatImageMimeType[] =
    mimeType === 'image/jpeg'
      ? ['image/jpeg', 'image/webp']
      : ['image/webp', 'image/jpeg'];
  for (const target of lossy) {
    for (const maxEdge of EDGE_LADDER) {
      for (const quality of QUALITY_LADDER) {
        attempts.push({ maxEdge, mimeType: target, quality });
      }
    }
  }
  return attempts;
}

/**
 * Whether the ladder will attempt this format at all — derived from
 * {@link downscaleAttempts}, never a second list that could disagree with it.
 * A caller needs this to tell "nothing was tried" apart from "everything was
 * tried and nothing fit", which are different things to tell a user.
 */
export function canResizeFormat(mimeType: ChatImageMimeType): boolean {
  return downscaleAttempts(mimeType).length > 0;
}

/**
 * Why {@link canResizeFormat} said no. Owned here, with the policy — and GIF is
 * the whole of that policy today, so this takes no argument rather than
 * carrying a branch for mime types that can never reach it.
 */
export function formatNotResizableReason(): string {
  return 'An animated image cannot be resized without flattening it to a single frame. Convert it to PNG or JPEG, or attach a smaller file.';
}

function blobToDataUrl(blob: Blob): Promise<string | null> {
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onerror = () => resolve(null);
    reader.onload = () =>
      resolve(typeof reader.result === 'string' ? reader.result : null);
    reader.readAsDataURL(blob);
  });
}

const browserDecoder: ImageDecoder = async (file) => {
  if (
    typeof createImageBitmap !== 'function' ||
    typeof document === 'undefined'
  ) {
    return null;
  }
  try {
    return await createImageBitmap(file);
  } catch {
    return null;
  }
};

const browserReencoder: ImageReencoder = async (source, attempt) => {
  if (typeof document === 'undefined') return null;
  const scale = Math.min(
    1,
    attempt.maxEdge / Math.max(source.width, source.height),
  );
  const width = Math.max(1, Math.round(source.width * scale));
  const height = Math.max(1, Math.round(source.height * scale));
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d');
  if (!context) return null;
  context.drawImage(
    source as unknown as CanvasImageSource,
    0,
    0,
    width,
    height,
  );
  const blob = await new Promise<Blob | null>((resolve) => {
    canvas.toBlob(resolve, attempt.mimeType, attempt.quality);
  });
  // `toBlob` answers a PNG for any type it cannot encode, without saying so.
  // Accepting that blob would ship a format nothing above asked for, under
  // the mime type that was asked for.
  if (!blob || blob.type !== attempt.mimeType) return null;
  return { blob, width, height };
};

/**
 * Shrink one oversized image until it fits, or say which way it failed.
 *
 * The two failures are different facts and a caller has to be able to tell a
 * user which one happened: `undecodable` means these bytes never became an
 * image here (no `createImageBitmap`, or a corrupt file), while `too-large`
 * means the whole ladder ran and nothing came back small enough. A caller that
 * needs "this format is never attempted" asks {@link canResizeFormat} first;
 * that case reports `undecodable` here, because nothing was decoded.
 */
export type DownscaleOutcome =
  | { status: 'resized'; image: DownscaledImage }
  | { status: 'undecodable' }
  | { status: 'too-large' };

export async function downscaleImageToFit(
  file: Blob,
  mimeType: ChatImageMimeType,
  maxBytes: number = CHAT_ATTACHMENT_MAX_BYTES,
  reencode: ImageReencoder = browserReencoder,
  decode: ImageDecoder = browserDecoder,
): Promise<DownscaleOutcome> {
  const attempts = downscaleAttempts(mimeType);
  if (attempts.length === 0) return { status: 'undecodable' };
  const source = await decode(file);
  if (!source) return { status: 'undecodable' };
  try {
    const image = await runLadder(source, attempts, maxBytes, reencode);
    return image ? { status: 'resized', image } : { status: 'too-large' };
  } finally {
    source.close();
  }
}

async function runLadder(
  source: DecodedImage,
  attempts: readonly DownscaleAttempt[],
  maxBytes: number,
  reencode: ImageReencoder,
): Promise<DownscaledImage | null> {
  for (const attempt of attempts) {
    const encoded = await reencode(source, attempt);
    if (!encoded) continue;
    if (encoded.blob.size > maxBytes) continue;
    const dataUrl = await blobToDataUrl(encoded.blob);
    if (!dataUrl) continue;
    const parsed = parseChatAttachmentDataUrl(dataUrl);
    if (!parsed || parsed.mimeType !== attempt.mimeType) continue;
    if (parsed.decodedBytes < 1 || parsed.decodedBytes > maxBytes) continue;
    return {
      dataUrl,
      mimeType: attempt.mimeType,
      bytes: parsed.decodedBytes,
      width: encoded.width,
      height: encoded.height,
    };
  }
  return null;
}
