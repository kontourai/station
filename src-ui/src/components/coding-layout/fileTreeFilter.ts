import type { CodingFileEntry } from '@kontourai/station-sdk';

export interface FilteredTree {
  /** Pruned tree containing only matches and their ancestor directories. */
  tree: CodingFileEntry[];
  /** Directory paths that should be force-expanded to reveal the matches. */
  expanded: Set<string>;
}

/**
 * Filter a file tree by a case-insensitive substring query. A directory is
 * kept if it matches by name or contains a descendant that matches; matching
 * directories are recorded in `expanded` so the view can reveal the hits
 * without the user expanding every level. An empty query is a no-op.
 */
export function filterTree(
  tree: CodingFileEntry[],
  query: string,
): FilteredTree {
  const q = query.trim().toLowerCase();
  if (!q) return { tree, expanded: new Set() };

  const expanded = new Set<string>();
  const prune = (entries: CodingFileEntry[]): CodingFileEntry[] => {
    const out: CodingFileEntry[] = [];
    for (const entry of entries) {
      const selfMatch = entry.name.toLowerCase().includes(q);
      if (entry.type === 'directory') {
        const children = prune(entry.children ?? []);
        if (children.length > 0 || selfMatch) {
          out.push({ ...entry, children });
          expanded.add(entry.path);
        }
      } else if (selfMatch) {
        out.push(entry);
      }
    }
    return out;
  };

  return { tree: prune(tree), expanded };
}
