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

interface StoredRevisionHead {
  key: string;
  last_revision: number;
}

interface PluginDataNamespaceSnapshot {
  revisionHeads: Map<string, number>;
  rows: StoredRow[];
  records: PluginDataRecord[];
  totalBytes: number;
}

interface StoredPayloadBounds {
  row_count: number;
  declared_bytes: number;
  actual_bytes: number;
  max_value_bytes: number | null;
}

class PluginDataCorruptError extends Error {}

export interface PluginDataCapability {
  get(key: string): PluginDataReadOutcome;
  list(): PluginDataListOutcome;
  set(
    key: string,
    value: PluginDataJson,
    expectedRevision: number | null,
  ): PluginDataWriteOutcome;
  delete(key: string, expectedRevision: number): PluginDataDeleteOutcome;
}

function snapshotOwner(owner: PluginDataOwner): PluginDataOwner {
  let pluginId: unknown;
  let installationKey: unknown;
  try {
    pluginId = owner.pluginId;
    installationKey = owner.installationKey;
  } catch {
    throw new TypeError('Plugin data owner must be a host-issued identity');
  }
  if (!isCanonicalPluginId(pluginId)) {
    throw new TypeError('pluginId must be a canonical plugin identifier');
  }
  if (
    typeof installationKey !== 'string' ||
    !INSTALLATION_KEY.test(installationKey)
  ) {
    throw new TypeError(
      'installationKey must be a bounded host-issued identifier',
    );
  }
  return Object.freeze({ pluginId, installationKey });
}

function validateKey(key: unknown): string | null {
  return typeof key === 'string' && DATA_KEY.test(key)
    ? null
    : 'key must be a bounded identifier containing letters, numbers, dot, colon, underscore, or dash';
}

function validatedJson(
  value: unknown,
): { value: PluginDataJson; json: string } | undefined {
  try {
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
      if (typeof candidate !== 'object' || candidate === null) return false;
      if (
        Object.getPrototypeOf(candidate) !== Object.prototype &&
        !Array.isArray(candidate)
      ) {
        return false;
      }
      if (Object.getOwnPropertySymbols(candidate).length > 0) return false;
      const descriptors = Object.getOwnPropertyDescriptors(candidate);
      if (Array.isArray(candidate)) {
        const keys = Object.keys(descriptors).filter((key) => key !== 'length');
        if (
          keys.length !== candidate.length ||
          keys.some((key, index) => key !== String(index))
        ) {
          return false;
        }
        return keys.every((key) => {
          const descriptor = descriptors[key];
          return (
            descriptor !== undefined &&
            'value' in descriptor &&
            descriptor.enumerable === true &&
            visit(descriptor.value, depth + 1)
          );
        });
      }
      return Object.entries(descriptors).every(([, descriptor]) => {
        return (
          'value' in descriptor &&
          descriptor.enumerable === true &&
          visit(descriptor.value, depth + 1)
        );
      });
    };
    if (!visit(value, 0)) return undefined;
    const json = JSON.stringify(value);
    if (json === undefined) return undefined;
    return { value: JSON.parse(json) as PluginDataJson, json };
  } catch {
    return undefined;
  }
}

function parseRow(row: StoredRow): PluginDataRecord {
  try {
    const value = JSON.parse(row.value_json) as unknown;
    const normalized = validatedJson(value);
    if (
      !DATA_KEY.test(row.key) ||
      !normalized ||
      !Number.isSafeInteger(row.byte_length) ||
      row.byte_length < 0 ||
      row.byte_length > PLUGIN_DATA_LIMITS.valueBytes ||
      Buffer.byteLength(row.value_json) !== row.byte_length ||
      !Number.isSafeInteger(row.revision) ||
      row.revision < 1 ||
      !safeTimestamp(row.updated_at)
    ) {
      throw new PluginDataCorruptError();
    }
    return {
      key: row.key,
      value: normalized.value,
      revision: row.revision,
      updatedAt: row.updated_at,
    };
  } catch (error) {
    if (error instanceof PluginDataCorruptError) throw error;
    throw new PluginDataCorruptError('plugin data contains invalid JSON');
  }
}

