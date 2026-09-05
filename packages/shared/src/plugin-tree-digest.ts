import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, readlinkSync } from 'node:fs';
import { join } from 'node:path';

/** Canonical source-tree observation. Root .git is excluded; symlink target
 * strings are hashed without following them. This does not grant execution
 * authority or prove symlink/materialization containment. */
export function computePluginTreeDigest(root: string): string | null {
  const hash = createHash('sha256');
  const walk = (dir: string, relative: string): void => {
    const entries = readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
      a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
    );
    for (const entry of entries) {
      if (relative === '' && entry.name === '.git') continue;
      const absolute = join(dir, entry.name);
      const entryRelative =
        relative === '' ? entry.name : `${relative}/${entry.name}`;
      if (entry.isSymbolicLink()) {
        hash.update(entryRelative);
        hash.update('\0symlink\0');
        hash.update(readlinkSync(absolute));
        hash.update('\0');
      } else if (entry.isDirectory()) {
        walk(absolute, entryRelative);
      } else if (entry.isFile()) {
        hash.update(entryRelative);
        hash.update('\0file\0');
        hash.update(readFileSync(absolute));
        hash.update('\0');
      } else {
        throw new Error(`Unsupported entry in plugin tree: ${entryRelative}`);
      }
    }
  };
  try {
    walk(root, '');
  } catch {
    return null;
  }
  return `sha256:${hash.digest('hex')}`;
}
