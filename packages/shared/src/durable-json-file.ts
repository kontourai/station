import { randomUUID } from 'node:crypto';
import {
  closeSync,
  constants,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname } from 'node:path';
import { fsyncDirectorySync } from './fs-windows-compat.js';

/**
 * Writes JSON so that a reader after a crash sees either the previous bytes or
 * the new ones, never a torn file.
 *
 * The sequence matters and is easy to get subtly wrong, which is why it lives
 * in one place: create a uniquely-named temporary with O_EXCL (so a hostile or
 * stale file cannot be written through) and O_NOFOLLOW (so a symlink cannot
 * redirect the write), fsync the DATA, rename over the target — atomic within
 * a directory — and then fsync the DIRECTORY, because until the directory
 * entry itself is durable the rename can be lost even though the data was not.
 *
 * `packages/shared` had four hand-rolled variants of this before station#3215;
 * two of them skipped the final directory fsync, which is the step whose
 * absence is invisible until a machine loses power.
 */
export function writeJsonDurably(path: string, value: unknown): void {
  const directory = dirname(path);
  // lstat FIRST, not existsSync: existsSync follows the link, so a DANGLING
  // symlink would fall through to mkdir and fail with a bare ENOENT instead
  // of saying what was actually wrong. lstat succeeds on one.
  //
  // This is advisory, not a security boundary — O_NOFOLLOW on the temporary
  // does not protect the path's directory components against an active racer.
  // What it does is stop the primitive silently accepting a symlinked
  // directory where one caller's own creator deliberately refuses it.
  let existing: ReturnType<typeof lstatSync> | undefined;
  try {
    existing = lstatSync(directory);
  } catch {
    // Absent, which is the ordinary case on first write.
  }
  if (!existing) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
  } else if (existing.isSymbolicLink()) {
    throw new Error(
      `refusing to write through a symlinked directory: ${directory}`,
    );
  }

  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  let descriptor: number | undefined;
  try {
    descriptor = openSync(
      temporary,
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        (constants.O_NOFOLLOW ?? 0),
      0o600,
    );
    writeFileSync(descriptor, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    renameSync(temporary, path);
    fsyncDirectorySync(directory);
  } finally {
    if (descriptor !== undefined) {
      try {
        closeSync(descriptor);
      } catch {
        // The write already failed; a leaked descriptor on this path is not
        // worth masking the original error with a second one.
      }
    }
    // After a successful rename this removes nothing. After a failure it keeps
    // the directory from collecting temporaries named for dead processes.
    rmSync(temporary, { force: true });
  }
}