function safeTimestamp(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  try {
    return new Date(value).toISOString() === value;
  } catch {
    return false;
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
  /** Test seam for a WAL writer between revision-head and payload reads. */
  afterRevisionHeadsRead?: () => void;
}

export class PluginDataStore {
  private readonly db: InstanceType<typeof DatabaseSync>;
  private readonly afterRevisionHeadsRead?: () => void;

  constructor(options: PluginDataStoreOptions) {
    this.afterRevisionHeadsRead = options.afterRevisionHeadsRead;
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
        CREATE TABLE IF NOT EXISTS plugin_data_revisions (
          plugin_id TEXT NOT NULL,
          installation_key TEXT NOT NULL,
          key TEXT NOT NULL,
          last_revision INTEGER NOT NULL,
          PRIMARY KEY (plugin_id, installation_key, key)
        ) WITHOUT ROWID;
        INSERT OR IGNORE INTO plugin_data_revisions
          (plugin_id, installation_key, key, last_revision)
        SELECT plugin_id, installation_key, key, revision FROM plugin_data;
      `);
    } catch (error) {
      this.db.close();
      throw error;
    }
  }

  close(): void {
    this.db.close();
  }

  bind(owner: PluginDataOwner): PluginDataCapability {
    const boundOwner = snapshotOwner(owner);
    return Object.freeze({
      get: (key: string) => this.get(boundOwner, key),
      list: () => this.list(boundOwner),
      set: (
        key: string,
        value: PluginDataJson,
        expectedRevision: number | null,
      ) => this.set(boundOwner, key, value, expectedRevision),
      delete: (key: string, expectedRevision: number) =>
        this.delete(boundOwner, key, expectedRevision),
    });
  }

  private get(owner: PluginDataOwner, key: string): PluginDataReadOutcome {
    const invalid = validateKey(key);
    if (invalid) return { kind: 'invalid', reason: invalid };
    try {
      return this.readTransaction(() => {
        const bounds = this.db
          .prepare(
            `SELECT byte_length,
                    length(CAST(value_json AS BLOB)) AS actual_byte_length
             FROM plugin_data
             WHERE plugin_id = ? AND installation_key = ? AND key = ?`,
          )
          .get(owner.pluginId, owner.installationKey, key) as
          | { byte_length: number; actual_byte_length: number }
          | undefined;
        if (!bounds) return { kind: 'not-found' };
        if (
          !Number.isSafeInteger(bounds.byte_length) ||
          !Number.isSafeInteger(bounds.actual_byte_length) ||
          bounds.byte_length < 0 ||
          bounds.byte_length !== bounds.actual_byte_length ||
          bounds.actual_byte_length > PLUGIN_DATA_LIMITS.valueBytes
        ) {
          throw new PluginDataCorruptError();
        }
        const row = this.db
          .prepare(
            `SELECT key, value_json, byte_length, revision, updated_at
             FROM plugin_data
             WHERE plugin_id = ? AND installation_key = ? AND key = ?`,
          )
          .get(owner.pluginId, owner.installationKey, key) as
          | StoredRow
          | undefined;
        if (!row) throw new PluginDataCorruptError();
        return { kind: 'found', record: parseRow(row) };
      });
    } catch (error) {
      return unavailable(error);
    }
  }

  private list(owner: PluginDataOwner): PluginDataListOutcome {
    try {
      return this.readTransaction(() => ({
        kind: 'available',
        records: this.readNamespaceSnapshot(owner).records,
      }));
    } catch (error) {
      return unavailable(error);
    }
  }

  private set(
    owner: PluginDataOwner,
    key: string,
    value: PluginDataJson,
    expectedRevision: number | null,
  ): PluginDataWriteOutcome {
    const invalid = validateKey(key);
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
    const normalized = validatedJson(value);
    if (!normalized) {
      return { kind: 'invalid', reason: 'value must be bounded JSON data' };
    }
    const valueJson = normalized.json;
    const byteLength = Buffer.byteLength(valueJson);
    if (byteLength > PLUGIN_DATA_LIMITS.valueBytes) {
      return { kind: 'capacity', reason: 'value-bytes' };
    }

    try {
      return this.transaction(() => {
        const snapshot = this.readNamespaceSnapshot(owner);
        const currentRow = snapshot.rows.find((row) => row.key === key);
        const current = snapshot.records.find((record) => record.key === key);
        const currentRevision = current?.revision ?? null;
        if (currentRevision !== expectedRevision) {
          return { kind: 'conflict', currentRevision };
        }
        const priorRevision = snapshot.revisionHeads.get(key);
        if (
          priorRevision === undefined &&
          snapshot.revisionHeads.size >= PLUGIN_DATA_LIMITS.keysPerInstallation
        ) {
          return { kind: 'capacity', reason: 'keys' };
        }
        if (
          !current &&
          snapshot.records.length >= PLUGIN_DATA_LIMITS.keysPerInstallation
        ) {
          return { kind: 'capacity', reason: 'keys' };
        }
        const nextTotal =
          snapshot.totalBytes - (currentRow?.byte_length ?? 0) + byteLength;
        if (nextTotal > PLUGIN_DATA_LIMITS.totalBytesPerInstallation) {
          return { kind: 'capacity', reason: 'total-bytes' };
        }
        if (
          priorRevision !== undefined &&
          (!Number.isSafeInteger(priorRevision) ||
            priorRevision < 1 ||
            (current !== undefined && priorRevision !== current.revision) ||
            priorRevision >= Number.MAX_SAFE_INTEGER)
        ) {
          throw new PluginDataCorruptError();
        }
        const revision = (priorRevision ?? current?.revision ?? 0) + 1;
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
        this.db
          .prepare(
            `INSERT INTO plugin_data_revisions
               (plugin_id, installation_key, key, last_revision)
             VALUES (?, ?, ?, ?)
             ON CONFLICT(plugin_id, installation_key, key) DO UPDATE SET
               last_revision = excluded.last_revision`,
          )
          .run(owner.pluginId, owner.installationKey, key, revision);
        return {
          kind: 'written',
          record: { key, value: normalized.value, revision, updatedAt },
        };
      });
    } catch (error) {
      return unavailable(error);
    }
  }

  private delete(
    owner: PluginDataOwner,
    key: string,
    expectedRevision: number,
  ): PluginDataDeleteOutcome {
    const invalid = validateKey(key);
    if (invalid) return { kind: 'invalid', reason: invalid };
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1) {
      return {
        kind: 'invalid',
        reason: 'expectedRevision must be a positive integer',
      };
    }
    try {
      return this.transaction(() => {
        const snapshot = this.readNamespaceSnapshot(owner);
        const current = snapshot.records.find((record) => record.key === key);
        if (!current) return { kind: 'not-found' };
        const revisionHead = snapshot.revisionHeads.get(key);
        if (
          revisionHead === undefined ||
          !Number.isSafeInteger(revisionHead) ||
          revisionHead !== current.revision
        ) {
          throw new PluginDataCorruptError();
        }
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

  private readTransaction<T>(work: () => T): T {
    this.db.exec('BEGIN');
    try {
      const value = work();
      this.db.exec('COMMIT');
      return value;
    } catch (error) {
      try {
        this.db.exec('ROLLBACK');
      } catch {
        // The original read failure remains authoritative.
      }
      throw error;
    }
  }

  private readRevisionHeads(owner: PluginDataOwner): Map<string, number> {
    const rows = this.db
      .prepare(
        `SELECT key, last_revision FROM plugin_data_revisions
         WHERE plugin_id = ? AND installation_key = ?
         ORDER BY key
         LIMIT ${PLUGIN_DATA_LIMITS.keysPerInstallation + 1}`,
      )
      .all(owner.pluginId, owner.installationKey) as StoredRevisionHead[];
    if (rows.length > PLUGIN_DATA_LIMITS.keysPerInstallation) {
      throw new PluginDataCorruptError();
    }
    const heads = new Map<string, number>();
    for (const row of rows) {
      if (
        !DATA_KEY.test(row.key) ||
        !Number.isSafeInteger(row.last_revision) ||
        row.last_revision < 1 ||
        heads.has(row.key)
      ) {
        throw new PluginDataCorruptError();
      }
      heads.set(row.key, row.last_revision);
    }
    return heads;
  }

  private readNamespaceSnapshot(
    owner: PluginDataOwner,
  ): PluginDataNamespaceSnapshot {
    const bounds = this.db
      .prepare(
        `SELECT COUNT(*) AS row_count,
                COALESCE(SUM(byte_length), 0) AS declared_bytes,
                COALESCE(SUM(length(CAST(value_json AS BLOB))), 0) AS actual_bytes,
                MAX(length(CAST(value_json AS BLOB))) AS max_value_bytes
         FROM plugin_data
         WHERE plugin_id = ? AND installation_key = ?`,
      )
      .get(owner.pluginId, owner.installationKey) as StoredPayloadBounds;
    if (
      !Number.isSafeInteger(bounds.row_count) ||
      !Number.isSafeInteger(bounds.declared_bytes) ||
      !Number.isSafeInteger(bounds.actual_bytes) ||
      (bounds.max_value_bytes !== null &&
        !Number.isSafeInteger(bounds.max_value_bytes)) ||
      bounds.row_count < 0 ||
      bounds.row_count > PLUGIN_DATA_LIMITS.keysPerInstallation ||
      bounds.declared_bytes < 0 ||
      bounds.declared_bytes !== bounds.actual_bytes ||
      bounds.actual_bytes > PLUGIN_DATA_LIMITS.totalBytesPerInstallation ||
      (bounds.max_value_bytes ?? 0) > PLUGIN_DATA_LIMITS.valueBytes
    ) {
      throw new PluginDataCorruptError();
    }
    const revisionHeads = this.readRevisionHeads(owner);
    this.afterRevisionHeadsRead?.();
    const rows = this.db
      .prepare(
        `SELECT key, value_json, byte_length, revision, updated_at
         FROM plugin_data
         WHERE plugin_id = ? AND installation_key = ?
         ORDER BY key
         LIMIT ${PLUGIN_DATA_LIMITS.keysPerInstallation + 1}`,
      )
      .all(owner.pluginId, owner.installationKey) as StoredRow[];
    const records = rows.map(parseRow);
    const totalBytes = bounds.actual_bytes;
    if (
      records.length > PLUGIN_DATA_LIMITS.keysPerInstallation ||
      totalBytes > PLUGIN_DATA_LIMITS.totalBytesPerInstallation ||
      records.some(
        (record) => revisionHeads.get(record.key) !== record.revision,
      )
    ) {
      throw new PluginDataCorruptError();
    }
    return { revisionHeads, rows, records, totalBytes };
  }
}
