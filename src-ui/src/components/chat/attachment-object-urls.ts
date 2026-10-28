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
 *
 * An entry can be found under more than one name while a sent bubble switches
 * from its inline bytes to the recorded reference (`moveAttachmentObjectUrl`).
 * Holds are counted per name, so every holder's release finds the entry under
 * the name it acquired, and a retired name disappears only once nothing holds
 * through it. The URL is revoked only when the entry has no names left.
 */

const MAX_IDLE_ENTRIES = 32;

interface CacheEntry {
  objectUrl: string;
  /** Total holds across every name. */
  holders: number;
  /** Holds taken through each name this entry is found under. */
  holdsByName: Map<string, number>;
  /** Names that go away once nothing holds through them. */
  retiring: Set<string>;
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

function newEntry(
  objectUrl: string,
  blob?: Blob,
  size?: AttachmentObjectUrlSize,
): CacheEntry {
  return {
    objectUrl,
    holders: 0,
    holdsByName: new Map(),
    retiring: new Set(),
    ...(blob ? { blob } : {}),
    ...(size ? { size } : {}),
  };
}

function hold(name: string, entry: CacheEntry): void {
  entry.holders += 1;
  entry.holdsByName.set(name, (entry.holdsByName.get(name) ?? 0) + 1);
}

/** Remove one name; the URL is revoked when it was the entry's last. */
function removeName(name: string, entry: CacheEntry): void {
  entries.delete(name);
  entry.retiring.delete(name);
  entry.holdsByName.delete(name);
  for (const other of entries.values()) if (other === entry) return;
  URL.revokeObjectURL(entry.objectUrl);
}

function evictIdle(): void {
  for (const [ref, entry] of entries) {
    if (entries.size <= MAX_IDLE_ENTRIES) return;
    // A displayed image outlives the budget: revoking its URL would blank a
    // picture the user is looking at, which is worse than holding the bytes.
    if (entry.holders > 0) continue;
    removeName(ref, entry);
  }
}

/**
 * The URL for `ref` if it is already cached, claiming a hold on it. Returns
 * `undefined` when nothing has fetched these bytes yet.
 */
export function acquireAttachmentObjectUrl(ref: string): string | undefined {
  const entry = entries.get(ref);
  if (!entry) return undefined;
  hold(ref, entry);
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
    hold(ref, existing);
    return existing.objectUrl;
  }
  const entry = newEntry(objectUrl, blob, size);
  entries.set(ref, entry);
  hold(ref, entry);
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

function holdForHandoff(name: string, entry: CacheEntry): void {
  hold(name, entry);
  setTimeout(() => {
    // Only the hold this call took, and only on the entry it took it on.
    if (entries.get(name) === entry) releaseAttachmentObjectUrl(name);
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
  const entry = newEntry(URL.createObjectURL(blob), blob);
  entries.set(ref, entry);
  holdForHandoff(ref, entry);
  evictIdle();
}

/**
 * Find an entry under `to` as well, and retire `from` (see
 * `retireAttachmentObjectUrl`). A sent bubble's thumbnail is cached under its
 * inline data URL until the turn records a reference; this keeps the chip's
 * picture across that switch without the multi-megabyte data URL staying a
 * cache key. Another chip still holding through `from` keeps it (and the
 * URL) until it releases. When `to` is already cached, only `from` retires.
 */
export function moveAttachmentObjectUrl(from: string, to: string): void {
  const entry = entries.get(from);
  if (!entry) return;
  if (!entries.has(to)) {
    entries.set(to, entry);
    holdForHandoff(to, entry);
  }
  retireAttachmentObjectUrl(from);
}

/**
 * Stop finding an entry under `name` once nothing holds through it: now, or
 * at the last such holder's release. It takes no one's hold away, and the URL
 * is revoked only when no name is left.
 */
export function retireAttachmentObjectUrl(name: string): void {
  const entry = entries.get(name);
  if (!entry) return;
  if ((entry.holdsByName.get(name) ?? 0) > 0) entry.retiring.add(name);
  else removeName(name, entry);
}

/** Drop one hold. The URL survives until the cache needs the room. */
export function releaseAttachmentObjectUrl(ref: string): void {
  const entry = entries.get(ref);
  if (!entry) return;
  const held = entry.holdsByName.get(ref) ?? 0;
  if (held > 0) {
    entry.holdsByName.set(ref, held - 1);
    entry.holders -= 1;
  }
  if (held <= 1 && entry.retiring.has(ref)) removeName(ref, entry);
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
    hold(ref, entry);
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
  for (const entry of new Set(entries.values()))
    URL.revokeObjectURL(entry.objectUrl);
  entries.clear();
}
