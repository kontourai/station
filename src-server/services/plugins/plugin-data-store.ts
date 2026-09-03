/**
 * SQLite-backed authority for bounded plugin-private data.
 *
 * The caller supplies a host-derived installation identity, never a path. All
 * writes use compare-and-swap revisions so two Station processes cannot
 * silently overwrite each other.
 */

import { existsSync, lstatSync, mkdirSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
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
const UPDATED_AT_MAX_BYTES = 32;
const MAX_SAFE_SQLITE_INTEGER = Number.MAX_SAFE_INTEGER;

type StoredRecordState = 'live' | 'tombstone';

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
  record_state: StoredRecordState;
}

interface RevisionHead {
  revision: number;
  state: StoredRecordState;
}

interface PluginDataNamespaceSnapshot {
  revisionHeads: Map<string, RevisionHead>;
  rows: StoredRow[];
  records: PluginDataRecord[];
  totalBytes: number;
}

interface StoredPayloadBounds {
  row_count: number;
  invalid_declared_bytes: number | null;
  invalid_metadata: number | null;
  max_value_bytes: number | null;
}

interface StoredPayloadTotals {
  declared_bytes: number;
  actual_bytes: number;
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

type ValidatedJson =
  | {
      kind: 'valid';
      value: PluginDataJson;
      json: string;
      byteLength: number;
    }
  | { kind: 'invalid' }
  | { kind: 'capacity' };

function validatedJson(value: unknown): ValidatedJson {
  try {
    let nodes = 0;
    let byteLength = 0;
    let exceededCapacity = false;
    const consume = (bytes: number): boolean => {
      if (byteLength > PLUGIN_DATA_LIMITS.valueBytes - bytes) {
        exceededCapacity = true;
        return false;
      }
      byteLength += bytes;
      return true;
    };
    const consumeString = (candidate: string): boolean => {
      if (!consume(2)) return false;
      for (let index = 0; index < candidate.length; index += 1) {
        const codeUnit = candidate.charCodeAt(index);
        if (codeUnit === 0x22 || codeUnit === 0x5c) {
          if (!consume(2)) return false;
        } else if (codeUnit <= 0x1f) {
          if (
            !consume(
              codeUnit === 0x08 ||
                codeUnit === 0x09 ||
                codeUnit === 0x0a ||
                codeUnit === 0x0c ||
                codeUnit === 0x0d
                ? 2
                : 6,
            )
          ) {
            return false;
          }
        } else if (codeUnit <= 0x7f) {
          if (!consume(1)) return false;
        } else if (codeUnit <= 0x7ff) {
          if (!consume(2)) return false;
        } else if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
          const next = candidate.charCodeAt(index + 1);
          if (next >= 0xdc00 && next <= 0xdfff) {
            if (!consume(4)) return false;
            index += 1;
          } else if (!consume(6)) {
            return false;
          }
        } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
          if (!consume(6)) return false;
        } else if (!consume(3)) {
          return false;
        }
      }
      return true;
    };
    const visit = (
      candidate: unknown,
      depth: number,
    ): PluginDataJson | undefined => {
      nodes += 1;
      if (nodes > JSON_NODE_LIMIT || depth > JSON_DEPTH_LIMIT) return undefined;
      if (candidate === null) {
        return consume(4) ? null : undefined;
      }
      if (typeof candidate === 'string') {
        return consumeString(candidate) ? candidate : undefined;
      }
      if (typeof candidate === 'boolean') {
        return consume(candidate ? 4 : 5) ? candidate : undefined;
      }
      if (typeof candidate === 'number') {
        if (!Number.isFinite(candidate)) return undefined;
        const encoded = JSON.stringify(candidate);
        return consume(encoded.length)
          ? Object.is(candidate, -0)
            ? 0
            : candidate
          : undefined;
      }
      if (typeof candidate !== 'object' || candidate === null) return undefined;
      if (
        Object.getPrototypeOf(candidate) !== Object.prototype &&
        !Array.isArray(candidate)
      ) {
        return undefined;
      }
      if (Object.getOwnPropertySymbols(candidate).length > 0) return undefined;
      if (
        Array.isArray(candidate) &&
        candidate.length > JSON_NODE_LIMIT - nodes
      ) {
        return undefined;
      }
      const descriptors = Object.getOwnPropertyDescriptors(candidate);
      if (Array.isArray(candidate)) {
        const keys = Object.keys(descriptors).filter((key) => key !== 'length');
        if (
          keys.length !== candidate.length ||
          keys.some((key, index) => key !== String(index))
        ) {
          return undefined;
        }
        if (!consume(2 + Math.max(0, keys.length - 1))) return undefined;
        const normalized: PluginDataJson[] = [];
        for (const key of keys) {
          const descriptor = descriptors[key];
          if (
            descriptor === undefined ||
            !('value' in descriptor) ||
            descriptor.enumerable !== true
          ) {
            return undefined;
          }
          const child = visit(descriptor.value, depth + 1);
          if (child === undefined) return undefined;
          normalized.push(child);
        }
        return normalized;
      }
      const entries = Object.entries(descriptors);
      if (!consume(2 + Math.max(0, entries.length - 1))) return undefined;
      const normalized: Record<string, PluginDataJson> = {};
      for (const [key, descriptor] of entries) {
        if (
          !('value' in descriptor) ||
          descriptor.enumerable !== true ||
          !consumeString(key) ||
          !consume(1)
        ) {
          return undefined;
        }
        const child = visit(descriptor.value, depth + 1);
        if (child === undefined) return undefined;
        Object.defineProperty(normalized, key, {
          value: child,
          enumerable: true,
          configurable: true,
          writable: true,
        });
      }
      return normalized;
    };
    const normalized = visit(value, 0);
    if (normalized === undefined) {
      return { kind: exceededCapacity ? 'capacity' : 'invalid' };
    }
    const json = JSON.stringify(normalized);
    if (Buffer.byteLength(json) !== byteLength) return { kind: 'invalid' };
    return { kind: 'valid', value: normalized, json, byteLength };
  } catch {
    return { kind: 'invalid' };
  }
}

