import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, readlinkSync } from 'node:fs';
import { join } from 'node:path';
import { setImmediate } from 'node:timers/promises';

export const PLUGIN_TREE_DIGEST_FORMAT = 'station-plugin-tree/v2' as const;

/** Versioned, unambiguous source-tree observation. The leading NUL separates
 * this format from legacy delimiter-only streams, whose first byte was a path.
 * Each entry has a kind byte followed by uint64-BE length-prefixed UTF-8 path
 * and raw payload. Directories have empty payloads; symlink targets are bytes,
 * never followed. Siblings sort by filename bytes. Lossy filenames refuse.
 * Root .git remains excluded. This grants no execution/containment authority. */
function treeHasher() {
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
  return { entryFrame, finish: () => `sha256:${hash.digest('hex')}` };
}

function* treeEntries(
  dir: string,
  parent = '',
): Generator<{ kind: 'D' | 'F' | 'L'; path: string; bytes: Buffer }> {
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
      yield {
        kind: 'L',
        path,
        bytes: readlinkSync(absolute, { encoding: 'buffer' }),
      };
    } else if (entry.isDirectory()) {
      yield { kind: 'D', path, bytes: Buffer.alloc(0) };
      yield* treeEntries(absolute, path);
    } else if (entry.isFile()) {
      yield { kind: 'F', path, bytes: readFileSync(absolute) };
    } else {
      throw new Error('Unsupported entry in plugin tree');
    }
  }
}

export function computePluginTreeDigest(root: string): string | null {
  try {
    const hash = treeHasher();
    for (const entry of treeEntries(root))
      hash.entryFrame(entry.kind, entry.path, entry.bytes);
    return hash.finish();
  } catch {
    return null;
  }
}

export interface PluginTreeObservation {
  readonly digest: string;
  readonly manifestText?: string;
}

/** Same full-byte observation, yielding between batches so HTTP work can progress. */
export async function computePluginTreeDigestAsync(
  root: string,
): Promise<string | null> {
  return (await observePluginTreeAsync(root))?.digest ?? null;
}

/** Captures the declaration from the same bytes that contribute to the digest. */
export async function observePluginTreeAsync(
  root: string,
): Promise<PluginTreeObservation | null> {
  try {
    const hash = treeHasher();
    let entries = 0;
    let manifestText: string | undefined;
    for (const entry of treeEntries(root)) {
      hash.entryFrame(entry.kind, entry.path, entry.bytes);
      if (entry.path === 'plugin.json' && entry.kind === 'F')
        manifestText = entry.bytes.toString('utf8');
      if (++entries % 64 === 0) await setImmediate();
    }
    return {
      digest: hash.finish(),
      ...(manifestText === undefined ? {} : { manifestText }),
    };
  } catch {
    return null;
  }
}
