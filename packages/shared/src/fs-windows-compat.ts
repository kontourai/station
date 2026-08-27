/**
 * Windows filesystem compatibility helpers.
 *
 * Node's fs APIs assume POSIX durability/permission semantics in a few
 * places that don't hold on Windows. Centralizing the platform checks here
 * means new code reaches for one documented helper instead of rediscovering
 * each gotcha (and its EPERM error message) independently.
 */

import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  openSync,
  type RmOptions,
  rmSync,
  type Stats,
} from 'node:fs';

/**
 * fsync a directory, honoring an optional identity check.
 *
 * Fsyncing a directory after a rename into it is a POSIX durability idiom
 * (it ensures the directory-entry update survives a crash). Windows has no
 * equivalent, and fsyncSync on a directory descriptor there fails with
 * EPERM - so the fsync itself is a no-op on win32. `checkIdentity` (e.g. a
 * dev/ino comparison against a snapshot taken before the caller's atomic
 * rename) still runs on every platform - only the fsync is conditional.
 */
export function fsyncDirectorySync(
  path: string,
  checkIdentity?: (stat: Stats) => void,
): void {
  const descriptor = openSync(
    path,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
  );
  try {
    const stat = fstatSync(descriptor);
    checkIdentity?.(stat);
    if (process.platform !== 'win32') {
      fsyncSync(descriptor);
    }
  } finally {
    closeSync(descriptor);
  }
}

/**
 * Recursively remove a directory, retrying on Windows.
 *
 * Right after a child process exits, Windows can briefly hold a file-handle
 * lock that POSIX would have released immediately (POSIX allows unlinking
 * an open file; Windows does not). `maxRetries`/`retryDelay` is Node's own
 * built-in mitigation for this race - this just applies sane defaults so
 * call sites (typically test cleanup) don't have to remember to add them.
 */
export function rmDirSyncRetrying(path: string, options?: RmOptions): void {
  rmSync(path, {
    recursive: true,
    force: true,
    maxRetries: process.platform === 'win32' ? 10 : 0,
    retryDelay: process.platform === 'win32' ? 200 : 0,
    ...options,
  });
}
