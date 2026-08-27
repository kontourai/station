import { createHash, randomUUID } from 'node:crypto';
import {
  closeSync,
  fstatSync,
  openSync,
  readFileSync,
  readSync,
} from 'node:fs';
import {
  mkdir as mkdirAsync,
  open as openAsync,
  rename as renameAsync,
  rm as rmAsync,
} from 'node:fs/promises';
import { dirname } from 'node:path';
import { fsyncDirectorySync } from './fs-windows-compat.js';
import { acquireFileMutationLockAsync } from './lifecycle-events.js';

export function readTextFileBounded(
  path: string,
  maxBytes: number,
  label: string,
): string {
  const descriptor = openSync(path, 'r');
  try {
    const initialSize = fstatSync(descriptor).size;
    if (initialSize > maxBytes) {
      throw new Error(`${label} exceeds the byte limit.`);
    }
    const chunks: Buffer[] = [];
    let total = 0;
    while (total <= maxBytes) {
      const chunk = Buffer.alloc(
        Math.min(64 * 1024, Math.max(1, maxBytes + 1 - total)),
      );
      const count = readSync(descriptor, chunk, 0, chunk.length, null);
      if (count === 0) break;
      total += count;
      chunks.push(chunk.subarray(0, count));
    }
    if (total > maxBytes) {
      throw new Error(`${label} exceeds the byte limit.`);
    }
    return Buffer.concat(chunks, total).toString('utf8');
  } finally {
    closeSync(descriptor);
  }
}

export function readJsonFile<T>(
  path: string,
  fallback: T,
  options?: { maxBytes: number; label: string },
): T {
  try {
    const content = options
      ? readTextFileBounded(path, options.maxBytes, options.label)
      : readFileSync(path, 'utf8');
    return JSON.parse(content) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return fallback;
    throw error;
  }
}

export interface JsonFileSnapshot<T> {
  value: T;
  fingerprint: string | null;
}

export class FileWriteConflictError extends Error {
  constructor(path: string) {
    super(`File changed before the update could commit: ${path}`);
    this.name = 'FileWriteConflictError';
  }
}

