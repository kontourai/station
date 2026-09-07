/** Private read side of the knowledge file owner. Never creates or repairs files. */
import { createHash } from 'node:crypto';
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  realpathSync,
  type Stats,
} from 'node:fs';
import { dirname, isAbsolute, parse, resolve } from 'node:path';

export class KnowledgeObservationRefusal extends Error {
  constructor(
    readonly state: 'busy' | 'corrupt' | 'unavailable' | 'over-budget',
  ) {
    super(`Knowledge source observation ${state}`);
  }
}

export function observationAbsent(error: unknown): boolean {
  return (error as NodeJS.ErrnoException)?.code === 'ENOENT';
}

function same(left: Stats, right: Stats): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.mode === right.mode &&
    left.nlink === right.nlink &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs &&
    left.ctimeMs === right.ctimeMs
  );
}

/**
 * Checks every existing ancestor, not only the final component. These are
 * observed identity checks, NOT an atomic openat capability or snapshot.
 */
export function observeDirectoryChain(
  directory: string,
  allowMissing = false,
): () => void {
  if (!isAbsolute(directory) || resolve(directory) !== directory) {
    throw new KnowledgeObservationRefusal('unavailable');
  }
  const paths: string[] = [];
  for (let next = directory; ; next = dirname(next)) {
    paths.push(next);
    if (next === parse(next).root) break;
    if (paths.length > 128)
      throw new KnowledgeObservationRefusal('over-budget');
  }
  const snapshots = paths.reverse().map((path) => {
    let info: Stats;
    try {
      info = lstatSync(path);
    } catch (error) {
      if (allowMissing && observationAbsent(error)) return { path, info: null };
      throw error;
    }
    if (!info.isDirectory() || info.isSymbolicLink()) {
      throw new KnowledgeObservationRefusal('unavailable');
    }
    return { path, info };
  });
  if (!allowMissing && realpathSync(directory) !== directory) {
    throw new KnowledgeObservationRefusal('unavailable');
  }
  return () => {
    for (const { path, info } of snapshots) {
      if (info === null) {
        try {
          lstatSync(path);
        } catch (error) {
          if (observationAbsent(error)) continue;
          throw error;
        }
        throw new KnowledgeObservationRefusal('unavailable');
      }
      const current = lstatSync(path);
      // Ancestor mtime can change due to unrelated files. Identity cannot.
      if (
        !current.isDirectory() ||
        current.isSymbolicLink() ||
        current.dev !== info.dev ||
        current.ino !== info.ino
      ) {
        throw new KnowledgeObservationRefusal('unavailable');
      }
    }
    if (!allowMissing && realpathSync(directory) !== directory) {
      throw new KnowledgeObservationRefusal('unavailable');
    }
  };
}

/** Bounds validation/projection work without recursively expanding YAML aliases. */
export function assertObservationTreeBudget(value: unknown): void {
  const pending = [{ value, depth: 0 }];
  const seen = new Set<object>();
  let nodes = 0;
  while (pending.length) {
    const entry = pending.pop()!;
    if (++nodes > 8192 || entry.depth > 32) {
      throw new KnowledgeObservationRefusal('over-budget');
    }
    if (typeof entry.value === 'string' && entry.value.length > 65536) {
      throw new KnowledgeObservationRefusal('over-budget');
    }
    if (entry.value === null || typeof entry.value !== 'object') continue;
    if (seen.has(entry.value)) throw new KnowledgeObservationRefusal('corrupt');
    seen.add(entry.value);
    const keys = Object.keys(entry.value);
    if (nodes + pending.length + keys.length > 8192) {
      throw new KnowledgeObservationRefusal('over-budget');
    }
    for (const key of keys) {
      if (key.length > 1024)
        throw new KnowledgeObservationRefusal('over-budget');
      pending.push({
        value: (entry.value as Record<string, unknown>)[key],
        depth: entry.depth + 1,
      });
    }
  }
}

export function readObservationFile(
  path: string,
  maxBytes: number,
): { text: string; digest: string; recheck: () => void } | null {
  const recheckAncestors = observeDirectoryChain(dirname(path));
  let initial: Stats;
  try {
    initial = lstatSync(path);
  } catch (error) {
    recheckAncestors();
    if (observationAbsent(error)) return null;
    throw error;
  }
  if (!initial.isFile() || initial.isSymbolicLink() || initial.nlink !== 1) {
    throw new KnowledgeObservationRefusal('unavailable');
  }
  if (initial.size > maxBytes)
    throw new KnowledgeObservationRefusal('over-budget');
  const descriptor = openSync(
    path,
    constants.O_RDONLY |
      (constants.O_NOFOLLOW ?? 0) |
      (constants.O_NONBLOCK ?? 0),
  );
  try {
    const opened = fstatSync(descriptor);
    if (!opened.isFile() || !same(initial, opened)) {
      throw new KnowledgeObservationRefusal('unavailable');
    }
    recheckAncestors();
    const buffer = Buffer.alloc(maxBytes + 1);
    let length = 0;
    while (length < buffer.length) {
      const count = readSync(
        descriptor,
        buffer,
        length,
        buffer.length - length,
        null,
      );
      if (count === 0) break;
      length += count;
    }
    if (length > maxBytes) throw new KnowledgeObservationRefusal('over-budget');
    if (!same(initial, fstatSync(descriptor))) {
      throw new KnowledgeObservationRefusal('unavailable');
    }
    const recheck = () => {
      recheckAncestors();
      if (!same(initial, lstatSync(path))) {
        throw new KnowledgeObservationRefusal('unavailable');
      }
    };
    recheck();
    const bytes = buffer.subarray(0, length);
    let text: string;
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch {
      throw new KnowledgeObservationRefusal('corrupt');
    }
    return {
      text,
      digest: createHash('sha256').update(bytes).digest('hex'),
      recheck,
    };
  } finally {
    closeSync(descriptor);
  }
}

/** Only absence is clear. Never read a journal/lock payload or reap an owner. */
export function requireObservationArtifactAbsent(path: string): void {
  try {
    lstatSync(path);
  } catch (error) {
    if (observationAbsent(error)) return;
    throw error;
  }
  throw new KnowledgeObservationRefusal('busy');
}
