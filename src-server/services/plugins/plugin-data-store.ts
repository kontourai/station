/**
 * SQLite-backed authority for bounded plugin-private data.
 *
 * The caller supplies a host-derived installation identity, never a path. All
 * writes use compare-and-swap revisions so two Station processes cannot
 * silently overwrite each other.
 */

import { existsSync, lstatSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { isCanonicalPluginId } from '@kontourai/station-contracts/plugin';
import type {
  PluginDataDeleteOutcome,
  PluginDataJson,
  PluginDataListOutcome,
  PluginDataOwner,
  PluginDataReadOutcome,
  PluginDataRecord,
  PluginDataWriteOutcome,
} from '@kontourai/station-contracts/plugin-data';
import { PLUGIN_DATA_LIMITS } from '@kontourai/station-contracts/plugin-data';
import { explicitCorruption } from '@kontourai/station-shared/sqlite-integrity';
import { applyWalJournalMode } from '../../utils/sqlite-wal.js';

const require = createRequire(import.meta.url);
const SQLITE_BUSY_TIMEOUT_MS = 5_000;
const INSTALLATION_KEY = /^[A-Za-z0-9][A-Za-z0-9:._-]{0,255}$/;
const DATA_KEY = /^[A-Za-z0-9][A-Za-z0-9:._-]{0,127}$/;
const JSON_DEPTH_LIMIT = 32;
const JSON_NODE_LIMIT = 10_000;

const { DatabaseSync } = require('node:sqlite') as {
  DatabaseSync: new (
    path: string,
    options?: { timeout?: number },
  ) => {
    exec(sql: string): void;
    prepare(sql: string): {
      run: (...args: unknown[]) => unknown;
      get: (...args: unknown[]) => unknown;
      all: (...args: unknown[]) => unknown[];
    };
    close(): void;
  };
};

interface StoredRow {
  key: string;
  value_json: string;
  byte_length: number;
  revision: number;
  updated_at: string;
}

class PluginDataCorruptError extends Error {}

function validateOwner(owner: PluginDataOwner): string | null {
  if (!isCanonicalPluginId(owner.pluginId)) {
    return 'pluginId must be a canonical plugin identifier';
  }
  if (!INSTALLATION_KEY.test(owner.installationKey)) {
    return 'installationKey must be a bounded host-issued identifier';
  }
  return null;
}

function validateKey(key: string): string | null {
  return DATA_KEY.test(key)
    ? null
    : 'key must be a bounded identifier containing letters, numbers, dot, colon, underscore, or dash';
}

function validateJson(value: unknown): value is PluginDataJson {
  let nodes = 0;
  const visit = (candidate: unknown, depth: number): boolean => {
    nodes += 1;
    if (nodes > JSON_NODE_LIMIT || depth > JSON_DEPTH_LIMIT) return false;
    if (
      candidate === null ||
      typeof candidate === 'string' ||
      typeof candidate === 'boolean'
    ) {
      return true;
    }
    if (typeof candidate === 'number') return Number.isFinite(candidate);
    if (Array.isArray(candidate)) {
      return candidate.every((entry) => visit(entry, depth + 1));
    }
    if (
      typeof candidate !== 'object' ||
      candidate === null ||
      Object.getPrototypeOf(candidate) !== Object.prototype
    ) {
      return false;
    }
    return Object.values(candidate).every((entry) => visit(entry, depth + 1));
  };
  return visit(value, 0);
}

function parseRow(row: StoredRow): PluginDataRecord {
  try {
    const value = JSON.parse(row.value_json) as unknown;
    if (!validateJson(value)) throw new PluginDataCorruptError();
    return {
      key: row.key,
      value,
      revision: row.revision,
      updatedAt: row.updated_at,
    };
  } catch (error) {
    if (error instanceof PluginDataCorruptError) throw error;
    throw new PluginDataCorruptError('plugin data contains invalid JSON');
  }
}

function unavailable(error: unknown): {
  kind: 'unavailable';
  reason: 'transient' | 'corrupt';
} {
  return {
    kind: 'unavailable',
    reason:
      error instanceof PluginDataCorruptError || explicitCorruption(error)
        ? 'corrupt'
        : 'transient',
  };
}

export interface PluginDataStoreOptions {
  directory: string;
  busyTimeoutMs?: number;
}

export class PluginDataStore {
  private readonly db: InstanceType<typeof DatabaseSync>;

  constructor(options: PluginDataStoreOptions) {
    if (existsSync(options.directory)) {
      const stat = lstatSync(options.directory);
      if (stat.isSymbolicLink() || !stat.isDirectory()) {
        throw new Error('Plugin data directory must be a real directory');
      }
    } else {
      mkdirSync(options.directory, { recursive: true, mode: 0o700 });
    }
    const databasePath = join(options.directory, 'plugin-data.sqlite');
    if (existsSync(databasePath) && lstatSync(databasePath).isSymbolicLink()) {
      throw new Error('Plugin data database must not be a symbolic link');
    }
    const timeout = Math.max(
      0,
      Math.floor(options.busyTimeoutMs ?? SQLITE_BUSY_TIMEOUT_MS),
    );
    this.db = new DatabaseSync(databasePath, { timeout });
    try {
      this.db.exec(`PRAGMA busy_timeout = ${timeout}`);
      applyWalJournalMode(this.db, {
        store: 'plugin data',
        onUnavailable: 'throw',
      });
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS plugin_data (
          plugin_id TEXT NOT NULL,
          installation_key TEXT NOT NULL,
          key TEXT NOT NULL,
          value_json TEXT NOT NULL,
          byte_length INTEGER NOT NULL,
          revision INTEGER NOT NULL,
          updated_at TEXT NOT NULL,
          PRIMARY KEY (plugin_id, installation_key, key)
        ) WITHOUT ROWID;
      `);
    } catch (error) {
      this.db.close();
      throw error;
    }
  }

  close(): void {
    this.db.close();
  }

  get(owner: PluginDataOwner, key: string): PluginDataReadOutcome {
    const invalid = validateOwner(owner) ?? validateKey(key);
    if (invalid) return { kind: 'invalid', reason: invalid };
    try {
      const row = this.db
        .prepare(
          `SELECT key, value_json, byte_length, revision, updated_at
           FROM plugin_data
           WHERE plugin_id = ? AND installation_key = ? AND key = ?`,
        )
        .get(owner.pluginId, owner.installationKey, key) as
        | StoredRow
        | undefined;
      return row
        ? { kind: 'found', record: parseRow(row) }
        : { kind: 'not-found' };
    } catch (error) {
      return unavailable(error);
    }
  }

  list(owner: PluginDataOwner): PluginDataListOutcome {
    const invalid = validateOwner(owner);
    if (invalid) return { kind: 'invalid', reason: invalid };
    try {
      const rows = this.db
        .prepare(
          `SELECT key, value_json, byte_length, revision, updated_at
           FROM plugin_data
           WHERE plugin_id = ? AND installation_key = ?
           ORDER BY key`,
        )
        .all(owner.pluginId, owner.installationKey) as StoredRow[];
      return { kind: 'available', records: rows.map(parseRow) };
    } catch (error) {
      return unavailable(error);
    }
  }

  set(
    owner: PluginDataOwner,
    key: string,
    value: PluginDataJson,
    expectedRevision: number | null,
  ): PluginDataWriteOutcome {
    const invalid = validateOwner(owner) ?? validateKey(key);
    if (invalid) return { kind: 'invalid', reason: invalid };
    if (
      expectedRevision !== null &&
      (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1)
    ) {
      return {
        kind: 'invalid',
        reason: 'expectedRevision must be null or a positive integer',
      };
    }
    if (!validateJson(value)) {
      return { kind: 'invalid', reason: 'value must be bounded JSON data' };
    }
    const valueJson = JSON.stringify(value);
    const byteLength = Buffer.byteLength(valueJson);
    if (byteLength > PLUGIN_DATA_LIMITS.valueBytes) {
      return { kind: 'capacity', reason: 'value-bytes' };
    }

    try {
      return this.transaction(() => {
        const current = this.db
          .prepare(
            `SELECT revision, byte_length
             FROM plugin_data
             WHERE plugin_id = ? AND installation_key = ? AND key = ?`,
          )
          .get(owner.pluginId, owner.installationKey, key) as
          | { revision: number; byte_length: number }
          | undefined;
        const currentRevision = current?.revision ?? null;
        if (currentRevision !== expectedRevision) {
          return { kind: 'conflict', currentRevision };
        }
        const totals = this.db
          .prepare(
            `SELECT COUNT(*) AS key_count, COALESCE(SUM(byte_length), 0) AS total_bytes
             FROM plugin_data
             WHERE plugin_id = ? AND installation_key = ?`,
          )
          .get(owner.pluginId, owner.installationKey) as {
          key_count: number;
          total_bytes: number;
        };
        if (
          !current &&
          totals.key_count >= PLUGIN_DATA_LIMITS.keysPerInstallation
        ) {
          return { kind: 'capacity', reason: 'keys' };
        }
        const nextTotal =
          totals.total_bytes - (current?.byte_length ?? 0) + byteLength;
        if (nextTotal > PLUGIN_DATA_LIMITS.totalBytesPerInstallation) {
          return { kind: 'capacity', reason: 'total-bytes' };
        }
        const revision = (current?.revision ?? 0) + 1;
        const updatedAt = new Date().toISOString();
        this.db
          .prepare(
            `INSERT INTO plugin_data
               (plugin_id, installation_key, key, value_json, byte_length, revision, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(plugin_id, installation_key, key) DO UPDATE SET
               value_json = excluded.value_json,
               byte_length = excluded.byte_length,
               revision = excluded.revision,
               updated_at = excluded.updated_at`,
          )
          .run(
            owner.pluginId,
            owner.installationKey,
            key,
            valueJson,
            byteLength,
            revision,
            updatedAt,
          );
        return {
          kind: 'written',
          record: { key, value, revision, updatedAt },
        };
      });
    } catch (error) {
      return unavailable(error);
    }
  }

  delete(
    owner: PluginDataOwner,
    key: string,
    expectedRevision: number,
  ): PluginDataDeleteOutcome {
    const invalid = validateOwner(owner) ?? validateKey(key);
    if (invalid) return { kind: 'invalid', reason: invalid };
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1) {
      return {
        kind: 'invalid',
        reason: 'expectedRevision must be a positive integer',
      };
    }
    try {
      return this.transaction(() => {
        const current = this.db
          .prepare(
            `SELECT revision FROM plugin_data
             WHERE plugin_id = ? AND installation_key = ? AND key = ?`,
          )
          .get(owner.pluginId, owner.installationKey, key) as
          | { revision: number }
          | undefined;
        if (!current) return { kind: 'not-found' };
        if (current.revision !== expectedRevision) {
          return { kind: 'conflict', currentRevision: current.revision };
        }
        this.db
          .prepare(
            `DELETE FROM plugin_data
             WHERE plugin_id = ? AND installation_key = ? AND key = ?`,
          )
          .run(owner.pluginId, owner.installationKey, key);
        return { kind: 'deleted' };
      });
    } catch (error) {
      return unavailable(error);
    }
  }

  private transaction<T>(work: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const value = work();
      this.db.exec('COMMIT');
      return value;
    } catch (error) {
      try {
        this.db.exec('ROLLBACK');
      } catch {
        // The original failure remains authoritative.
      }
      throw error;
    }
  }
}
