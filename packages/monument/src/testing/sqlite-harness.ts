import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openSqliteKernelStorage } from '../sqlite.js';
import type {
  KernelStorageHarness,
  KernelStorageLocation,
} from './crash-point-store.js';

/** A temporary database file for tests, removed with its directory. */
export interface SqliteKernelLocation extends KernelStorageLocation {
  readonly path: string;
}

export function createSqliteKernelLocation(
  options: { readonly via?: 'execute' | 'executeSync' } = {},
): SqliteKernelLocation {
  const directory = mkdtempSync(join(tmpdir(), 'monument-sqlite-'));
  const path = join(directory, 'kernel.sqlite');
  return {
    path,
    async open(openOptions = {}) {
      const storage = openSqliteKernelStorage({
        path,
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
  options: { readonly via?: 'execute' | 'executeSync' } = {},
): KernelStorageHarness {
  return {
    name: `node:sqlite (${options.via ?? 'execute'})`,
    async createLocation() {
      return createSqliteKernelLocation(options);
    },
  };
}
