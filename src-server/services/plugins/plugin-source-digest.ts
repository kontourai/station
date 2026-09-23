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
import { lstatSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { observePluginTreeAsync } from '@kontourai/station-shared/plugin-tree-digest';

/** The bounds of the in-place digest walk (#2323 S5 review M4). */
export const LOCAL_SOURCE_DIGEST_MAX_ENTRIES = 5000;
const LOCAL_SOURCE_DIGEST_MAX_BYTES = 64 * 1024 * 1024;

/**
 * Counts a folder's entries and file bytes WITHOUT reading file contents or
 * following links, stopping at the first bound crossed. Mirrors the digest's
 * own walk (root `.git` excluded), so a tree inside the bounds is one the
 * digest will read in full. Returns `null` when the tree could not be read.
 */
function withinDigestBounds(root: string): boolean | null {
  let entries = 0;
  let bytes = 0;
  const walk = (dir: string, top: boolean): boolean => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (top && entry.name === '.git') continue;
      entries += 1;
      if (entries > LOCAL_SOURCE_DIGEST_MAX_ENTRIES) return false;
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!walk(path, false)) return false;
      } else if (entry.isFile()) {
        bytes += lstatSync(path).size;
        if (bytes > LOCAL_SOURCE_DIGEST_MAX_BYTES) return false;
      }
    }
    return true;
  };
  try {
    return walk(root, true);
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
  const bounded = withinDigestBounds(path);
  if (bounded === null) return { unavailable: 'unreadable' };
  if (!bounded) return { unavailable: 'too-large' };
  const digest = (await observePluginTreeAsync(path))?.digest;
  return digest ? { digest } : { unavailable: 'unreadable' };
}
