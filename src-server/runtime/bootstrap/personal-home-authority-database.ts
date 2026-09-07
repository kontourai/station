import {
  closeSync,
  fsyncSync,
  lstatSync,
  openSync,
  realpathSync,
} from 'node:fs';
import {
  basename,
  dirname,
  isAbsolute,
  relative,
  resolve,
  sep,
} from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export const HOME_AUTHORITY_DATABASE_ENV = 'STATION_HOME_AUTHORITY_DATABASE';

/** A single controller owns this database. It must never travel in a home copy. */
export function createPersonalHomeAuthorityDatabase(
  homeDir: string,
  configuredPath: string | undefined,
): (() => DatabaseSync) | undefined {
  if (configuredPath === undefined) return undefined;
  const invalid = () =>
    new Error(
      `${HOME_AUTHORITY_DATABASE_ENV} requires a private external database on POSIX`,
    );
  if (
    process.platform === 'win32' ||
    !isAbsolute(configuredPath) ||
    configuredPath !== configuredPath.trim()
  )
    throw invalid();
  const home = realpathSync(homeDir);
  const parent = realpathSync(dirname(configuredPath));
  const location = relative(home, parent);
  if (
    !location ||
    (!location.startsWith(`..${sep}`) &&
      location !== '..' &&
      !isAbsolute(location))
  )
    throw invalid();
  const databasePath = resolve(parent, basename(configuredPath));
  const parentIdentity = lstatSync(parent);
  const checkParent = () => {
    const info = lstatSync(parent);
    if (
      info.dev !== parentIdentity.dev ||
      info.ino !== parentIdentity.ino ||
      !info.isDirectory() ||
      info.isSymbolicLink() ||
      info.uid !== process.getuid?.() ||
      (info.mode & 0o077) !== 0 ||
      realpathSync(dirname(configuredPath)) !== parent
    )
      throw invalid();
  };
  checkParent();
  return () => {
    checkParent();
    try {
      const fd = openSync(databasePath, 'wx', 0o600);
      try {
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      const directory = openSync(parent, 'r');
      try {
        fsyncSync(directory);
      } finally {
        closeSync(directory);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    const checkFile = (path: string) => {
      const info = lstatSync(path);
      if (
        !info.isFile() ||
        info.isSymbolicLink() ||
        info.nlink !== 1 ||
        info.uid !== process.getuid?.() ||
        (info.mode & 0o077) !== 0
      )
        throw invalid();
      return info;
    };
    const checkSidecars = () => {
      for (const suffix of ['-wal', '-shm', '-journal']) {
        try {
          checkFile(databasePath + suffix);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        }
      }
    };
    const identity = checkFile(databasePath);
    checkSidecars();
    const db = new DatabaseSync(databasePath);
    try {
      checkParent();
      const opened = checkFile(databasePath);
      if (opened.dev !== identity.dev || opened.ino !== identity.ino)
        throw invalid();
      checkSidecars();
      db.exec(
        'PRAGMA busy_timeout=1000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL',
      );
      return db;
    } catch (error) {
      db.close();
      throw error;
    }
  };
}
