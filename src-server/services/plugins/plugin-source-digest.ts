/**
 * The bounded digest of a local plugin folder, read in place.
 *
 * Two callers need "what is in this folder now", in the encoding the install
 * preview's `contentDigest` uses, without staging a copy:
 *
 * - a plugin install proposal records it, so the review can say whether the
 *   folder changed since the agent proposed it (#2323 S5);
 * - the local source status compares it with the source digest an installed
 *   plugin recorded at consent, to offer "Reinstall from source" (#2323 S4).
 *
 * The encoding is `computePluginTreeDigest`, which is what
 * `derivePluginConsentBasis` runs on the preview's verbatim staging copy
 * (`PLUGIN_TREE_COPY`). Read with the yielding observer, never copied, and
 * only inside the bounds below; otherwise the caller learns why there is no
 * digest. The bounds are checked, then the digest reads the tree: a tree
 * that grows in between is read in full (the bound is a cost guard, not a
 * guarantee).
 */
import { lstat, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { observePluginTreeAsync } from '@kontourai/station-shared/plugin-tree-digest';

/** The bounds of the in-place digest walk (#2323 S5 review M4). */
export const LOCAL_SOURCE_DIGEST_MAX_ENTRIES = 5000;
const LOCAL_SOURCE_DIGEST_MAX_BYTES = 64 * 1024 * 1024;
const STAT_BATCH = 64;

/**
 * Counts a folder's entries and file bytes WITHOUT reading file contents or
 * following links, stopping at the first bound crossed. Mirrors the digest's
 * own walk (root `.git` excluded), so a tree inside the bounds is one the
 * digest will read in full. Returns `null` when the tree could not be read.
 *
 * Asynchronous on purpose (#2323 S4 review): a request-path caller must not
 * hold the event loop for a 5000-entry walk.
 */
async function withinDigestBounds(root: string): Promise<boolean | null> {
  let entries = 0;
  let bytes = 0;
  const walk = async (dir: string, top: boolean): Promise<boolean> => {
    const listed = (await readdir(dir, { withFileTypes: true })).filter(
      (entry) => !(top && entry.name === '.git'),
    );
    entries += listed.length;
    if (entries > LOCAL_SOURCE_DIGEST_MAX_ENTRIES) return false;
    const files = listed.filter((entry) => entry.isFile());
    // Sizes in bounded batches: one await per file made the pre-walk several
    // times slower than the digest it guards.
    for (let index = 0; index < files.length; index += STAT_BATCH) {
      const sizes = await Promise.all(
        files
          .slice(index, index + STAT_BATCH)
          .map(async (entry) => (await lstat(join(dir, entry.name))).size),
      );
      for (const size of sizes) bytes += size;
      if (bytes > LOCAL_SOURCE_DIGEST_MAX_BYTES) return false;
    }
    for (const entry of listed)
      if (entry.isDirectory() && !(await walk(join(dir, entry.name), false)))
        return false;
    return true;
  };
  try {
    return await walk(root, true);
  } catch {
    return null;
  }
}

export type LocalSourceDigestObservation =
  | { digest: string }
  | { unavailable: 'too-large' | 'unreadable' };

export async function observeLocalPluginSourceDigest(
  path: string,
): Promise<LocalSourceDigestObservation> {
  const bounded = await withinDigestBounds(path);
  if (bounded === null) return { unavailable: 'unreadable' };
  if (!bounded) return { unavailable: 'too-large' };
  const digest = (await observePluginTreeAsync(path))?.digest;
  return digest ? { digest } : { unavailable: 'unreadable' };
}
