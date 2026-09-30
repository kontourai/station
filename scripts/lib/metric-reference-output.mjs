import { randomUUID } from 'node:crypto';
import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { isLearningSourcePath } from './learning-source-reader.mjs';

function identity(left, right) {
  return (
    left.dev === right.dev && left.ino === right.ino && left.mode === right.mode
  );
}

function existing(file) {
  try {
    return lstatSync(file);
  } catch (error) {
    if (error.code === 'ENOENT') return undefined;
    throw error;
  }
}

/**
 * Publish complete bytes within the caller-selected canonical checkout. Refuse
 * repository-controlled symlinks and recheck ancestry/target before rename.
 * This is not a sandbox against arbitrary concurrent same-user path replacement.
 */
export function publishMetricReference(root, coordinate, contents) {
  if (
    !isLearningSourcePath(coordinate) ||
    coordinate.split('/').some((part) => !part || part === '.')
  )
    throw new Error(`Unsafe metric reference output: ${coordinate}`);
  const canonicalRoot = realpathSync(root);
  const directories = [{ file: canonicalRoot, stat: lstatSync(canonicalRoot) }];
  if (!directories[0].stat.isDirectory())
    throw new Error('Metric reference root is not a directory.');
  function checkDirectories() {
    for (const entry of directories) {
      const current = lstatSync(entry.file);
      if (
        !current.isDirectory() ||
        current.isSymbolicLink() ||
        !identity(entry.stat, current)
      )
        throw new Error(
          `Metric reference output ancestry changed: ${coordinate}`,
        );
    }
  }
  const parts = coordinate.split('/');
  for (const part of parts.slice(0, -1)) {
    checkDirectories();
    const file = path.join(directories.at(-1).file, part);
    if (!existing(file)) mkdirSync(file);
    const stat = lstatSync(file);
    if (stat.isSymbolicLink() || !stat.isDirectory())
      throw new Error(
        `Metric reference output ancestor is not a real directory: ${coordinate}`,
      );
    directories.push({ file, stat });
  }
  const output = path.join(directories.at(-1).file, parts.at(-1));
  const before = existing(output);
  if (before && (before.isSymbolicLink() || !before.isFile()))
    throw new Error(
      `Metric reference output must be a regular file, not a symlink: ${coordinate}`,
    );
  const temporary = path.join(
    directories.at(-1).file,
    `.${parts.at(-1)}.${randomUUID()}.tmp`,
  );
  let descriptor;
  let owned;
  try {
    checkDirectories();
    descriptor = openSync(
      temporary,
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        (constants.O_NOFOLLOW ?? 0),
      0o644,
    );
    owned = fstatSync(descriptor);
    writeFileSync(descriptor, contents);
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    checkDirectories();
    if (!identity(owned, lstatSync(temporary)))
      throw new Error('Metric reference temporary file changed.');
    const current = existing(output);
    if (
      before
        ? !current ||
          !identity(before, current) ||
          current.size !== before.size ||
          current.mtimeMs !== before.mtimeMs ||
          current.ctimeMs !== before.ctimeMs
        : current
    )
      throw new Error(
        `Metric reference output changed before publication: ${coordinate}`,
      );
    renameSync(temporary, output);
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
    // Never remove a path that stopped naming this invocation's temporary file.
    if (owned) {
      checkDirectories();
      const remaining = existing(temporary);
      if (remaining && identity(owned, remaining)) unlinkSync(temporary);
    }
  }
}
