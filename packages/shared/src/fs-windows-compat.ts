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
  renameSync,
  rmSync,
  type Stats,
  statSync,
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
 * fsync a file's data. Windows flushes a file (FlushFileBuffers) only through
 * a handle opened for writing, and a read-only handle fails with EPERM (it
 * failed every supervised update's home backup on Windows, #2675 W3). A file
 * carrying the read-only attribute cannot be opened for writing at all: only
 * that case is left unflushed, and reported through `onUnflushed`, rather
 * than having its attributes changed. Any other refusal still throws.
 * Elsewhere the file is opened read-only and never through a symbolic link.
 */
export function fsyncFileSync(
  path: string,
  platform: NodeJS.Platform = process.platform,
  onUnflushed: (message: string) => void = (message) => console.warn(message),
): void {
  let descriptor: number;
  if (platform === 'win32') {
    try {
      descriptor = openSync(path, constants.O_RDWR);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'EPERM' && code !== 'EACCES') throw error;
      let readOnly = false;
      try {
        readOnly = (statSync(path).mode & 0o200) === 0;
      } catch {
        // Unreadable too: not the read-only case.
      }
      if (!readOnly) throw error;
      onUnflushed(
        `${path} is read-only, so it was not flushed to disk (Windows flushes only through a writable handle)`,
      );
      return;
    }
  } else {
    descriptor = openSync(
      path,
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
    );
  }
  try {
    fsyncSync(descriptor);
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

/**
 * Renames a file or directory, retrying a refusal Windows gives while
 * another process (an antivirus scanner, the search indexer) briefly holds a
 * handle inside it: EPERM, EACCES or EBUSY, up to `attempts` tries `delayMs`
 * apart (10 over about 4.5 s by default), then the first error is thrown.
 * Any other error, and every error off Windows, is thrown at once (#3363).
 */
export function renamePathSyncRetrying(
  source: string,
  destination: string,
  options: {
    platform?: NodeJS.Platform;
    attempts?: number;
    delayMs?: number;
    rename?: (source: string, destination: string) => void;
    wait?: (milliseconds: number) => void;
  } = {},
): void {
  const platform = options.platform ?? process.platform;
  const attempts = options.attempts ?? 10;
  const rename = options.rename ?? renameSync;
  const wait =
    options.wait ??
    ((milliseconds: number) =>
      Atomics.wait(
        new Int32Array(new SharedArrayBuffer(4)),
        0,
        0,
        milliseconds,
      ));
  let first: unknown;
  for (let attempt = 1; ; attempt += 1) {
    try {
      rename(source, destination);
      return;
    } catch (error) {
      const transient =
        platform === 'win32' &&
        ['EPERM', 'EACCES', 'EBUSY'].includes(
          (error as NodeJS.ErrnoException).code ?? '',
        );
      if (!transient) throw first ?? error;
      first ??= error;
      if (attempt >= attempts) throw first;
      wait(options.delayMs ?? 500);
    }
  }
}

/** Preserve atomic replacement when a Windows reader briefly holds the target.
 * Never unlink the destination. Permanent faults still throw, after at most
 * 75ms of waiting; POSIX failures are propagated immediately. */
export function renameFileSyncRetrying(
  source: string,
  destination: string,
  platform: NodeJS.Platform = process.platform,
): void {
  for (let attempt = 0; ; attempt++) {
    try {
      renameSync(source, destination);
      return;
    } catch (error) {
      if (
        platform !== 'win32' ||
        attempt === 4 ||
        !['EPERM', 'EACCES', 'EBUSY'].includes(
          (error as NodeJS.ErrnoException).code ?? '',
        )
      )
        throw error;
      Atomics.wait(
        new Int32Array(new SharedArrayBuffer(4)),
        0,
        0,
        5 * 2 ** attempt,
      );
    }
  }
}
