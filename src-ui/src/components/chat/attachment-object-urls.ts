/**
 * Object URLs for attachment blobs fetched from `GET /api/attachments/:ref`
 * (station#3385).
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
): string {
  const existing = entries.get(ref);
  if (existing) {
    URL.revokeObjectURL(objectUrl);
    existing.holders += 1;
    return existing.objectUrl;
  }
  entries.set(ref, { objectUrl, holders: 1 });
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

/** Test seam: drop every entry and revoke every URL. */
export function resetAttachmentObjectUrls(): void {
  for (const [, entry] of entries) URL.revokeObjectURL(entry.objectUrl);
  entries.clear();
}
