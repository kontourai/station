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
  /** For a thumbnail: the size its chip renders at. */
  size?: AttachmentObjectUrlSize;
}

export interface AttachmentObjectUrlSize {
  readonly width: number;
  readonly height: number;
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
  size?: AttachmentObjectUrlSize,
): string {
  const existing = entries.get(ref);
  if (existing) {
    URL.revokeObjectURL(objectUrl);
    existing.holders += 1;
    return existing.objectUrl;
  }
  entries.set(ref, {
    objectUrl,
    holders: 1,
    ...(blob ? { blob } : {}),
    ...(size ? { size } : {}),
  });
  evictIdle();
  return objectUrl;
}

/**
 * The cache key for a reference's bytes: the reference AND the declared type,
 * because the object URL carries the type into the Blob. Content addressing
 * alone would let two parts that share bytes but declare different types
 * resolve to one URL typed after whichever rendered first.
 */
export function attachmentObjectUrlKey(
  ref: string,
  mediaType: string | undefined,
): string {
  return `${ref} ${mediaType ?? ''}`;
}

/** The cache key for the chip thumbnail of the bytes cached under `key`. */
export function attachmentThumbnailKey(key: string): string {
  return `thumbnail ${key}`;
}

/**
 * How long a seeded or moved entry is held for the chip that is about to ask
 * for it. The chip re-renders and takes its own hold within a frame; until it
 * does, eviction must not revoke the URL its first render already shows.
 */
const HANDOFF_HOLD_MS = 10_000;

function holdForHandoff(ref: string, entry: CacheEntry): void {
  entry.holders += 1;
  setTimeout(() => {
    // Only the hold this call took, and only on the entry it took it on.
    if (entries.get(ref) === entry) releaseAttachmentObjectUrl(ref);
  }, HANDOFF_HOLD_MS);
}

/**
 * Publish bytes this client already has under `ref`, so the next chip that
 * asks for the reference finds them instead of fetching what it just sent.
 * The entry is held only briefly (see `HANDOFF_HOLD_MS`), then idle and
 * evictable like any other; an existing entry for `ref` is left alone.
 */
export function seedAttachmentObjectUrl(ref: string, blob: Blob): void {
  if (entries.has(ref)) return;
  const entry: CacheEntry = {
    objectUrl: URL.createObjectURL(blob),
    holders: 0,
    blob,
  };
  entries.set(ref, entry);
  holdForHandoff(ref, entry);
  evictIdle();
}

/**
 * Re-key an entry: the same URL and bytes, now found under `to`. A sent
 * bubble's thumbnail is cached under its inline data URL until the turn
 * records a reference; moving it keeps the chip's picture across that switch
 * and stops the multi-megabyte data URL being retained as a cache key. Holds
 * taken under `from` stay with whoever took them (their release becomes a
 * no-op), so the moved entry starts with only the hand-off hold. When `to`
 * is already cached, `from` is simply dropped.
 */
export function moveAttachmentObjectUrl(from: string, to: string): void {
  const entry = entries.get(from);
  if (!entry) return;
  entries.delete(from);
  if (entries.has(to)) {
    revokeAfterHandoff(entry);
    return;
  }
  const moved: CacheEntry = { ...entry, holders: 0 };
  entries.set(to, moved);
  holdForHandoff(to, moved);
}

/**
 * Forget an entry nothing will ask for again. Its URL is revoked once a
 * still-mounted holder has had time to re-render away from it.
 */
export function dropAttachmentObjectUrl(ref: string): void {
  const entry = entries.get(ref);
  if (!entry) return;
  entries.delete(ref);
  revokeAfterHandoff(entry);
}

function revokeAfterHandoff(entry: CacheEntry): void {
  if (entry.holders === 0) URL.revokeObjectURL(entry.objectUrl);
  else setTimeout(() => URL.revokeObjectURL(entry.objectUrl), HANDOFF_HOLD_MS);
}

/** Drop one hold. The URL survives until the cache needs the room. */
export function releaseAttachmentObjectUrl(ref: string): void {
  const entry = entries.get(ref);
  if (!entry) return;
  entry.holders = Math.max(entry.holders - 1, 0);
  evictIdle();
}

/** The render size stored with `ref`, if any. */
export function attachmentObjectUrlSize(
  ref: string,
): AttachmentObjectUrlSize | undefined {
  return entries.get(ref)?.size;
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
function retainAttachmentObjectUrl(objectUrl: string): () => void {
  for (const [ref, entry] of entries) {
    if (entry.objectUrl !== objectUrl) continue;
    entry.holders += 1;
    return () => releaseAttachmentObjectUrl(ref);
  }
  return () => {};
}

/**
 * Hold `objectUrls` for as long as the calling component can show them. Used by the
 * preview dialog's (lazily loaded) bodies rather than the eager provider, so
 * the cache stays out of the entry chunk.
 */
export function useRetainedAttachmentObjectUrls(
  objectUrls: readonly string[],
): void {
  // Keyed on the joined list so a re-rendered but identical gallery does not
  // churn its holds.
  const key = objectUrls.join('\n');
  useEffect(() => {
    const releases = key.split('\n').map(retainAttachmentObjectUrl);
    return () => {
      for (const release of releases) release();
    };
  }, [key]);
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
