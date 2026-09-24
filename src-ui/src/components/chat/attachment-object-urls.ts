import { useEffect } from 'react';

/**
 * Object URLs for attachment blobs fetched from `GET /api/attachments/:ref`
 * (archive#3385).
 *
 * An `<img src>` cannot carry a bearer token, so the bytes are fetched and
 * wrapped in an object URL. That leaves the browser holding the blob until
 * something revokes it, and a long transcript can hold hundreds — hence a
 * cache with two jobs rather than a bare `createObjectURL` per render:
 *
 * - **One URL per reference.** The preview modal identifies the image the
 *   gallery is showing by its URL string, so minting a second URL for the same
 *   bytes would break prev/next. Content addressing makes this exact: one
 *   digest, one URL.
 * - **Bounded, and never revoked out from under a mounted image.** Holders are
 *   counted; only an entry no component is displaying is eligible for
 *   eviction, and eviction is what revokes.
 */

const MAX_IDLE_ENTRIES = 32;

interface CacheEntry {
  objectUrl: string;
  holders: number;
  /**
   * The bytes behind `objectUrl`. Kept because a non-image preview needs them
   * as text, and the desktop/mobile CSP (`connect-src`) does not admit
   * `fetch('blob:…')` — re-reading the URL would fail on exactly the devices
   * that most need a preview.
   */
  blob?: Blob;
}

/** Insertion-ordered, so the iteration order is least-recently-acquired first. */
const entries = new Map<string, CacheEntry>();

function evictIdle(): void {
  for (const [ref, entry] of entries) {
    if (entries.size <= MAX_IDLE_ENTRIES) return;
    // A displayed image outlives the budget: revoking its URL would blank a
    // picture the user is looking at, which is worse than holding the bytes.
    if (entry.holders > 0) continue;
    entries.delete(ref);
    URL.revokeObjectURL(entry.objectUrl);
  }
}

/**
 * The URL for `ref` if it is already cached, claiming a hold on it. Returns
 * `undefined` when nothing has fetched these bytes yet.
 */
export function acquireAttachmentObjectUrl(ref: string): string | undefined {
  const entry = entries.get(ref);
  if (!entry) return undefined;
  entry.holders += 1;
  // Re-insert so recency ordering reflects this acquisition.
  entries.delete(ref);
  entries.set(ref, entry);
  return entry.objectUrl;
}

/**
 * Publish a freshly fetched blob under `ref`, claiming a hold. If another
 * caller won the race, its URL is authoritative and `objectUrl` is revoked
 * here — two URLs for one digest is the thing this cache exists to prevent.
 */
export function storeAttachmentObjectUrl(
  ref: string,
  objectUrl: string,
  blob?: Blob,
): string {
  const existing = entries.get(ref);
  if (existing) {
    URL.revokeObjectURL(objectUrl);
    existing.holders += 1;
    return existing.objectUrl;
  }
  entries.set(ref, { objectUrl, holders: 1, ...(blob ? { blob } : {}) });
  evictIdle();
  return objectUrl;
}

/** Drop one hold. The URL survives until the cache needs the room. */
export function releaseAttachmentObjectUrl(ref: string): void {
  const entry = entries.get(ref);
  if (!entry) return;
  entry.holders = Math.max(entry.holders - 1, 0);
  evictIdle();
}

/**
 * The URL for `ref` without claiming a hold — for building the preview
 * gallery's sibling list, which reads other chips' resolved URLs but does not
 * display them.
 */
export function peekAttachmentObjectUrl(ref: string): string | undefined {
  return entries.get(ref)?.objectUrl;
}

/**
 * Hold a cached object URL by the URL itself, for a consumer that has the URL
 * but not the key — the preview dialog, which must keep the bytes alive after
 * the chip that opened it unmounts (a scrolled or switched transcript), or
 * eviction would revoke the file the user is looking at. Returns the release;
 * a URL this cache does not own (a data: URL, a markdown image's http URL) is a
 * no-op.
 */
export function retainAttachmentObjectUrl(objectUrl: string): () => void {
  for (const [ref, entry] of entries) {
    if (entry.objectUrl !== objectUrl) continue;
    entry.holders += 1;
    return () => releaseAttachmentObjectUrl(ref);
  }
  return () => {};
}

/**
 * Hold `objectUrl` for as long as the calling component shows it. Used by the
 * preview dialog's (lazily loaded) bodies rather than the eager provider, so
 * the cache stays out of the entry chunk.
 */
export function useRetainedAttachmentObjectUrl(objectUrl: string): void {
  useEffect(() => retainAttachmentObjectUrl(objectUrl), [objectUrl]);
}

/**
 * The bytes a cached object URL was minted from, or `undefined` when the URL
 * is not (or no longer) one of ours.
 */
export function attachmentBlobForObjectUrl(
  objectUrl: string,
): Blob | undefined {
  for (const [, entry] of entries) {
    if (entry.objectUrl === objectUrl) return entry.blob;
  }
  return undefined;
}

/** Test seam: drop every entry and revoke every URL. */
export function resetAttachmentObjectUrls(): void {
  for (const [, entry] of entries) URL.revokeObjectURL(entry.objectUrl);
  entries.clear();
}
