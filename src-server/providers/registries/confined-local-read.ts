/**
 * Reads inside a local folder added as a registry source, confined to it.
 *
 * A lexical containment check is not enough: a directory below the source
 * root can be (or become) a symlink, and every later open would follow it out
 * of the source. So each read:
 *
 * 1. walks every path component below the root with `lstat` and refuses a
 *    symlink anywhere on the way;
 * 2. re-checks containment by real path;
 * 3. opens the file with `O_NOFOLLOW` (and `O_NONBLOCK`, so a FIFO cannot
 *    block) and refuses unless the descriptor is the same regular file the
 *    walk saw (device and inode). A component swapped for a symlink between
 *    the walk and the open therefore opens a different file and is refused;
 * 4. refuses a file over the byte bound before buffering it, and again if it
 *    grows while it is read. It never truncates.
 *
 * The source root itself may be a symlink: it is the location the person
 * chose. Confinement starts below it.
 */
import type { Stats } from 'node:fs';
import { constants } from 'node:fs';
import { type FileHandle, lstat, open, realpath } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';

/** A path that leaves the source folder, through a link or a swap. */
export class LocalSourceConfinementError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LocalSourceConfinementError';
  }
}

/** A file over the read bound; it was not read. */
export class LocalSourceFileTooLargeError extends Error {
  constructor(
    readonly path: string,
    readonly maxBytes: number,
  ) {
    super(`Source file ${path} is larger than ${maxBytes} bytes.`);
    this.name = 'LocalSourceFileTooLargeError';
  }
}

const outside = (base: string, target: string) => {
  const inside = relative(base, target);
  return inside.startsWith('..') || isAbsolute(inside);
};

/** Reads at most `maxBytes`; one byte more refuses, so growth is caught too. */
async function readAtMost(
  handle: FileHandle,
  target: string,
  maxBytes: number,
): Promise<Buffer> {
  const buffer = Buffer.alloc(maxBytes + 1);
  let length = 0;
  while (length <= maxBytes) {
    const { bytesRead } = await handle.read(
      buffer,
      length,
      maxBytes + 1 - length,
      length,
    );
    if (bytesRead === 0) break;
    length += bytesRead;
  }
  if (length > maxBytes)
    throw new LocalSourceFileTooLargeError(target, maxBytes);
  return buffer.subarray(0, length);
}

/**
 * The `lstat` of `target` when it is reached from `root` through real
 * directories only and stays inside it by real path. `target` may be `root`.
 */
export async function assertConfinedPath(
  root: string,
  target: string,
): Promise<Stats> {
  const base = resolve(root);
  const resolved = resolve(target);
  if (outside(base, resolved))
    throw new LocalSourceConfinementError('Source path leaves its folder.');
  let current = base;
  let info = await lstat(base);
  const below = relative(base, resolved);
  for (const part of below ? below.split(sep) : []) {
    current = join(current, part);
    info = await lstat(current);
    if (info.isSymbolicLink())
      throw new LocalSourceConfinementError(
        'Source contains a link; Station does not follow links in a source folder.',
      );
  }
  const [realBase, realTarget] = await Promise.all([
    realpath(base),
    realpath(resolved),
  ]);
  if (outside(realBase, realTarget))
    throw new LocalSourceConfinementError('Source path leaves its folder.');
  return info;
}

/** Reads one regular file inside `root`, confined and bounded (see above). */
export async function readConfinedFile(
  root: string,
  target: string,
  maxBytes: number,
): Promise<Buffer> {
  const expected = await assertConfinedPath(root, target);
  if (!expected.isFile())
    throw new LocalSourceConfinementError('Source path is not a regular file.');
  if (expected.size > maxBytes)
    throw new LocalSourceFileTooLargeError(target, maxBytes);
  const handle = await open(
    target,
    constants.O_RDONLY |
      (constants.O_NOFOLLOW ?? 0) |
      (constants.O_NONBLOCK ?? 0),
  );
  try {
    const opened = await handle.stat();
    if (
      !opened.isFile() ||
      opened.dev !== expected.dev ||
      opened.ino !== expected.ino
    )
      throw new LocalSourceConfinementError(
        'Source file changed while it was read.',
      );
    if (opened.size > maxBytes)
      throw new LocalSourceFileTooLargeError(target, maxBytes);
    return await readAtMost(handle, target, maxBytes);
  } finally {
    await handle.close();
  }
}

/**
 * Reads a file of at most `maxBytes` without confinement (a default skill
 * folder a person may have linked on purpose). Bounded the same way.
 */
export async function readBoundedFile(
  target: string,
  maxBytes: number,
): Promise<Buffer> {
  const handle = await open(
    target,
    constants.O_RDONLY | (constants.O_NONBLOCK ?? 0),
  );
  try {
    const opened = await handle.stat();
    if (!opened.isFile())
      throw new LocalSourceConfinementError('Path is not a regular file.');
    if (opened.size > maxBytes)
      throw new LocalSourceFileTooLargeError(target, maxBytes);
    return await readAtMost(handle, target, maxBytes);
  } finally {
    await handle.close();
  }
}