function parseRow(row: StoredRow): PluginDataRecord {
  try {
    const value = JSON.parse(row.value_json) as unknown;
    const normalized = validatedJson(value);
    if (
      !DATA_KEY.test(row.key) ||
      normalized.kind !== 'valid' ||
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
  /** Existing, canonical physical root owned by the Station host. */
  trustedRoot: string;
  /** Host-selected data directory at or beneath `trustedRoot`. */
  directory: string;
  busyTimeoutMs?: number;
  /** Test seam for a WAL writer between revision-head and payload reads. */
  afterRevisionHeadsRead?: () => void;
}

function prepareDataDirectory(options: PluginDataStoreOptions): string {
  if (
    typeof options.trustedRoot !== 'string' ||
    typeof options.directory !== 'string'
  ) {
    throw new TypeError('Plugin data paths must be host-issued strings');
  }
  const trustedRoot = resolve(options.trustedRoot);
  if (!existsSync(trustedRoot)) {
    throw new Error('Plugin data trusted root must already exist');
  }
  const rootStat = lstatSync(trustedRoot);
  if (
    rootStat.isSymbolicLink() ||
    !rootStat.isDirectory() ||
    realpathSync(trustedRoot) !== trustedRoot
  ) {
    throw new Error('Plugin data trusted root must be a physical directory');
  }

  const directory = resolve(options.directory);
  const fromRoot = relative(trustedRoot, directory);
  if (
    isAbsolute(fromRoot) ||
    fromRoot === '..' ||
    fromRoot.startsWith(`..${sep}`)
  ) {
    throw new Error(
      'Plugin data directory must remain within its trusted root',
    );
  }

  let current = trustedRoot;
  for (const component of fromRoot.split(sep).filter(Boolean)) {
    current = join(current, component);
    if (existsSync(current)) {
      const stat = lstatSync(current);
      if (stat.isSymbolicLink() || !stat.isDirectory()) {
        throw new Error(
          'Plugin data directory path must contain only real directories',
        );
      }
    } else {
      mkdirSync(current, { mode: 0o700 });
    }
  }
  if (realpathSync(directory) !== directory) {
    throw new Error('Plugin data directory must be a physical directory');
  }
  return directory;
}

export class PluginDataStore {
  private readonly db: InstanceType<typeof DatabaseSync>;
  private readonly afterRevisionHeadsRead?: () => void;

  constructor(options: PluginDataStoreOptions) {
    this.afterRevisionHeadsRead = options.afterRevisionHeadsRead;
    const directory = prepareDataDirectory(options);
    const databasePath = join(directory, 'plugin-data.sqlite');
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
      this.db.exec('BEGIN IMMEDIATE');
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
          record_state TEXT NOT NULL DEFAULT 'live',
          PRIMARY KEY (plugin_id, installation_key, key)
        ) WITHOUT ROWID;
      `);
      const stateColumn = this.db
        .prepare(
          `SELECT COUNT(*) AS count
           FROM pragma_table_info('plugin_data_revisions')
           WHERE name = 'record_state'`,
        )
        .get() as { count: number };
      if (stateColumn.count === 0) {
        // The pre-runtime tracer never had a product caller. Conservatively
        // migrate every old head as live: a legacy head without its payload
        // is then corruption, never an invented tombstone.
        this.db.exec(
          `ALTER TABLE plugin_data_revisions
           ADD COLUMN record_state TEXT NOT NULL DEFAULT 'live'`,
        );
      }
      this.db.exec('COMMIT');
    } catch (error) {
      try {
        this.db.exec('ROLLBACK');
      } catch {
        // The schema/open failure remains authoritative.
      }
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
        const revisionHead = this.db
          .prepare(
            `SELECT
               CASE
                 WHEN typeof(last_revision) = 'integer'
                  AND last_revision >= 1
                  AND last_revision <= ${MAX_SAFE_SQLITE_INTEGER}
                 THEN last_revision
               END AS last_revision,
               CASE
                 WHEN typeof(record_state) = 'text'
                  AND record_state IN ('live', 'tombstone')
                 THEN record_state
               END AS record_state
             FROM plugin_data_revisions
             WHERE plugin_id = ? AND installation_key = ? AND key = ?`,
          )
          .get(owner.pluginId, owner.installationKey, key) as
          | Pick<StoredRevisionHead, 'last_revision' | 'record_state'>
          | undefined;
        if (
          revisionHead !== undefined &&
          (!Number.isSafeInteger(revisionHead.last_revision) ||
            (revisionHead.record_state !== 'live' &&
              revisionHead.record_state !== 'tombstone'))
        ) {
          throw new PluginDataCorruptError();
        }
        const bounds = this.db
          .prepare(
            `SELECT CASE
                      WHEN typeof(data.byte_length) = 'integer'
                       AND data.byte_length >= 0
                       AND data.byte_length <= ${PLUGIN_DATA_LIMITS.valueBytes}
                      THEN data.byte_length
                    END AS byte_length,
                    length(CAST(data.value_json AS BLOB)) AS actual_byte_length,
                    CASE
                      WHEN typeof(data.revision) = 'integer'
                       AND data.revision >= 1
                       AND data.revision <= ${MAX_SAFE_SQLITE_INTEGER}
                      THEN data.revision
                    END AS revision,
                    typeof(data.value_json) AS value_type,
                    CASE
                      WHEN typeof(data.updated_at) = 'text'
                       AND length(CAST(data.updated_at AS BLOB)) <= ${UPDATED_AT_MAX_BYTES}
                      THEN 1 ELSE 0
                    END AS valid_timestamp_bounds
             FROM plugin_data AS data
             WHERE data.plugin_id = ?
               AND data.installation_key = ?
               AND data.key = ?`,
          )
          .get(owner.pluginId, owner.installationKey, key) as
          | {
              byte_length: number;
              actual_byte_length: number;
              revision: number;
              value_type: string;
              valid_timestamp_bounds: number;
            }
          | undefined;
        if (!bounds) {
          if (
            revisionHead === undefined ||
            revisionHead.record_state === 'tombstone'
          ) {
            return { kind: 'not-found' };
          }
          throw new PluginDataCorruptError();
        }
        if (
          !Number.isSafeInteger(bounds.byte_length) ||
          !Number.isSafeInteger(bounds.actual_byte_length) ||
          bounds.byte_length < 0 ||
          bounds.byte_length !== bounds.actual_byte_length ||
          bounds.actual_byte_length > PLUGIN_DATA_LIMITS.valueBytes ||
          !Number.isSafeInteger(bounds.revision) ||
          bounds.revision < 1 ||
          bounds.value_type !== 'text' ||
          bounds.valid_timestamp_bounds !== 1 ||
          revisionHead === undefined ||
          revisionHead.record_state !== 'live' ||
          revisionHead.last_revision !== bounds.revision
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
    if (normalized.kind === 'invalid') {
      return { kind: 'invalid', reason: 'value must be bounded JSON data' };
    }
    if (normalized.kind === 'capacity') {
      return { kind: 'capacity', reason: 'value-bytes' };
    }
    const valueJson = normalized.json;
    const byteLength = normalized.byteLength;

    try {
      return this.transaction(() => {
        const snapshot = this.readNamespaceSnapshot(owner);
        const currentRow = snapshot.rows.find((row) => row.key === key);
        const current = snapshot.records.find((record) => record.key === key);
        const currentRevision = current?.revision ?? null;
        if (currentRevision !== expectedRevision) {
          return { kind: 'conflict', currentRevision };
        }
        const priorHead = snapshot.revisionHeads.get(key);
        const priorRevision = priorHead?.revision;
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
               (plugin_id, installation_key, key, last_revision, record_state)
             VALUES (?, ?, ?, ?, 'live')
             ON CONFLICT(plugin_id, installation_key, key) DO UPDATE SET
               last_revision = excluded.last_revision,
               record_state = excluded.record_state`,
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
          revisionHead.state !== 'live' ||
          !Number.isSafeInteger(revisionHead.revision) ||
          revisionHead.revision !== current.revision
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
        this.db
          .prepare(
            `UPDATE plugin_data_revisions
             SET record_state = 'tombstone'
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

  private readRevisionHeads(owner: PluginDataOwner): Map<string, RevisionHead> {
    const bounds = this.db
      .prepare(
        `SELECT COUNT(*) AS row_count,
                MAX(CASE
                      WHEN typeof(key) = 'text'
                       AND length(CAST(key AS BLOB)) BETWEEN 1 AND 128
                       AND typeof(last_revision) = 'integer'
                       AND last_revision >= 1
                       AND last_revision <= ${MAX_SAFE_SQLITE_INTEGER}
                       AND typeof(record_state) = 'text'
                       AND record_state IN ('live', 'tombstone')
                      THEN 0 ELSE 1
                    END) AS invalid_metadata
         FROM plugin_data_revisions
         WHERE plugin_id = ? AND installation_key = ?`,
      )
      .get(owner.pluginId, owner.installationKey) as {
      row_count: number;
      invalid_metadata: number | null;
    };
    if (
      !Number.isSafeInteger(bounds.row_count) ||
      bounds.row_count < 0 ||
      bounds.row_count > PLUGIN_DATA_LIMITS.keysPerInstallation ||
      (bounds.row_count === 0) !== (bounds.invalid_metadata === null) ||
      (bounds.invalid_metadata !== null && bounds.invalid_metadata !== 0)
    ) {
      throw new PluginDataCorruptError();
    }
    const rows = this.db
      .prepare(
        `SELECT key, last_revision, record_state FROM plugin_data_revisions
         WHERE plugin_id = ? AND installation_key = ?
         ORDER BY key
         LIMIT ${PLUGIN_DATA_LIMITS.keysPerInstallation + 1}`,
      )
      .all(owner.pluginId, owner.installationKey) as StoredRevisionHead[];
    if (rows.length > PLUGIN_DATA_LIMITS.keysPerInstallation) {
      throw new PluginDataCorruptError();
    }
    const heads = new Map<string, RevisionHead>();
    for (const row of rows) {
      if (
        !DATA_KEY.test(row.key) ||
        !Number.isSafeInteger(row.last_revision) ||
        row.last_revision < 1 ||
        (row.record_state !== 'live' && row.record_state !== 'tombstone') ||
        heads.has(row.key)
      ) {
        throw new PluginDataCorruptError();
      }
      heads.set(row.key, {
        revision: row.last_revision,
        state: row.record_state,
      });
    }
    return heads;
  }

  private readNamespaceSnapshot(
    owner: PluginDataOwner,
  ): PluginDataNamespaceSnapshot {
    const bounds = this.db
      .prepare(
        `SELECT COUNT(*) AS row_count,
                MAX(CASE
                      WHEN typeof(byte_length) = 'integer'
                       AND byte_length >= 0
                       AND byte_length <= ${PLUGIN_DATA_LIMITS.valueBytes}
                      THEN 0 ELSE 1
                    END) AS invalid_declared_bytes,
                MAX(CASE
                      WHEN typeof(key) = 'text'
                       AND length(CAST(key AS BLOB)) BETWEEN 1 AND 128
                       AND typeof(value_json) = 'text'
                       AND typeof(revision) = 'integer'
                       AND revision >= 1
                       AND revision <= ${MAX_SAFE_SQLITE_INTEGER}
                       AND typeof(updated_at) = 'text'
                       AND length(CAST(updated_at AS BLOB)) <= ${UPDATED_AT_MAX_BYTES}
                      THEN 0 ELSE 1
                    END) AS invalid_metadata,
                MAX(length(CAST(value_json AS BLOB))) AS max_value_bytes
         FROM plugin_data
         WHERE plugin_id = ? AND installation_key = ?`,
      )
      .get(owner.pluginId, owner.installationKey) as StoredPayloadBounds;
    if (
      !Number.isSafeInteger(bounds.row_count) ||
      (bounds.invalid_declared_bytes !== null &&
        bounds.invalid_declared_bytes !== 0) ||
      (bounds.invalid_metadata !== null && bounds.invalid_metadata !== 0) ||
      (bounds.max_value_bytes !== null &&
        !Number.isSafeInteger(bounds.max_value_bytes)) ||
      bounds.row_count < 0 ||
      bounds.row_count > PLUGIN_DATA_LIMITS.keysPerInstallation ||
      (bounds.row_count === 0) !==
        (bounds.invalid_declared_bytes === null &&
          bounds.invalid_metadata === null &&
          bounds.max_value_bytes === null) ||
      (bounds.max_value_bytes ?? 0) > PLUGIN_DATA_LIMITS.valueBytes
    ) {
      throw new PluginDataCorruptError();
    }
    const totals = this.db
      .prepare(
        `SELECT COALESCE(SUM(byte_length), 0) AS declared_bytes,
                COALESCE(SUM(length(CAST(value_json AS BLOB))), 0) AS actual_bytes
         FROM plugin_data
         WHERE plugin_id = ? AND installation_key = ?`,
      )
      .get(owner.pluginId, owner.installationKey) as StoredPayloadTotals;
    if (
      !Number.isSafeInteger(totals.declared_bytes) ||
      !Number.isSafeInteger(totals.actual_bytes) ||
      totals.declared_bytes < 0 ||
      totals.declared_bytes !== totals.actual_bytes ||
      totals.actual_bytes > PLUGIN_DATA_LIMITS.totalBytesPerInstallation
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
    const recordsByKey = new Map(records.map((record) => [record.key, record]));
    const totalBytes = totals.actual_bytes;
    if (
      records.length > PLUGIN_DATA_LIMITS.keysPerInstallation ||
      totalBytes > PLUGIN_DATA_LIMITS.totalBytesPerInstallation ||
      records.some((record) => {
        const head = revisionHeads.get(record.key);
        return head?.state !== 'live' || head.revision !== record.revision;
      }) ||
      [...revisionHeads].some(([key, head]) =>
        head.state === 'live'
          ? recordsByKey.get(key)?.revision !== head.revision
          : recordsByKey.has(key),
      )
    ) {
      throw new PluginDataCorruptError();
    }
    return { revisionHeads, rows, records, totalBytes };
  }
}
