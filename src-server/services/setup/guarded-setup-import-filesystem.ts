/**
 * Small, fail-closed filesystem authority for setup import. Node does not
 * expose openat(2), so the boundary walks every absolute component without
 * following links, holds one descriptor for the file bytes, and proves the
 * component/path identities again before returning those bytes.
 */
import { createHash } from 'node:crypto';
import { constants, type Stats } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import { isAbsolute, join, parse, relative } from 'node:path';

export type GuardedDirectoryBinding = {
  dev: number;
  ino: number;
  mtimeMs: number;
};

export type GuardedRead = {
  bytes: Buffer;
  content: string;
  digest: string;
  stat: Stats;
  directories: GuardedDirectoryBinding[];
};

function binding(stat: Stats): GuardedDirectoryBinding {
  return { dev: stat.dev, ino: stat.ino, mtimeMs: stat.mtimeMs };
}

function sameBinding(
  actual: GuardedDirectoryBinding,
  expected: GuardedDirectoryBinding,
  requireMtime: boolean,
): boolean {
  return (
    actual.dev === expected.dev &&
    actual.ino === expected.ino &&
    (!requireMtime || actual.mtimeMs === expected.mtimeMs)
  );
}

/** Walk an absolute path one component at a time and reject link ancestors. */
export async function bindGuardedDirectories(
  absoluteDirectory: string,
): Promise<GuardedDirectoryBinding[]> {
  if (!isAbsolute(absoluteDirectory))
    throw new Error('Guarded path must be absolute.');
  const root = parse(absoluteDirectory).root;
  const parts = relative(root, absoluteDirectory)
    .split(/[\\/]/)
    .filter(Boolean);
  let current = root;
  const bindings: GuardedDirectoryBinding[] = [];
  for (const part of parts) {
    current = join(current, part);
    const stat = await lstat(current);
    if (!stat.isDirectory() || stat.isSymbolicLink())
      throw new Error('Guarded directory is unsafe.');
    bindings.push(binding(stat));
  }
  return bindings;
}

export async function revalidateGuardedDirectories(
  absoluteDirectory: string,
  expected: GuardedDirectoryBinding[],
): Promise<void> {
  const actual = await bindGuardedDirectories(absoluteDirectory);
  if (
    actual.length !== expected.length ||
    actual.some(
      (entry, index) =>
        !sameBinding(entry, expected[index]!, index === actual.length - 1),
    )
  )
    throw new Error('Guarded directory changed.');
}

/** Identity-only revalidation for a directory we intentionally write in. */
export async function revalidateGuardedDirectoryIdentities(
  absoluteDirectory: string,
  expected: GuardedDirectoryBinding[],
): Promise<void> {
  const actual = await bindGuardedDirectories(absoluteDirectory);
  if (
    actual.length !== expected.length ||
    actual.some((entry, index) => !sameBinding(entry, expected[index]!, false))
  )
    throw new Error('Guarded directory changed.');
}

/**
 * Reads exactly one file descriptor, never uses readFile, and allocates no
 * more than maxBytes + 1 bytes. The returned digest and UTF-8 text derive
 * from exactly the same raw bytes.
 */
export async function readGuardedUtf8(
  path: string,
  maxBytes: number,
  options: {
    parentDirectory: string;
    directories?: GuardedDirectoryBinding[];
    /** Receipt stores permit sibling lock/temp files, never directory swaps. */
    allowParentEntryChanges?: boolean;
    /** Narrow instrumentation used only to force descriptor/path races. */
    afterOpenForTest?: () => void | Promise<void>;
  },
): Promise<GuardedRead> {
  if (!isAbsolute(path) || !isAbsolute(options.parentDirectory))
    throw new Error('Guarded path must be absolute.');
  if (!constants.O_NOFOLLOW)
    throw new Error('No-follow descriptors unavailable.');
  const directories =
    options.directories ??
    (await bindGuardedDirectories(options.parentDirectory));
  const revalidate = options.allowParentEntryChanges
    ? revalidateGuardedDirectoryIdentities
    : revalidateGuardedDirectories;
  await revalidate(options.parentDirectory, directories);
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > maxBytes)
      throw new Error('Guarded file is unsafe.');
    await options.afterOpenForTest?.();
    const bytes = Buffer.allocUnsafe(maxBytes + 1);
    let offset = 0;
    while (offset <= maxBytes) {
      const { bytesRead } = await handle.read(
        bytes,
        offset,
        maxBytes + 1 - offset,
        offset,
      );
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    if (offset > maxBytes) throw new Error('Guarded file exceeds byte limit.');
    const finalStat = await handle.stat();
    if (
      !finalStat.isFile() ||
      finalStat.nlink !== 1 ||
      finalStat.dev !== stat.dev ||
      finalStat.ino !== stat.ino ||
      finalStat.size !== stat.size ||
      finalStat.mtimeMs !== stat.mtimeMs ||
      offset !== stat.size
    )
      throw new Error('Guarded file changed during read.');
    const finalPath = await lstat(path);
    if (
      finalPath.isSymbolicLink() ||
      !finalPath.isFile() ||
      finalPath.nlink !== 1 ||
      finalPath.dev !== stat.dev ||
      finalPath.ino !== stat.ino ||
      finalPath.size !== stat.size ||
      finalPath.mtimeMs !== stat.mtimeMs
    )
      throw new Error('Guarded file changed after read.');
    await revalidate(options.parentDirectory, directories);
    const raw = bytes.subarray(0, offset);
    return {
      bytes: raw,
      content: new TextDecoder('utf-8', { fatal: true }).decode(raw),
      digest: createHash('sha256').update(raw).digest('hex'),
      stat,
      directories,
    };
  } finally {
    await handle.close();
  }
}