function contentFingerprint(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

function readCurrentFingerprint(
  path: string,
  options?: { maxBytes: number; label: string },
): string | null {
  try {
    const content = options
      ? readTextFileBounded(path, options.maxBytes, options.label)
      : readFileSync(path, 'utf8');
    return contentFingerprint(content);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

export function readJsonFileSnapshot<T>(
  path: string,
  fallback: T,
  options?: { maxBytes: number; label: string },
): JsonFileSnapshot<T> {
  try {
    const content = options
      ? readTextFileBounded(path, options.maxBytes, options.label)
      : readFileSync(path, 'utf8');
    return {
      value: JSON.parse(content) as T,
      fingerprint: contentFingerprint(content),
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { value: fallback, fingerprint: null };
    }
    throw error;
  }
}

interface JsonFileWriteOptions {
  expectedFingerprint?: string | null;
  maxBytes?: number;
  label?: string;
  /** Revalidate an owning root/capability immediately before rename commit. */
  beforeCommit?: () => void | Promise<void>;
}

function serializeJsonFile(
  value: unknown,
  options?: Pick<JsonFileWriteOptions, 'maxBytes' | 'label'>,
): string {
  const serialized = JSON.stringify(value, null, 2);
  if (
    options?.maxBytes !== undefined &&
    Buffer.byteLength(serialized) > options.maxBytes
  ) {
    throw new Error(`${options.label ?? 'JSON file'} exceeds the byte limit.`);
  }
  return serialized;
}

/**
 * Atomically publishes JSON while the caller owns the mutation capability
 * that protects `path`. This is the narrow composition seam for transactions
 * whose lock also fences credential or directory mutations and therefore
 * cannot safely reacquire the ordinary `${path}.mutation` lock.
 */
export async function publishJsonFileWithOwnedLock(
  path: string,
  value: unknown,
  options?: Pick<JsonFileWriteOptions, 'maxBytes' | 'label' | 'beforeCommit'>,
): Promise<void> {
  await mkdirAsync(dirname(path), { recursive: true, mode: 0o700 });
  const serialized = serializeJsonFile(value, options);
  const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
  let committed = false;
  let operationError: unknown;
  try {
    // Revalidate before this transaction creates its own directory entry;
    // otherwise a directory mtime binding would reject our temporary file.
    await options?.beforeCommit?.();
    const descriptor = await openAsync(temporaryPath, 'wx', 0o600);
    try {
      await descriptor.writeFile(serialized, 'utf-8');
      await descriptor.sync();
    } finally {
      await descriptor.close();
    }
    await renameAsync(temporaryPath, path);
    committed = true;
    // The rename is the commit point. POSIX directory fsync makes its entry
    // durable across a crash; Windows has no equivalent and the shared helper
    // deliberately no-ops there. A later fsync failure cannot turn already
    // published bytes into a retryable failed write.
    try {
      fsyncDirectorySync(dirname(path));
    } catch {}
  } catch (error) {
    operationError = error;
  }
  try {
    await rmAsync(temporaryPath, { force: true });
  } catch (error) {
    if (!committed && operationError === undefined) operationError = error;
  }
  if (operationError !== undefined) throw operationError;
}

export async function writeJsonFile(
  path: string,
  value: unknown,
  options?: JsonFileWriteOptions,
): Promise<void> {
  await mkdirAsync(dirname(path), { recursive: true, mode: 0o700 });
  const release = await acquireFileMutationLockAsync(`${path}.mutation`);
  try {
    if (
      options &&
      Object.hasOwn(options, 'expectedFingerprint') &&
      readCurrentFingerprint(
        path,
        options.maxBytes !== undefined
          ? {
              maxBytes: options.maxBytes,
              label: options.label ?? 'JSON file',
            }
          : undefined,
      ) !== options.expectedFingerprint
    ) {
      throw new FileWriteConflictError(path);
    }
    await publishJsonFileWithOwnedLock(path, value, options);
  } finally {
    await release();
  }
}

/**
 * Serializes an exact read/derive/publish transaction across Station processes.
 * The updater is synchronous by design: no caller-controlled await can widen
 * the verified read/write window while the capability is held.
 */
export async function mutateJsonFile<T>(
  path: string,
  fallback: T,
  update: (current: T) => T,
  options?: Pick<JsonFileWriteOptions, 'maxBytes' | 'label'>,
): Promise<T> {
  await mkdirAsync(dirname(path), { recursive: true, mode: 0o700 });
  const release = await acquireFileMutationLockAsync(`${path}.mutation`);
  try {
    const current = readJsonFile(
      path,
      fallback,
      options?.maxBytes !== undefined
        ? {
            maxBytes: options.maxBytes,
            label: options.label ?? 'JSON file',
          }
        : undefined,
    );
    const next = update(current);
    await publishJsonFileWithOwnedLock(path, next, options);
    return next;
  } finally {
    await release();
  }
}

/**
 * The guarded-reader variant keeps a descriptor-derived read inside the same
 * mutation lock as its publish. It is intentionally narrow: callers supply
 * the filesystem authority, while this module continues to own locking and
 * atomic publication.
 */
export async function mutateJsonFileWithGuardedRead<T>(
  path: string,
  fallback: T,
  readCurrent: () => Promise<T>,
  update: (current: T) => T,
  options?: Pick<JsonFileWriteOptions, 'maxBytes' | 'label' | 'beforeCommit'>,
): Promise<T> {
  await mkdirAsync(dirname(path), { recursive: true, mode: 0o700 });
  const release = await acquireFileMutationLockAsync(`${path}.mutation`);
  try {
    let current: T;
    try {
      current = await readCurrent();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT')
        current = fallback;
      else throw error;
    }
    const next = update(current);
    await publishJsonFileWithOwnedLock(path, next, options);
    return next;
  } finally {
    await release();
  }
}
