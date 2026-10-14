import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openSqliteKernelStorage, type SqliteKernelTables } from '../sqlite.js';
import type {
  KernelStorageHarness,
  KernelStorageLocation,
} from './crash-point-store.js';

/** A temporary database file for tests, removed with its directory. */
export interface SqliteKernelLocation extends KernelStorageLocation {
  readonly path: string;
}

export interface SqliteKernelHarnessOptions {
  readonly via?: 'execute' | 'executeSync';
  /** Bind a host's tables in place of the kernel's. */
  readonly tables?: SqliteKernelTables;
  /**
   * Creates the host's tables, in a connection of its own, before the first
   * open. Needed when `tables` binds any.
   */
  readonly prepare?: (database: DatabaseSync) => void;
}

export function createSqliteKernelLocation(
  options: SqliteKernelHarnessOptions = {},
): SqliteKernelLocation {
  const directory = mkdtempSync(join(tmpdir(), 'monument-sqlite-'));
  const path = join(directory, 'kernel.sqlite');
  if (options.prepare) {
    const database = new DatabaseSync(path);
    try {
      options.prepare(database);
    } finally {
      database.close();
    }
  }
  return {
    path,
    async open(openOptions = {}) {
      const storage = openSqliteKernelStorage({
        path,
        ...(options.tables ? { tables: options.tables } : {}),
        ...(openOptions.participants
          ? { participants: openOptions.participants }
          : {}),
      });
      if (options.via !== 'executeSync') return storage;
      return {
        async execute(command, context) {
          return storage.executeSync(command, context);
        },
        close: () => storage.close(),
      };
    },
    async dispose() {
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

/**
 * Conformance harness for this adapter: one temporary database file per
 * location. `via: 'executeSync'` routes every command through
 * {@link SqliteKernelStorage.executeSync}, so the same suite proves the
 * synchronous extension agrees with the async port.
 */
export function createSqliteKernelHarness(
  options: SqliteKernelHarnessOptions & { readonly name?: string } = {},
): KernelStorageHarness {
  return {
    name: options.name ?? `node:sqlite (${options.via ?? 'execute'})`,
    async createLocation() {
      return createSqliteKernelLocation(options);
    },
  };
}
