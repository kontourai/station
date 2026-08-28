/**
 * JsonFileStore — typed JSON file persistence.
 * Shared by BuiltinScheduler (jobs/logs) and NotificationService (notifications).
 */

import {
  closeSync,
  copyFileSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fsyncDirectorySync } from '@kontourai/station-shared/fs-windows-compat';

export type JsonStoreCorruptionMode = 'default-value' | 'throw';

/**
 * How much a `durableAtomicWrite` pays for durability.
 *
 * - `crash-safe` (the default, and what every pre-existing caller gets)
 *   fsyncs the temp file, the retained `.previous`, and the containing
 *   directory after each rename, so a completed write survives a power loss
 *   or kernel panic. That is FOUR fsyncs, measured at ~3.6ms each on this
 *   repo's reference host — ~15ms of synchronous, event-loop-blocking work
 *   per write, of which ~14.6ms is the fsyncs.
 * - `tear-safe` keeps the same-directory temp file, the atomic rename, and
 *   the retained `.previous`, and skips only the fsyncs (~0.4ms per write).
 *   A completed write is still never torn and is visible in full to every
 *   other process and across a clean shutdown; what is given up is exactly
 *   the power-loss/kernel-panic window, in which the most recent writes can
 *   be lost.
 *
 * Choose `tear-safe` only where losing the most recent writes to a power cut
 * is acceptable AND a torn file is not — e.g. an append-only observation
 * record whose documented failure direction is already undercounting. Do not
 * choose it for a store whose value is authoritative for a user's data.
 */
export type JsonStoreAtomicWriteDurability = 'crash-safe' | 'tear-safe';

export interface JsonFileStoreOptions {
  /** Existing stores return their configured default value on corruption. */
  onCorruption?: JsonStoreCorruptionMode;
  /** Write via a same-directory temp file and retain one prior complete value. */
  durableAtomicWrite?: boolean;
  /**
   * Durability of a `durableAtomicWrite`. Defaults to `crash-safe`, which is
   * the behavior every caller had before this option existed.
   */
  atomicWriteDurability?: JsonStoreAtomicWriteDurability;
}

export class JsonFileStoreCorruptionError extends Error {
  constructor(filePath: string, cause: unknown) {
    super(`JSON store is corrupt: ${filePath}`, { cause });
    this.name = 'JsonFileStoreCorruptionError';
  }
}

export class JsonFileStore<T> {
  constructor(
    private filePath: string,
    private defaultValue: T,
    private options: JsonFileStoreOptions = {},
  ) {}

  read(): T {
    if (!existsSync(this.filePath)) {
      const previousPath = `${this.filePath}.previous`;
      if (this.options.durableAtomicWrite && existsSync(previousPath)) {
        try {
          console.error(
            'JSON store primary is missing; recovering the prior complete value:',
            this.filePath,
          );
          return JSON.parse(readFileSync(previousPath, 'utf-8'));
        } catch (e) {
          if (this.options.onCorruption === 'throw') {
            throw new JsonFileStoreCorruptionError(previousPath, e);
          }
        }
      }
      return structuredClone(this.defaultValue);
    }
    try {
      return JSON.parse(readFileSync(this.filePath, 'utf-8'));
    } catch (e) {
      if (this.options.onCorruption === 'throw') {
        throw new JsonFileStoreCorruptionError(this.filePath, e);
      }
      console.debug(
        'Failed to read JSON store file, using the configured default value:',
        this.filePath,
        e,
      );
      return structuredClone(this.defaultValue);
    }
  }

  write(data: T): void {
    mkdirSync(dirname(this.filePath), { recursive: true });
    if (!this.options.durableAtomicWrite) {
      writeFileSync(this.filePath, JSON.stringify(data, null, 2));
      return;
    }

    const directory = dirname(this.filePath);
    const previousPath = `${this.filePath}.previous`;
    const tempPath = join(
      directory,
      `.${basename(this.filePath)}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`,
    );
    const backupTempPath = `${previousPath}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`;
    // Only the fsyncs are conditional. The temp file, the atomic renames and
    // the retained `.previous` are what make a write non-tearing, and every
    // durability mode keeps all three.
    // Spelled as "not tear-safe" rather than "is crash-safe" so it fails
    // CLOSED: a third mode added later, or a value arriving from config,
    // keeps its fsyncs instead of silently degrading to none with no compile
    // error (round 2, LOW 4). Durability is the safe default to fall back to.
    const crashSafe = this.options.atomicWriteDurability !== 'tear-safe';
    try {
      writeFileSync(tempPath, JSON.stringify(data, null, 2), { flag: 'wx' });
      if (crashSafe) fsyncFile(tempPath);
      if (existsSync(this.filePath)) {
        // Copy before replacement, rather than renaming the primary away: a
        // failed final rename leaves the current complete value readable.
        copyFileSync(this.filePath, backupTempPath);
        if (crashSafe) fsyncFile(backupTempPath);
        renameSync(backupTempPath, previousPath);
        if (crashSafe) fsyncDirectory(directory);
      }
      renameSync(tempPath, this.filePath);
      if (crashSafe) fsyncDirectory(directory);
    } finally {
      // A failed rename leaves no partially-written primary. The temp file is
      // intentionally best-effort cleanup; the prior version remains recoverable.
      if (existsSync(tempPath)) {
        try {
          unlinkSync(tempPath);
        } catch {
          // Ignore cleanup failure; it is not a Task graph value.
        }
      }
      if (existsSync(backupTempPath)) {
        try {
          unlinkSync(backupTempPath);
        } catch {
          // Keep the old complete primary rather than masking the write error.
        }
      }
    }
  }

  /** For array-typed stores: append an entry, keeping the last `max` entries. */
  append<U>(this: JsonFileStore<U[]>, entry: U, max = 100): void {
    const data = this.read();
    data.push(entry);
    this.write(max > 0 ? data.slice(-max) : data);
  }
}

function fsyncFile(path: string): void {
  // Opened read-WRITE deliberately. POSIX permits fsync on a read-only
  // descriptor, but Windows implements it as FlushFileBuffers, which requires
  // write access and fails with EPERM otherwise — so every durable write threw
  // on Windows and took startup down with it when a migration performed one
  // (archive#1162: runStartupMigrations -> runDefaultAgentPromotionMigration ->
  // withAgentAliasLockAsync, errno -4048).
  const fd = openSync(path, 'r+');
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function fsyncDirectory(path: string): void {
  // Delegates the platform logic to the shared helper, which skips the fsync
  // on win32 proactively rather than provoking an EPERM and catching it —
  // this file previously carried a third, weaker variant of a gotcha that
  // helper exists to centralize (archive#1162 review).
  //
  // The tolerant wrapper stays: directory fsync is not available on every
  // host/filesystem, and the file fsync plus same-directory rename still
  // avoid torn JSON. Delegating without it would newly throw on genuine
  // open failures that this store has always survived. Callers needing a
  // stronger guarantee must use a local filesystem with durable rename.
  try {
    fsyncDirectorySync(path);
  } catch {
    // Durability limitation, not an invitation to fall back to an in-place
    // write.
  }
}
