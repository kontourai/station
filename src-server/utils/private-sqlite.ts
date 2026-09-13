import { closeSync, fsyncSync, lstatSync, mkdirSync, openSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { applyWalJournalMode } from './sqlite-wal.js';

/** Opens operator-owned SQLite state beneath an already admitted Station home. */
export function openPrivateSqlite(path: string, owner: string): DatabaseSync {
  const parent = dirname(path);
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  const directory = lstatSync(parent);
  if (
    !directory.isDirectory() ||
    directory.isSymbolicLink() ||
    (process.platform !== 'win32' &&
      (directory.uid !== process.getuid?.() || (directory.mode & 0o077) !== 0))
  ) {
    throw new Error(`${owner} requires a private operator-owned directory.`);
  }
  let created = false;
  try {
    const fd = openSync(path, 'wx', 0o600);
    try {
      fsyncSync(fd);
      created = true;
    } finally {
      closeSync(fd);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
  if (created && process.platform !== 'win32') {
    const fd = openSync(parent, 'r');
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  }
  for (const candidate of [
    path,
    `${path}-wal`,
    `${path}-shm`,
    `${path}-journal`,
  ]) {
    try {
      const file = lstatSync(candidate);
      if (
        !file.isFile() ||
        file.isSymbolicLink() ||
        file.nlink !== 1 ||
        (process.platform !== 'win32' &&
          (file.uid !== process.getuid?.() || (file.mode & 0o077) !== 0))
      )
        throw new Error(
          `${owner} requires private operator-owned database files.`,
        );
    } catch (error) {
      if (
        candidate !== path &&
        (error as NodeJS.ErrnoException).code === 'ENOENT'
      )
        continue;
      throw error;
    }
  }
  const db = new DatabaseSync(path);
  try {
    db.exec(
      'PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000; PRAGMA synchronous=FULL;',
    );
    applyWalJournalMode(db, { store: owner, onUnavailable: 'throw' });
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}
