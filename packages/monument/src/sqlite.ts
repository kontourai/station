import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { KernelCommand, KernelResult } from './commands.js';
import { ownerFields, parseOwnerIdentity } from './owner.js';
import {
  type CommitParticipant,
  type KernelContext,
  type KernelStorage,
  KernelStorageClosedError,
  type KernelTransaction,
} from './port.js';
import type {
  RequestKeyRecord,
  TurnBoundaryPurpose,
  TurnBoundaryRecord,
  TurnBoundaryState,
  TurnClaimInvocation,
  TurnDedupRecord,
} from './records.js';
import { runKernelTransactionStep } from './step.js';
import type {
  KernelStorageHarness,
  KernelStorageLocation,
} from './testing/crash-point-store.js';

/**
 * The structural slice of a `node:sqlite` `DatabaseSync` this adapter uses,
 * so a host can hand over the connection it already owns.
 */
export interface SqliteKernelDatabase {
  exec(sql: string): void;
  prepare(sql: string): {
    run(...values: Array<string | number | null>): {
      changes: number | bigint;
    };
    get(...values: Array<string | number | null>): unknown;
    all(...values: Array<string | number | null>): unknown[];
  };
  readonly isTransaction?: boolean;
  close?(): void;
}

export interface SqliteKernelStorageOptions {
  /** Open (and own) a connection to this file. */
  readonly path?: string;
  /** Or use a connection the host owns; `close()` then leaves it open. */
  readonly database?: SqliteKernelDatabase;
  /** Defaults to 5000 ms, as Station's stores use. */
  readonly busyTimeoutMs?: number;
  /** Host projections that join each command's transaction. */
  readonly participants?: readonly CommitParticipant<SqliteKernelDatabase>[];
}

/** What the connection was observed to run with after open. */
export interface SqliteKernelPragmas {
  /**
   * Best-effort, like Station's stores (archive#3661): converting a file to
   * WAL needs a lock no other connection holds, so a contended open may come
   * up in another mode. Reported, not asserted.
   */
  readonly journalMode: string;
  /** Asserted at open. */
  readonly synchronous: 'FULL';
  /** Asserted at open. */
  readonly busyTimeoutMs: number;
}

/**
 * The `node:sqlite` adapter. Besides the portable async port it offers
 * {@link SqliteKernelStorage.executeSync}: the identical transaction, run
 * synchronously, for hosts whose call sites are synchronous. `executeSync` is
 * a node:sqlite-only extension and not part of the portable contract.
 */
export interface SqliteKernelStorage extends KernelStorage {
  readonly pragmas: SqliteKernelPragmas;
  executeSync<C extends KernelCommand>(
    command: C,
    context: KernelContext,
  ): KernelResult<C>;
}

export const SQLITE_KERNEL_SCHEMA_VERSION = 1;
const DEFAULT_BUSY_TIMEOUT_MS = 5000;
const WAL_ATTEMPTS = 5;

