import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  realpathSync,
} from 'node:fs';
import path from 'node:path';

/** Portable repository coordinates, checked before any native filesystem join. */
export function isLearningSourcePath(file) {
  return (
    typeof file === 'string' &&
    file.length > 0 &&
    !/[\\:\0]/.test(file) &&
    !path.posix.isAbsolute(file) &&
    !file.split('/').includes('..')
  );
}

function sameIdentity(left, right) {
  return (
    left.dev === right.dev && left.ino === right.ino && left.mode === right.mode
  );
}

function sameFile(left, right) {
  return (
    sameIdentity(left, right) &&
    left.isFile() &&
    right.isFile() &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs &&
    left.ctimeMs === right.ctimeMs
  );
}

/**
 * Repository-controlled links must never publish bytes outside the checkout.
 * Refuse symlinks below the caller-selected canonical root, including internal
 * ones. Like the workspace-package and station-home readers, read only from an
 * owned no-follow descriptor whose identity matches the inspected regular file.
 * Ancestry is rechecked around the read; this is not a sandbox against an
 * arbitrary same-user process continuously replacing directories or file data.
 */
export function createLearningSourceReader(root) {
  const canonicalRoot = realpathSync(root);
  const rootIdentity = lstatSync(canonicalRoot);
  if (!rootIdentity.isDirectory())
    throw new Error('Learning source root is not a directory');

  function inspect(file) {
    if (!isLearningSourcePath(file))
      throw new Error(`Unsafe learning source path: ${file}`);
    const entries = [{ target: canonicalRoot, stat: lstatSync(canonicalRoot) }];
    if (!sameIdentity(rootIdentity, entries[0].stat))
      throw new Error('Learning source root changed');
    let target = canonicalRoot;
    for (const part of file.split('/').filter((part) => part && part !== '.')) {
      if (!entries.at(-1).stat.isDirectory())
        throw new Error(`Learning source ancestor is not a directory: ${file}`);
      target = path.join(target, part);
      const stat = lstatSync(target);
      if (stat.isSymbolicLink())
        throw new Error(`Learning source symlink is not allowed: ${file}`);
      entries.push({ target, stat });
    }
    return entries;
  }

  function unchanged(file, before) {
    const after = inspect(file);
    if (
      after.length !== before.length ||
      after.some(
        (entry, index) => !sameIdentity(entry.stat, before[index].stat),
      )
    )
      throw new Error(`Learning source ancestry changed: ${file}`);
    return after.at(-1).stat;
  }

  return {
    exists(file) {
      try {
        const stat = inspect(file).at(-1).stat;
        if (!stat.isFile() && !stat.isDirectory())
          throw new Error(
            `Learning source is not a regular file or directory: ${file}`,
          );
        return true;
      } catch (error) {
        if (error.code === 'ENOENT') return false;
        throw error;
      }
    },
    read(file) {
      const entries = inspect(file);
      const before = entries.at(-1);
      if (!before.stat.isFile())
        throw new Error(`Learning source is not a regular file: ${file}`);
      const descriptor = openSync(
        before.target,
        constants.O_RDONLY |
          (constants.O_NOFOLLOW ?? 0) |
          (constants.O_NONBLOCK ?? 0),
      );
      try {
        if (
          !sameFile(before.stat, fstatSync(descriptor)) ||
          !sameFile(before.stat, unchanged(file, entries))
        )
          throw new Error(`Learning source changed before reading: ${file}`);
        const bytes = readFileSync(descriptor);
        if (
          bytes.length !== before.stat.size ||
          !sameFile(before.stat, fstatSync(descriptor)) ||
          !sameFile(before.stat, unchanged(file, entries))
        )
          throw new Error(`Learning source changed while reading: ${file}`);
        return bytes;
      } finally {
        closeSync(descriptor);
      }
    },
  };
}
