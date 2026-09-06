import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, readlinkSync } from 'node:fs';
import { join } from 'node:path';

export const PLUGIN_TREE_DIGEST_FORMAT = 'station-plugin-tree/v2' as const;

/** Versioned, unambiguous source-tree observation. The leading NUL separates
 * this format from legacy delimiter-only streams, whose first byte was a path.
 * Each entry has a kind byte followed by uint64-BE length-prefixed UTF-8 path
 * and raw payload. Directories have empty payloads; symlink targets are bytes,
 * never followed. Siblings sort by filename bytes. Lossy filenames refuse.
 * Root .git remains excluded. This grants no execution/containment authority. */
export function computePluginTreeDigest(root: string): string | null {
  const hash = createHash('sha256');
  hash.update(Buffer.from(`\0${PLUGIN_TREE_DIGEST_FORMAT}\0`, 'utf8'));
  const field = (bytes: Buffer): void => {
    const length = Buffer.alloc(8);
    length.writeBigUInt64BE(BigInt(bytes.byteLength));
    hash.update(length);
    hash.update(bytes);
  };
  const entryFrame = (kind: 'D' | 'F' | 'L', path: string, bytes: Buffer) => {
    hash.update(kind, 'ascii');
    field(Buffer.from(path, 'utf8'));
    field(bytes);
  };
  const walk = (dir: string, parent: string): void => {
    const entries = readdirSync(dir, {
      withFileTypes: true,
      encoding: 'buffer',
    }).sort((a, b) => Buffer.compare(a.name, b.name));
    for (const entry of entries) {
      const name = entry.name.toString('utf8');
      if (!Buffer.from(name, 'utf8').equals(entry.name))
        throw new Error('Plugin filename is not round-trippable UTF-8');
      if (parent === '' && name === '.git') continue;
      const absolute = join(dir, name);
      const path = parent === '' ? name : `${parent}/${name}`;
      if (entry.isSymbolicLink()) {
        entryFrame('L', path, readlinkSync(absolute, { encoding: 'buffer' }));
      } else if (entry.isDirectory()) {
        entryFrame('D', path, Buffer.alloc(0));
        walk(absolute, path);
      } else if (entry.isFile()) {
        entryFrame('F', path, readFileSync(absolute));
      } else {
        throw new Error('Unsupported entry in plugin tree');
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