export class SqliteKernelConfigurationError extends Error {
  readonly code = 'MONUMENT_SQLITE_CONFIGURATION';
  constructor(message: string) {
    super(message);
    this.name = 'SqliteKernelConfigurationError';
  }
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS monument_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS monument_turn_dedup (
  dedup_key TEXT PRIMARY KEY,
  value TEXT,
  created_at INTEGER NOT NULL,
  owner_json TEXT
);
CREATE TABLE IF NOT EXISTS monument_turn_boundaries (
  boundary_id TEXT PRIMARY KEY,
  thread_id TEXT NOT NULL,
  state TEXT NOT NULL,
  purpose TEXT NOT NULL,
  provider_turn_id TEXT,
  owner_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS monument_turn_boundaries_thread
  ON monument_turn_boundaries (thread_id);
CREATE TABLE IF NOT EXISTS monument_turn_terminals (
  thread_id TEXT NOT NULL,
  provider_turn_id TEXT NOT NULL,
  PRIMARY KEY (thread_id, provider_turn_id)
);
CREATE TABLE IF NOT EXISTS monument_request_keys (
  caller_session_id TEXT NOT NULL,
  tool TEXT NOT NULL,
  request_key TEXT NOT NULL,
  digest TEXT NOT NULL,
  decision TEXT,
  result TEXT,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (caller_session_id, tool, request_key)
);
CREATE INDEX IF NOT EXISTS monument_request_keys_caller
  ON monument_request_keys (caller_session_id, created_at);
`;

function isContention(error: unknown): boolean {
  const record = error as { errcode?: unknown; message?: unknown } | null;
  return (
    (typeof record?.errcode === 'number' && (record.errcode & 0xff) === 5) ||
    (typeof record?.message === 'string' &&
      record.message.includes('database is locked'))
  );
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function pragmaValue(db: SqliteKernelDatabase, name: string): unknown {
  const row = db.prepare(`PRAGMA ${name}`).get() as
    | Record<string, unknown>
    | undefined;
  return row ? Object.values(row)[0] : undefined;
}

function configureConnection(
  db: SqliteKernelDatabase,
  busyTimeoutMs: number,
): SqliteKernelPragmas {
  if (!Number.isInteger(busyTimeoutMs) || busyTimeoutMs < 1)
    throw new RangeError('busyTimeoutMs must be a positive integer.');
  db.exec(`PRAGMA busy_timeout = ${busyTimeoutMs}`);
  const observedTimeout = Number(pragmaValue(db, 'busy_timeout'));
  if (observedTimeout !== busyTimeoutMs)
    throw new SqliteKernelConfigurationError(
      `busy_timeout is ${observedTimeout}, expected ${busyTimeoutMs}.`,
    );
  let backoffMs = 10;
  for (let attempt = 1; attempt <= WAL_ATTEMPTS; attempt += 1) {
    try {
      db.exec('PRAGMA journal_mode = WAL');
      break;
    } catch (error) {
      if (!isContention(error) || attempt === WAL_ATTEMPTS) break;
      sleepSync(backoffMs);
      backoffMs *= 2;
    }
  }
  const journalMode = String(pragmaValue(db, 'journal_mode') ?? 'unknown');
  db.exec('PRAGMA synchronous = FULL');
  // 2 is FULL. The setting is per connection, so it is checked every open.
  const synchronous = Number(pragmaValue(db, 'synchronous'));
  if (synchronous !== 2)
    throw new SqliteKernelConfigurationError(
      `synchronous is ${synchronous}, expected 2 (FULL).`,
    );
  return { journalMode, synchronous: 'FULL', busyTimeoutMs };
}

function inTransaction<T>(db: SqliteKernelDatabase, body: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  let result: T;
  try {
    result = body();
    db.exec('COMMIT');
  } catch (error) {
    try {
      db.exec('ROLLBACK');
    } catch {
      // Nothing left to roll back.
    }
    throw error;
  }
  return result;
}

function migrate(db: SqliteKernelDatabase): void {
  inTransaction(db, () => {
    db.exec(SCHEMA);
    const row = db
      .prepare("SELECT value FROM monument_meta WHERE key = 'schema_version'")
      .get() as { value: string } | undefined;
    if (!row) {
      db.prepare(
        "INSERT INTO monument_meta (key, value) VALUES ('schema_version', ?)",
      ).run(String(SQLITE_KERNEL_SCHEMA_VERSION));
      return;
    }
    if (row.value !== String(SQLITE_KERNEL_SCHEMA_VERSION))
      throw new SqliteKernelConfigurationError(
        `monument schema version ${row.value} is not ${SQLITE_KERNEL_SCHEMA_VERSION}; refusing to open.`,
      );
  });
}

// --- row codecs ------------------------------------------------------------

const BOUNDARY_STATES: ReadonlySet<string> = new Set<TurnBoundaryState>([
  'lifecycle',
  'prepared',
  'invoking',
  'accepted',
  'indeterminate',
]);

function parseInvocation(raw: unknown): TurnClaimInvocation | undefined {
  // Unknown values read as absent, which a dead owner can never reclaim.
  return raw === 'pending' || raw === 'begun' || raw === 'untracked'
    ? raw
    : undefined;
}

function decodeDedup(row: {
  dedup_key: string;
  value: string | null;
  created_at: number;
  owner_json: string | null;
}): TurnDedupRecord {
  if (row.owner_json === null)
    return { key: row.dedup_key, value: row.value, createdAt: row.created_at };
  let parsed: unknown;
  try {
    parsed = JSON.parse(row.owner_json);
  } catch {
    throw new Error('Invalid monument turn dedup owner_json.');
  }
  const invocation = parseInvocation(
    (parsed as { invocation?: unknown } | null)?.invocation,
  );
  return {
    key: row.dedup_key,
    value: row.value,
    createdAt: row.created_at,
    owner: parseOwnerIdentity(parsed),
    ...(invocation ? { invocation } : {}),
  };
}

/**
 * The invocation record lives inside `owner_json`, beside the owner it
 * describes (station#3579): a writer that replaces the owner without it
 * drops it, and the row then reads as unknown, never as a stale `pending`.
 */
function encodeDedupOwner(record: TurnDedupRecord): string | null {
  if (!record.owner) return null;
  return JSON.stringify({
    ...ownerFields(record.owner),
    ...(record.invocation ? { invocation: record.invocation } : {}),
  });
}

function decodeBoundary(row: Record<string, unknown>): TurnBoundaryRecord {
  const state = String(row.state);
  if (!BOUNDARY_STATES.has(state))
    throw new Error(`Invalid monument boundary state: ${state}`);
  const purpose = String(row.purpose);
  if (purpose !== 'turn' && purpose !== 'task-dispatch')
    throw new Error(`Invalid monument boundary purpose: ${purpose}`);
  return {
    boundaryId: String(row.boundary_id),
    threadId: String(row.thread_id),
    state: state as TurnBoundaryState,
    purpose: purpose as TurnBoundaryPurpose,
    ...(typeof row.provider_turn_id === 'string'
      ? { providerTurnId: row.provider_turn_id }
      : {}),
    owner: parseOwnerIdentity(JSON.parse(String(row.owner_json))),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function decodeRequestKey(row: Record<string, unknown>): RequestKeyRecord {
  return {
    id: {
      callerSessionId: String(row.caller_session_id),
      tool: String(row.tool),
      key: String(row.request_key),
    },
    digest: String(row.digest),
    decision: typeof row.decision === 'string' ? row.decision : null,
    result: typeof row.result === 'string' ? row.result : null,
    createdAt: Number(row.created_at),
  };
}

const BOUNDARY_COLUMNS =
  'boundary_id, thread_id, state, purpose, provider_turn_id, owner_json, created_at, updated_at';

function sqliteTransaction(db: SqliteKernelDatabase): KernelTransaction {
  const one = (sql: string, ...values: Array<string | number | null>) =>
    db.prepare(sql).get(...values) as Record<string, unknown> | undefined;
  const all = (sql: string, ...values: Array<string | number | null>) =>
    db.prepare(sql).all(...values) as Array<Record<string, unknown>>;
  const run = (sql: string, ...values: Array<string | number | null>) =>
    Number(db.prepare(sql).run(...values).changes);
  const count = (sql: string, ...values: Array<string | number | null>) =>
    Number((one(sql, ...values) as { total: number }).total);
  return {
    turnDedup: {
      get: (key) => {
        const row = one(
          'SELECT dedup_key, value, created_at, owner_json FROM monument_turn_dedup WHERE dedup_key = ?',
          key,
        );
        return row
          ? decodeDedup(row as Parameters<typeof decodeDedup>[0])
          : undefined;
      },
      put: (record) => {
        run(
          `INSERT INTO monument_turn_dedup (dedup_key, value, created_at, owner_json)
           VALUES (?, ?, ?, ?)
           ON CONFLICT(dedup_key) DO UPDATE SET value = excluded.value,
             created_at = excluded.created_at, owner_json = excluded.owner_json`,
          record.key,
          record.value,
          record.createdAt,
          encodeDedupOwner(record),
        );
      },
      delete: (key) => {
        run('DELETE FROM monument_turn_dedup WHERE dedup_key = ?', key);
      },
      // `substr` and `length` both count characters, so the comparison is an
      // exact prefix match with no wildcard semantics.
      deletePrefix: (prefix) =>
        run(
          'DELETE FROM monument_turn_dedup WHERE substr(dedup_key, 1, length(?)) = ?',
          prefix,
          prefix,
        ),
      pruneResolved: (maxEntries) => {
        run(
          `DELETE FROM monument_turn_dedup
            WHERE dedup_key IN (
              SELECT dedup_key FROM monument_turn_dedup
               WHERE value IS NOT NULL
               ORDER BY created_at ASC, dedup_key ASC
               LIMIT MAX(0, (SELECT count(*) FROM monument_turn_dedup) - ?)
            )`,
          maxEntries,
        );
      },
    },
    turnBoundary: {
      get: (boundaryId) => {
        const row = one(
          `SELECT ${BOUNDARY_COLUMNS} FROM monument_turn_boundaries WHERE boundary_id = ?`,
          boundaryId,
        );
        return row ? decodeBoundary(row) : undefined;
      },
      listThread: (threadId) =>
        all(
          `SELECT ${BOUNDARY_COLUMNS} FROM monument_turn_boundaries WHERE thread_id = ? ORDER BY rowid`,
          threadId,
        ).map(decodeBoundary),
      listAll: () =>
        all(
          `SELECT ${BOUNDARY_COLUMNS} FROM monument_turn_boundaries ORDER BY rowid`,
        ).map(decodeBoundary),
      put: (record) => {
        run(
          `INSERT INTO monument_turn_boundaries (${BOUNDARY_COLUMNS})
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(boundary_id) DO UPDATE SET thread_id = excluded.thread_id,
             state = excluded.state, purpose = excluded.purpose,
             provider_turn_id = excluded.provider_turn_id,
             owner_json = excluded.owner_json, created_at = excluded.created_at,
             updated_at = excluded.updated_at`,
          record.boundaryId,
          record.threadId,
          record.state,
          record.purpose,
          record.providerTurnId ?? null,
          JSON.stringify(ownerFields(record.owner)),
          record.createdAt,
          record.updatedAt,
        );
      },
      delete: (boundaryId) => {
        run(
          'DELETE FROM monument_turn_boundaries WHERE boundary_id = ?',
          boundaryId,
        );
      },
    },
    turnTerminals: {
      has: (threadId, providerTurnId) =>
        one(
          'SELECT 1 AS present FROM monument_turn_terminals WHERE thread_id = ? AND provider_turn_id = ?',
          threadId,
          providerTurnId,
        ) !== undefined,
      add: (threadId, providerTurnId) => {
        run(
          'INSERT OR IGNORE INTO monument_turn_terminals (thread_id, provider_turn_id) VALUES (?, ?)',
          threadId,
          providerTurnId,
        );
      },
      deleteThread: (threadId) => {
        run(
          'DELETE FROM monument_turn_terminals WHERE thread_id = ?',
          threadId,
        );
      },
    },
    requestKeys: {
      get: (id) => {
        const row = one(
          `SELECT caller_session_id, tool, request_key, digest, decision, result, created_at
             FROM monument_request_keys
            WHERE caller_session_id = ? AND tool = ? AND request_key = ?`,
          id.callerSessionId,
          id.tool,
          id.key,
        );
        return row ? decodeRequestKey(row) : undefined;
      },
      // An upsert keeps the row's rowid, which is its insertion order.
      put: (record) => {
        run(
          `INSERT INTO monument_request_keys
             (caller_session_id, tool, request_key, digest, decision, result, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(caller_session_id, tool, request_key) DO UPDATE SET
             digest = excluded.digest, decision = excluded.decision,
             result = excluded.result, created_at = excluded.created_at`,
          record.id.callerSessionId,
          record.id.tool,
          record.id.key,
          record.digest,
          record.decision,
          record.result,
          record.createdAt,
        );
      },
      delete: (id) => {
        run(
          'DELETE FROM monument_request_keys WHERE caller_session_id = ? AND tool = ? AND request_key = ?',
          id.callerSessionId,
          id.tool,
          id.key,
        );
      },
      deleteCreatedBefore: (cutoff) => {
        run('DELETE FROM monument_request_keys WHERE created_at < ?', cutoff);
      },
      countCaller: (caller) =>
        count(
          'SELECT COUNT(*) AS total FROM monument_request_keys WHERE caller_session_id = ?',
          caller,
        ),
      countCallerCompleted: (caller) =>
        count(
          'SELECT COUNT(*) AS total FROM monument_request_keys WHERE caller_session_id = ? AND result IS NOT NULL',
          caller,
        ),
      countAll: () =>
        count('SELECT COUNT(*) AS total FROM monument_request_keys'),
      evictOldestCompleted: (caller, limit) => {
        run(
          `DELETE FROM monument_request_keys WHERE rowid IN (
             SELECT rowid FROM monument_request_keys
              WHERE caller_session_id = ? AND result IS NOT NULL
              ORDER BY created_at ASC, rowid ASC LIMIT ?)`,
          caller,
          limit,
        );
      },
    },
  };
}

export function openSqliteKernelStorage(
  options: SqliteKernelStorageOptions,
): SqliteKernelStorage {
  if ((options.path === undefined) === (options.database === undefined))
    throw new TypeError('Pass exactly one of path or database.');
  const owned = options.database === undefined;
  const db: SqliteKernelDatabase =
    options.database ?? new DatabaseSync(options.path as string);
  const participants = options.participants ?? [];
  let pragmas: SqliteKernelPragmas;
  try {
    pragmas = configureConnection(
      db,
      options.busyTimeoutMs ?? DEFAULT_BUSY_TIMEOUT_MS,
    );
    migrate(db);
  } catch (error) {
    if (owned) db.close?.();
    throw error;
  }
  const tx = sqliteTransaction(db);
  let closed = false;

  const executeSync = <C extends KernelCommand>(
    command: C,
    context: KernelContext,
  ): KernelResult<C> => {
    if (closed) throw new KernelStorageClosedError();
    if (db.isTransaction)
      throw new Error(
        'monument commands cannot run inside a transaction the host already holds.',
      );
    return inTransaction(db, () =>
      runKernelTransactionStep(command, context, tx, participants, db),
    );
  };

  return {
    pragmas,
    executeSync,
    async execute(command, context) {
      return executeSync(command, context);
    },
    async close() {
      if (closed) return;
      closed = true;
      if (owned) db.close?.();
    },
  };
}

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
