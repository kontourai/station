import { DatabaseSync } from 'node:sqlite';
import type { KernelCommand, KernelResult } from './commands.js';
import {
  type OwnerIdentity,
  ownerFields,
  parseOwnerIdentity,
} from './owner.js';
import {
  type CommitParticipant,
  type KernelContext,
  type KernelStorage,
  KernelStorageClosedError,
  type KernelTransaction,
} from './port.js';
import type {
  InboxEntryRecord,
  InboxEntryState,
  RequestKeyRecord,
  TurnBoundaryPurpose,
  TurnBoundaryRecord,
  TurnBoundaryState,
  TurnClaimInvocation,
  TurnDedupRecord,
} from './records.js';
import {
  isParticipantRefusal,
  isReadOnlyKernelCommand,
  runKernelTransactionStep,
} from './step.js';

/**
 * The structural slice of a `node:sqlite` `DatabaseSync` this adapter uses,
 * so a host can hand over the connection it already owns. `run` returns
 * `unknown` so a host's own narrower statement type is accepted as it is; the
 * adapter reads `changes` from the result itself.
 */
export interface SqliteKernelDatabase {
  exec(sql: string): void;
  prepare(sql: string): {
    run(...values: Array<string | number | null>): unknown;
    get(...values: Array<string | number | null>): unknown;
    all(...values: Array<string | number | null>): unknown[];
  };
  readonly isTransaction?: boolean;
  close?(): void;
}

/**
 * A host's existing turn-dedup tables, bound in place of the kernel's own.
 * The host creates them. `table` holds `dedup_key`, `value`, `created_at` and
 * `owner_json`; `tombstoneTable` holds `dedup_key` and `expired_at`.
 */
export interface SqliteTurnDedupTables {
  readonly table: string;
  readonly tombstoneTable: string;
  /**
   * The `owner_json` field that names the owner, which older writers of the
   * host's table call something other than `id`. Written and read under this
   * name, so a writer that predates the kernel still reads the rows.
   */
  readonly ownerIdField: string;
  /** Optional host-owned additive digest column; legacy bindings use owner_json. */
  readonly inputDigestColumn?: string;
  /**
   * Thrown, as is, for any `owner_json` the adapter refuses, in place of the
   * detailed reason. The host's callers may already match on it.
   */
  readonly ownerErrorMessage?: string;
  /**
   * Keys under these prefixes were written by claimants that recorded no
   * invocation: a row of theirs with no invocation record at all reads as
   * `untracked`. A record that is present but unrecognised stays unknown.
   */
  readonly legacyUntrackedKeyPrefixes?: readonly string[];
}

/** A host's existing request-key table: the kernel's columns, one renamed. */
export interface SqliteRequestKeyTable {
  readonly table: string;
  /** The column holding the serialized result (the kernel's is `result`). */
  readonly resultColumn: string;
}

/** A host's boundary rows. Bound tables are checked, never migrated. */
export interface SqliteTurnBoundaryTable {
  readonly table: string;
  readonly ownerEncoding: 'json' | 'columns';
  /** Host event log replaces the kernel's terminal table. Requires terminalSeen. */
  readonly terminalFacts: 'kernel' | 'host';
  /** Fixed at open; invoked synchronously inside the command transaction. */
  readonly terminalSeen?: (
    database: SqliteKernelDatabase,
    threadId: string,
    providerTurnId: string,
  ) => boolean;
  /** Read-only event projection, fixed at open like the other host facts. */
  readonly retiredBoundaryIds?: (
    database: SqliteKernelDatabase,
    threadId: string,
  ) => readonly string[];
  readonly terminalSequence?: (
    database: SqliteKernelDatabase,
    threadId: string,
    terminalEventId: string | undefined,
  ) => number | undefined;
  /** Capture only on insertion, under the writer lock; never backfill old rows. */
  readonly creationSequence?: {
    readonly column: string;
    readonly read: (database: SqliteKernelDatabase) => number;
  };
}

/**
 * Which tables back each machine. An area left out is kernel-owned: its
 * `monument_*` tables are created at open. A bound area uses the host's
 * tables, which must already exist and are checked at open. An `'unused'`
 * area has no table at all, and its commands are refused: a host that keeps
 * only some machines here creates nothing for the others.
 */
export interface SqliteKernelTables {
  readonly turnDedup?: SqliteTurnDedupTables | 'unused';
  readonly requestKeys?: SqliteRequestKeyTable | 'unused';
  readonly turnBoundary?: SqliteTurnBoundaryTable | 'unused';
  readonly inbox?: 'unused';
}

export interface SqliteKernelStorageOptions {
  /** Open (and own) a connection to this file. */
  readonly path?: string;
  /** Or use a connection the host owns; `close()` then leaves it open. */
  readonly database?: SqliteKernelDatabase;
  /** Defaults to 5000 ms, as Station's stores use. */
  readonly busyTimeoutMs?: number;
  /**
   * Whether to set and assert `busy_timeout`, `journal_mode` and
   * `synchronous` on the connection. A connection the adapter opens is always
   * configured. A connection the host hands over is the host's: by default
   * its pragmas are left as they are and reported in `pragmas`, so a host that
   * relaxes durability on purpose (a test fixture) is not silently undone.
   * Pass `true` to hand the pragmas to the adapter.
   */
  readonly configureConnection?: boolean;
  /** Host projections that join each command's transaction. */
  readonly participants?: readonly CommitParticipant<SqliteKernelDatabase>[];
  /** Bind the host's own tables; by default the kernel owns all of them. */
  readonly tables?: SqliteKernelTables;
}

/** What the connection was observed to run with after open. */
export interface SqliteKernelPragmas {
  /**
   * Best-effort, like Station's stores (archive#3661): converting a file to
   * WAL needs a lock no other connection holds, so a contended open may come
   * up in another mode. Reported, not asserted.
   */
  readonly journalMode: string;
  /**
   * `FULL` is asserted on a connection the adapter configures. On one the
   * host kept, this is whatever the host chose.
   */
  readonly synchronous: 'OFF' | 'NORMAL' | 'FULL' | 'EXTRA' | 'unknown';
  /** Asserted on a connection the adapter configures; otherwise observed. */
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
    options?: SqliteExecuteOptions,
  ): KernelResult<C>;
}

export interface SqliteExecuteOptions {
  /**
   * Run inside the transaction the host already holds, instead of refusing.
   * The command is one savepoint in it: its writes, and every participant's,
   * commit or roll back with the host's transaction, so the host can retire
   * the kernel's records in the same transaction as its own. A command that
   * throws or is refused by a participant undoes only itself.
   */
  readonly withinHostTransaction?: boolean;
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

const META_SCHEMA = `
CREATE TABLE IF NOT EXISTS monument_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;
const TURN_DEDUP_SCHEMA = `
CREATE TABLE IF NOT EXISTS monument_turn_dedup (
  dedup_key TEXT PRIMARY KEY,
  value TEXT,
  created_at INTEGER NOT NULL,
  owner_json TEXT,
  input_digest TEXT
);
CREATE TABLE IF NOT EXISTS monument_turn_dedup_expired (
  dedup_key TEXT PRIMARY KEY,
  expired_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS monument_turn_dedup_expired_at
  ON monument_turn_dedup_expired (expired_at);
`;
const TURN_BOUNDARY_SCHEMA = `
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
CREATE UNIQUE INDEX IF NOT EXISTS monument_turn_boundaries_one_invocation
  ON monument_turn_boundaries (thread_id)
  WHERE state IN ('lifecycle', 'prepared', 'invoking', 'indeterminate');
`;
const TURN_TERMINAL_SCHEMA = `
CREATE TABLE IF NOT EXISTS monument_turn_terminals (
  thread_id TEXT NOT NULL,
  provider_turn_id TEXT NOT NULL,
  PRIMARY KEY (thread_id, provider_turn_id)
);
`;
const REQUEST_KEYS_SCHEMA = `
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

const INBOX_SCHEMA = `
CREATE TABLE IF NOT EXISTS monument_inbox_entries (
  inbox_id TEXT NOT NULL,
  entry_key TEXT NOT NULL,
  sequence INTEGER NOT NULL,
  kind TEXT NOT NULL,
  digest TEXT NOT NULL,
  payload TEXT NOT NULL,
  state TEXT NOT NULL,
  placement TEXT,
  outcome TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (inbox_id, entry_key)
);
CREATE UNIQUE INDEX IF NOT EXISTS monument_inbox_entries_order
  ON monument_inbox_entries (inbox_id, sequence);
CREATE INDEX IF NOT EXISTS monument_inbox_entries_state
  ON monument_inbox_entries (state);
`;

/** The tables an area uses: the kernel's own, or the host's bound ones. */
interface ResolvedTables {
  readonly turnDedup:
    | (SqliteTurnDedupTables & { readonly owned: boolean })
    | 'unused';
  readonly requestKeys:
    | (SqliteRequestKeyTable & { readonly owned: boolean })
    | 'unused';
  readonly turnBoundary:
    | (SqliteTurnBoundaryTable & { readonly owned: boolean })
    | 'unused';
  readonly inbox: 'owned' | 'unused';
}

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

function identifier(name: string): string {
  // Names are spliced into SQL, so only plain identifiers are accepted.
  if (!IDENTIFIER.test(name))
    throw new TypeError(`Not a plain SQL identifier: ${name}`);
  return name;
}

/** `owner_json` fields the kernel writes itself; the owner id may not use one. */
const RESERVED_OWNER_FIELDS = new Set([
  'inputDigest',
  'pid',
  'identityKind',
  'birth',
  'invocation',
]);

function resolveTables(tables: SqliteKernelTables = {}): ResolvedTables {
  const dedup = tables.turnDedup;
  const keys = tables.requestKeys;
  if (
    dedup &&
    dedup !== 'unused' &&
    RESERVED_OWNER_FIELDS.has(dedup.ownerIdField)
  )
    throw new TypeError(`ownerIdField cannot be ${dedup.ownerIdField}.`);
  const boundary = tables.turnBoundary;
  if (boundary && boundary !== 'unused') {
    if (
      boundary.terminalFacts === 'host' &&
      typeof boundary.terminalSeen !== 'function'
    )
      throw new SqliteKernelConfigurationError(
        'Host terminal facts require terminalSeen at open.',
      );
    if (
      boundary.terminalFacts === 'kernel' &&
      (boundary.terminalSeen !== undefined ||
        boundary.terminalSequence !== undefined ||
        boundary.retiredBoundaryIds !== undefined)
    )
      throw new SqliteKernelConfigurationError(
        'Kernel terminal facts cannot have host callbacks.',
      );
  }
  if (
    boundary &&
    boundary !== 'unused' &&
    boundary.creationSequence &&
    boundaryColumns(boundary)
      .split(', ')
      .includes(boundary.creationSequence.column)
  )
    throw new TypeError(
      'The creation fence must have its own boundary column.',
    );
  return {
    turnDedup:
      dedup === 'unused'
        ? 'unused'
        : dedup
          ? {
              ...dedup,
              ...(dedup.inputDigestColumn
                ? { inputDigestColumn: identifier(dedup.inputDigestColumn) }
                : {}),
              table: identifier(dedup.table),
              tombstoneTable: identifier(dedup.tombstoneTable),
              owned: false,
            }
          : {
              table: 'monument_turn_dedup',
              tombstoneTable: 'monument_turn_dedup_expired',
              ownerIdField: 'id',
              inputDigestColumn: 'input_digest',
              owned: true,
            },
    requestKeys:
      keys === 'unused'
        ? 'unused'
        : keys
          ? {
              table: identifier(keys.table),
              resultColumn: identifier(keys.resultColumn),
              owned: false,
            }
          : {
              table: 'monument_request_keys',
              resultColumn: 'result',
              owned: true,
            },
    turnBoundary:
      tables.turnBoundary === 'unused'
        ? 'unused'
        : tables.turnBoundary
          ? {
              ...tables.turnBoundary,
              table: identifier(tables.turnBoundary.table),
              ...(tables.turnBoundary.creationSequence
                ? {
                    creationSequence: {
                      ...tables.turnBoundary.creationSequence,
                      column: identifier(
                        tables.turnBoundary.creationSequence.column,
                      ),
                    },
                  }
                : {}),
              owned: false,
            }
          : {
              table: 'monument_turn_boundaries',
              ownerEncoding: 'json',
              terminalFacts: 'kernel',
              owned: true,
            },
    inbox: tables.inbox ?? 'owned',
  };
}

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

/** What a connection the host configured is running with; nothing is changed. */
function observeConnection(db: SqliteKernelDatabase): SqliteKernelPragmas {
  const synchronous = ['OFF', 'NORMAL', 'FULL', 'EXTRA'][
    Number(pragmaValue(db, 'synchronous'))
  ] as SqliteKernelPragmas['synchronous'] | undefined;
  return {
    journalMode: String(pragmaValue(db, 'journal_mode') ?? 'unknown'),
    synchronous: synchronous ?? 'unknown',
    busyTimeoutMs: Number(pragmaValue(db, 'busy_timeout')),
  };
}

function inTransaction<T>(
  db: SqliteKernelDatabase,
  body: () => T,
  mode: 'IMMEDIATE' | 'DEFERRED' = 'IMMEDIATE',
  keep: (result: T) => boolean = () => true,
): T {
  db.exec(`BEGIN ${mode}`);
  let result: T;
  try {
    result = body();
    db.exec(keep(result) ? 'COMMIT' : 'ROLLBACK');
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

/** The columns a bound table must have, checked once when the adapter opens. */
function requireColumns(
  db: SqliteKernelDatabase,
  table: string,
  columns: readonly string[],
): void {
  const present = new Set(
    (
      db.prepare(`PRAGMA table_info(${table})`).all() as Array<{
        name?: string;
      }>
    ).map((row) => row.name),
  );
  const missing = columns.filter((column) => !present.has(column));
  if (missing.length > 0)
    throw new SqliteKernelConfigurationError(
      present.size === 0
        ? `bound table ${table} does not exist.`
        : `bound table ${table} has no column ${missing.join(', ')}.`,
    );
}

/** `inTransaction` for a host that already holds a transaction. */
function inSavepoint<T>(
  db: SqliteKernelDatabase,
  body: () => T,
  keep: (result: T) => boolean,
): T {
  db.exec('SAVEPOINT monument_command');
  try {
    const result = body();
    if (!keep(result)) db.exec('ROLLBACK TO monument_command');
    db.exec('RELEASE monument_command');
    return result;
  } catch (error) {
    try {
      db.exec('ROLLBACK TO monument_command');
      db.exec('RELEASE monument_command');
    } catch {
      // The host's transaction is gone; nothing is left to undo.
    }
    throw error;
  }
}

function migrate(db: SqliteKernelDatabase, tables: ResolvedTables): void {
  inTransaction(db, () => {
    // Bound tables are the host's: checked, never created or altered.
    if (tables.turnDedup !== 'unused' && !tables.turnDedup.owned) {
      requireColumns(db, tables.turnDedup.table, [
        'dedup_key',
        'value',
        'created_at',
        'owner_json',
        ...(tables.turnDedup.inputDigestColumn
          ? [tables.turnDedup.inputDigestColumn]
          : []),
      ]);
      requireColumns(db, tables.turnDedup.tombstoneTable, [
        'dedup_key',
        'expired_at',
      ]);
    }
    if (tables.requestKeys !== 'unused' && !tables.requestKeys.owned)
      requireColumns(db, tables.requestKeys.table, [
        'caller_session_id',
        'tool',
        'request_key',
        'digest',
        'decision',
        'created_at',
        tables.requestKeys.resultColumn,
      ]);
    if (tables.turnBoundary !== 'unused' && !tables.turnBoundary.owned) {
      requireColumns(db, tables.turnBoundary.table, [
        'boundary_id',
        'thread_id',
        'state',
        'purpose',
        'provider_turn_id',
        'created_at',
        'updated_at',
        ...(tables.turnBoundary.ownerEncoding === 'json'
          ? ['owner_json']
          : ['owner_id', 'owner_pid', 'owner_birth', 'owner_identity_kind']),
        ...(tables.turnBoundary.creationSequence
          ? [tables.turnBoundary.creationSequence.column]
          : []),
      ]);
      const indexes = db
        .prepare(`PRAGMA index_list(${tables.turnBoundary.table})`)
        .all() as Array<{ name: string; unique: number; partial: number }>;
      const uniqueIdentity = indexes.some((index) => {
        if (!index.unique || index.partial) return false;
        const columns = db
          .prepare(`PRAGMA index_info('${index.name.replaceAll("'", "''")}')`)
          .all() as Array<{ name: string | null }>;
        return columns.length === 1 && columns[0].name === 'boundary_id';
      });
      const primaryKey = (
        db
          .prepare(`PRAGMA table_info(${tables.turnBoundary.table})`)
          .all() as Array<{ name: string; pk: number }>
      ).filter((column) => column.pk > 0);
      if (
        !uniqueIdentity &&
        !(primaryKey.length === 1 && primaryKey[0].name === 'boundary_id')
      )
        throw new SqliteKernelConfigurationError(
          `bound table ${tables.turnBoundary.table} requires a primary key or non-partial unique index on boundary_id.`,
        );
    }
    const owned = [
      tables.turnDedup !== 'unused' && tables.turnDedup.owned
        ? TURN_DEDUP_SCHEMA
        : '',
      tables.turnBoundary !== 'unused' && tables.turnBoundary.owned
        ? TURN_BOUNDARY_SCHEMA
        : '',
      tables.turnBoundary !== 'unused' &&
      tables.turnBoundary.terminalFacts === 'kernel'
        ? TURN_TERMINAL_SCHEMA
        : '',
      tables.requestKeys !== 'unused' && tables.requestKeys.owned
        ? REQUEST_KEYS_SCHEMA
        : '',
      tables.inbox === 'owned' ? INBOX_SCHEMA : '',
    ].join('');
    // With nothing of its own to version, the kernel leaves no table behind.
    if (!owned) return;
    db.exec(META_SCHEMA);
    db.exec(owned);
    if (
      tables.turnDedup !== 'unused' &&
      tables.turnDedup.owned &&
      !(
        db.prepare('PRAGMA table_info(monument_turn_dedup)').all() as Array<{
          name: string;
        }>
      ).some((c) => c.name === 'input_digest')
    )
      db.exec('ALTER TABLE monument_turn_dedup ADD COLUMN input_digest TEXT');
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

/** Reads the owner out of `owner_json`; every refusal is one error. */
function decodeDedupOwner(
  ownerJson: string,
  binding: SqliteTurnDedupTables,
): {
  readonly owner: OwnerIdentity;
  readonly recorded: unknown;
  readonly inputDigest?: string;
} {
  let parsed: unknown;
  try {
    parsed = JSON.parse(ownerJson);
  } catch {
    throw new Error(
      binding.ownerErrorMessage ?? 'Invalid monument turn dedup owner_json.',
    );
  }
  try {
    const fields = (parsed ?? {}) as Record<string, unknown>;
    return {
      owner: parseOwnerIdentity({
        ...fields,
        id: fields[binding.ownerIdField],
      }),
      recorded: fields.invocation,
      ...(typeof fields.inputDigest === 'string'
        ? { inputDigest: fields.inputDigest }
        : {}),
    };
  } catch (error) {
    if (binding.ownerErrorMessage) throw new Error(binding.ownerErrorMessage);
    throw error;
  }
}

function decodeDedup(
  row: Record<string, unknown>,
  binding: SqliteTurnDedupTables,
): TurnDedupRecord {
  const key = String(row.dedup_key);
  const base = {
    key,
    value: typeof row.value === 'string' ? row.value : null,
    createdAt: Number(row.created_at),
  };
  const legacyUntracked = (binding.legacyUntrackedKeyPrefixes ?? []).some(
    (prefix) => key.startsWith(prefix),
  );
  if (typeof row.owner_json !== 'string')
    return { ...base, ...(legacyUntracked ? { invocation: 'untracked' } : {}) };
  const { owner, recorded, inputDigest } = decodeDedupOwner(
    row.owner_json,
    binding,
  );
  // Older writers replace owner_json but leave additive columns behind.
  // Trust the column only with matching proof on this owner, never a stale digest.
  const digest =
    inputDigest !== undefined &&
    (!binding.inputDigestColumn || row.input_digest === inputDigest)
      ? inputDigest
      : undefined;
  // An unrecognised value reads as absent, which a dead owner never reclaims;
  // only a row with no record at all can fall back to `untracked`.
  const invocation =
    parseInvocation(recorded) ??
    (legacyUntracked && recorded === undefined ? 'untracked' : undefined);
  return {
    ...base,
    owner,
    ...(invocation ? { invocation } : {}),
    ...(digest !== undefined ? { inputDigest: digest } : {}),
  };
}

/**
 * The invocation record lives inside `owner_json`, beside the owner it
 * describes (station#3579): a writer that replaces the owner without it
 * drops it, and the row then reads as unknown, never as a stale `pending`.
 */
function encodeDedupOwner(
  record: TurnDedupRecord,
  binding: SqliteTurnDedupTables,
): string | null {
  if (!record.owner) return null;
  const { id, ...rest } = ownerFields(record.owner);
  return JSON.stringify({
    ...rest,
    [binding.ownerIdField]: id,
    ...(record.invocation ? { invocation: record.invocation } : {}),
    ...(record.inputDigest !== undefined
      ? { inputDigest: record.inputDigest }
      : {}),
  });
}

function decodeBoundary(
  row: Record<string, unknown>,
  binding: SqliteTurnBoundaryTable,
): TurnBoundaryRecord {
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
    owner: parseOwnerIdentity(
      binding.ownerEncoding === 'json'
        ? JSON.parse(String(row.owner_json))
        : {
            id: row.owner_id,
            pid: row.owner_pid,
            identityKind: row.owner_identity_kind,
            birth: row.owner_birth,
          },
      { birthlessExact: 'unverified' },
    ),
    ...(binding.creationSequence
      ? {
          createdSequence:
            row.creation_sequence == null
              ? null
              : sequenceFence(row.creation_sequence),
        }
      : {}),
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

const INBOX_STATES: ReadonlySet<string> = new Set<InboxEntryState>([
  'queued',
  'placing',
  'placed',
  'unconfirmed',
  'refused',
  'cancelled',
]);

function decodeInboxEntry(row: Record<string, unknown>): InboxEntryRecord {
  const state = String(row.state);
  if (!INBOX_STATES.has(state))
    throw new Error(`Invalid monument inbox state: ${state}`);
  const kind = String(row.kind);
  if (kind !== 'follow-up')
    throw new Error(`Invalid monument inbox kind: ${kind}`);
  return {
    inboxId: String(row.inbox_id),
    key: String(row.entry_key),
    sequence: Number(row.sequence),
    kind,
    digest: String(row.digest),
    payload: String(row.payload),
    state: state as InboxEntryState,
    placement: typeof row.placement === 'string' ? row.placement : null,
    outcome: typeof row.outcome === 'string' ? row.outcome : null,
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

const INBOX_COLUMNS =
  'inbox_id, entry_key, sequence, kind, digest, payload, state, placement, outcome, created_at, updated_at';

function sequenceFence(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0)
    throw new Error('Invalid boundary creation sequence.');
  return value;
}

function boundaryColumns(binding: SqliteTurnBoundaryTable): string {
  return [
    'boundary_id',
    'thread_id',
    'state',
    'purpose',
    'provider_turn_id',
    ...(binding.ownerEncoding === 'json'
      ? ['owner_json']
      : ['owner_id', 'owner_pid', 'owner_birth', 'owner_identity_kind']),
    'created_at',
    'updated_at',
  ].join(', ');
}

function sqliteTransaction(
  db: SqliteKernelDatabase,
  tables: ResolvedTables,
): KernelTransaction {
  const one = (sql: string, ...values: Array<string | number | null>) =>
    db.prepare(sql).get(...values) as Record<string, unknown> | undefined;
  const all = (sql: string, ...values: Array<string | number | null>) =>
    db.prepare(sql).all(...values) as Array<Record<string, unknown>>;
  const run = (sql: string, ...values: Array<string | number | null>) =>
    Number(
      (db.prepare(sql).run(...values) as { changes: number | bigint }).changes,
    );
  // An unused area is never reached: `executeSync` refuses its commands.
  const dedup = tables.turnDedup as Exclude<
    ResolvedTables['turnDedup'],
    'unused'
  >;
  const keys = tables.requestKeys as Exclude<
    ResolvedTables['requestKeys'],
    'unused'
  >;
  const result = keys.resultColumn;
  const boundary = tables.turnBoundary as Exclude<
    ResolvedTables['turnBoundary'],
    'unused'
  >;
  const columns = boundaryColumns(boundary);
  const selectedColumns =
    columns +
    (boundary.creationSequence
      ? `, ${boundary.creationSequence.column} AS creation_sequence`
      : '');
  const decode = (row: Record<string, unknown>) =>
    decodeBoundary(row, boundary);
  const requireTerminalTable = () => {
    if (boundary.terminalFacts === 'host')
      throw new SqliteKernelConfigurationError(
        'Host terminal facts require a terminalSeen callback.',
      );
  };

  const count = (sql: string, ...values: Array<string | number | null>) =>
    Number((one(sql, ...values) as { total: number }).total);
  return {
    turnDedup: {
      get: (key) => {
        const row = one(
          `SELECT dedup_key, value, created_at, owner_json${dedup.inputDigestColumn ? `, ${dedup.inputDigestColumn} AS input_digest` : ''} FROM ${dedup.table} WHERE dedup_key = ?`,
          key,
        );
        return row ? decodeDedup(row, dedup) : undefined;
      },
      put: (record) => {
        run(
          `INSERT INTO ${dedup.table} (dedup_key, value, created_at, owner_json${dedup.inputDigestColumn ? `, ${dedup.inputDigestColumn}` : ''})
           VALUES (?, ?, ?, ?${dedup.inputDigestColumn ? ', ?' : ''})
           ON CONFLICT(dedup_key) DO UPDATE SET value = excluded.value,
             created_at = excluded.created_at, owner_json = excluded.owner_json${dedup.inputDigestColumn ? `, ${dedup.inputDigestColumn} = excluded.${dedup.inputDigestColumn}` : ''}`,
          record.key,
          record.value,
          record.createdAt,
          encodeDedupOwner(record, dedup),
          ...(dedup.inputDigestColumn ? [record.inputDigest ?? null] : []),
        );
      },
      delete: (key) => {
        run(`DELETE FROM ${dedup.table} WHERE dedup_key = ?`, key);
      },
      // Compared as bytes in the database's own encoding, measured by SQLite:
      // an exact prefix match with no wildcard semantics, unaffected by NUL
      // (where text `length()` stops), by characters outside the BMP, or by a
      // host database that stores UTF-16.
      deletePrefix: (prefix) =>
        run(
          `DELETE FROM ${dedup.table} WHERE substr(CAST(dedup_key AS BLOB), 1, length(CAST(?1 AS BLOB))) = CAST(?1 AS BLOB)`,
          prefix,
        ) +
        run(
          `DELETE FROM ${dedup.tombstoneTable} WHERE substr(CAST(dedup_key AS BLOB), 1, length(CAST(?1 AS BLOB))) = CAST(?1 AS BLOB)`,
          prefix,
        ),
      pruneResolved: (maxEntries, now) => {
        // Both statements pick the same overflow: nothing writes the table
        // between them inside this transaction, and the order is total.
        const overflow = `SELECT dedup_key FROM ${dedup.table}
          WHERE value IS NOT NULL
          ORDER BY created_at ASC, dedup_key ASC
          LIMIT MAX(0, (SELECT count(*) FROM ${dedup.table}) - ?)`;
        run(
          `INSERT OR IGNORE INTO ${dedup.tombstoneTable} (dedup_key, expired_at)
           SELECT dedup_key, ? FROM (${overflow})`,
          now,
          maxEntries,
        );
        run(
          `DELETE FROM ${dedup.table} WHERE dedup_key IN (${overflow})`,
          maxEntries,
        );
      },
      expiredAt: (key) => {
        const row = one(
          `SELECT expired_at FROM ${dedup.tombstoneTable} WHERE dedup_key = ?`,
          key,
        );
        return row ? Number(row.expired_at) : undefined;
      },
      deleteTombstonesBefore: (keyPrefix, cutoff) => {
        run(
          `DELETE FROM ${dedup.tombstoneTable}
            WHERE expired_at < ?2
              AND substr(CAST(dedup_key AS BLOB), 1, length(CAST(?1 AS BLOB))) = CAST(?1 AS BLOB)`,
          keyPrefix,
          cutoff,
        );
      },
    },
    turnBoundary: {
      get: (boundaryId) => {
        const row = one(
          `SELECT ${selectedColumns} FROM ${boundary.table} WHERE boundary_id = ?`,
          boundaryId,
        );
        return row ? decode(row) : undefined;
      },
      listThread: (threadId) =>
        all(
          `SELECT ${selectedColumns} FROM ${boundary.table} WHERE thread_id = ? ORDER BY rowid`,
          threadId,
        ).map(decode),
      listAll: () =>
        all(
          `SELECT ${selectedColumns} FROM ${boundary.table} ORDER BY rowid`,
        ).map(decode),
      put: (record) => {
        const fence = boundary.creationSequence;
        // An update retains even a NULL legacy fence. Only a new row reads the head.
        const prior = fence
          ? one(
              `SELECT ${fence.column} AS fence FROM ${boundary.table} WHERE boundary_id = ?`,
              record.boundaryId,
            )
          : undefined;
        const values = [
          record.boundaryId,
          record.threadId,
          record.state,
          record.purpose,
          record.providerTurnId ?? null,
          ...(boundary.ownerEncoding === 'json'
            ? [JSON.stringify(ownerFields(record.owner))]
            : [
                record.owner.id,
                record.owner.pid,
                record.owner.identityKind === 'exact'
                  ? record.owner.birth
                  : null,
                record.owner.identityKind,
              ]),
          record.createdAt,
          record.updatedAt,
          ...(fence
            ? [
                prior
                  ? prior.fence === null
                    ? null
                    : sequenceFence(prior.fence)
                  : sequenceFence(fence.read(db)),
              ]
            : []),
        ];
        const insertColumns = columns + (fence ? `, ${fence.column}` : '');
        // A bound row's identity, owner and creation fields belong to the host.
        // In particular, decoding a birthless exact owner must not rewrite it.
        const updates = (
          boundary.owned
            ? columns.split(', ').filter((column) => column !== 'boundary_id')
            : ['state', 'provider_turn_id', 'updated_at']
        )
          .map((column) => `${column} = excluded.${column}`)
          .join(', ');
        run(
          `INSERT INTO ${boundary.table} (${insertColumns}) VALUES (${values.map(() => '?').join(', ')})
             ON CONFLICT(boundary_id) DO UPDATE SET ${updates}`,
          ...values,
        );
      },
      delete: (boundaryId) => {
        run(`DELETE FROM ${boundary.table} WHERE boundary_id = ?`, boundaryId);
      },
    },
    turnTerminals: {
      has: (threadId, providerTurnId) => {
        requireTerminalTable();
        return (
          one(
            'SELECT 1 AS present FROM monument_turn_terminals WHERE thread_id = ? AND provider_turn_id = ?',
            threadId,
            providerTurnId,
          ) !== undefined
        );
      },
      add: (threadId, providerTurnId) => {
        requireTerminalTable();
        run(
          'INSERT OR IGNORE INTO monument_turn_terminals (thread_id, provider_turn_id) VALUES (?, ?)',
          threadId,
          providerTurnId,
        );
      },
      deleteThread: (threadId) => {
        requireTerminalTable();
        run(
          'DELETE FROM monument_turn_terminals WHERE thread_id = ?',
          threadId,
        );
      },
    },
    requestKeys: {
      get: (id) => {
        const row = one(
          `SELECT caller_session_id, tool, request_key, digest, decision, ${result} AS result, created_at
             FROM ${keys.table}
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
          `INSERT INTO ${keys.table}
             (caller_session_id, tool, request_key, digest, decision, ${result}, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(caller_session_id, tool, request_key) DO UPDATE SET
             digest = excluded.digest, decision = excluded.decision,
             ${result} = excluded.${result}, created_at = excluded.created_at`,
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
          `DELETE FROM ${keys.table} WHERE caller_session_id = ? AND tool = ? AND request_key = ?`,
          id.callerSessionId,
          id.tool,
          id.key,
        );
      },
      deleteCompletedCreatedBefore: (cutoff) => {
        run(
          `DELETE FROM ${keys.table} WHERE created_at < ? AND ${result} IS NOT NULL`,
          cutoff,
        );
      },
      countCaller: (caller, countedSince) =>
        count(
          `SELECT COUNT(*) AS total FROM ${keys.table}
            WHERE caller_session_id = ? AND (${result} IS NOT NULL OR created_at >= ?)`,
          caller,
          countedSince,
        ),
      countCallerCompleted: (caller) =>
        count(
          `SELECT COUNT(*) AS total FROM ${keys.table} WHERE caller_session_id = ? AND ${result} IS NOT NULL`,
          caller,
        ),
      countAll: (countedSince) =>
        count(
          `SELECT COUNT(*) AS total FROM ${keys.table}
            WHERE ${result} IS NOT NULL OR created_at >= ?`,
          countedSince,
        ),
      evictOldestCompleted: (caller, limit) => {
        run(
          `DELETE FROM ${keys.table} WHERE rowid IN (
             SELECT rowid FROM ${keys.table}
              WHERE caller_session_id = ? AND ${result} IS NOT NULL
              ORDER BY created_at ASC, rowid ASC LIMIT ?)`,
          caller,
          limit,
        );
      },
    },
    inbox: {
      get: (inboxId, key) => {
        const row = one(
          `SELECT ${INBOX_COLUMNS} FROM monument_inbox_entries WHERE inbox_id = ? AND entry_key = ?`,
          inboxId,
          key,
        );
        return row ? decodeInboxEntry(row) : undefined;
      },
      listInbox: (inboxId) =>
        all(
          `SELECT ${INBOX_COLUMNS} FROM monument_inbox_entries WHERE inbox_id = ? ORDER BY sequence ASC`,
          inboxId,
        ).map(decodeInboxEntry),
      listOpen: () =>
        all(
          `SELECT ${INBOX_COLUMNS} FROM monument_inbox_entries
            WHERE state IN ('queued', 'placing', 'unconfirmed')
            ORDER BY inbox_id ASC, sequence ASC`,
        ).map(decodeInboxEntry),
      put: (record) => {
        run(
          `INSERT INTO monument_inbox_entries (${INBOX_COLUMNS})
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(inbox_id, entry_key) DO UPDATE SET
             sequence = excluded.sequence, kind = excluded.kind,
             digest = excluded.digest, payload = excluded.payload,
             state = excluded.state, placement = excluded.placement,
             outcome = excluded.outcome, created_at = excluded.created_at,
             updated_at = excluded.updated_at`,
          record.inboxId,
          record.key,
          record.sequence,
          record.kind,
          record.digest,
          record.payload,
          record.state,
          record.placement,
          record.outcome,
          record.createdAt,
          record.updatedAt,
        );
      },
      deleteSettledBefore: (inboxId, cutoff) => {
        run(
          `DELETE FROM monument_inbox_entries
            WHERE inbox_id = ? AND updated_at < ?
              AND state IN ('placed', 'refused', 'cancelled')`,
          inboxId,
          cutoff,
        );
      },
      deleteInbox: (inboxId) =>
        run('DELETE FROM monument_inbox_entries WHERE inbox_id = ?', inboxId),
    },
  };
}

export function openSqliteKernelStorage(
  options: SqliteKernelStorageOptions,
): SqliteKernelStorage {
  if ((options.path === undefined) === (options.database === undefined))
    throw new TypeError('Pass exactly one of path or database.');
  const tables = resolveTables(options.tables);
  const owned = options.database === undefined;
  const db: SqliteKernelDatabase =
    options.database ?? new DatabaseSync(options.path as string);
  const participants = options.participants ?? [];
  let pragmas: SqliteKernelPragmas;
  try {
    pragmas =
      owned || options.configureConnection
        ? configureConnection(
            db,
            options.busyTimeoutMs ?? DEFAULT_BUSY_TIMEOUT_MS,
          )
        : observeConnection(db);
    migrate(db, tables);
  } catch (error) {
    if (owned) db.close?.();
    throw error;
  }
  const tx = sqliteTransaction(db, tables);
  const boundary = tables.turnBoundary;
  const boundFacts =
    boundary !== 'unused' && !boundary.owned
      ? boundary.terminalFacts === 'host'
        ? {
            terminalSeen: (thread: string, turn: string) =>
              boundary.terminalSeen!(db, thread, turn),
            retiredBoundaryIds: (thread: string) =>
              boundary.retiredBoundaryIds?.(db, thread) ?? [],
            terminalSequence: (thread: string, event: string | undefined) =>
              boundary.terminalSequence?.(db, thread, event),
          }
        : undefined
      : undefined;
  // Read-only commands run in a deferred transaction, so under WAL they are
  // served from a snapshot while another connection holds the write lock.
  // Not when a participant observes reads: a host write inside a deferred
  // read fails at once (SQLITE_BUSY_SNAPSHOT) if another connection committed
  // after the snapshot, so those take the write lock like any other command.
  const readsTakeWriteLock = participants.some(
    (participant) => participant.observeReads === true,
  );
  let closed = false;

  const executeSync = <C extends KernelCommand>(
    command: C,
    context: KernelContext,
    executeOptions: SqliteExecuteOptions = {},
  ): KernelResult<C> => {
    if (closed) throw new KernelStorageClosedError();
    const area = command.type.slice(0, command.type.indexOf('.')) as
      | 'turnDedup'
      | 'turnBoundary'
      | 'requestKeys'
      | 'inbox';
    if (tables[area] === 'unused')
      throw new SqliteKernelConfigurationError(
        `${command.type}: this storage keeps no ${area} tables.`,
      );
    if (db.isTransaction) {
      if (!executeOptions.withinHostTransaction)
        throw new Error(
          'monument commands cannot run inside a transaction the host already holds.',
        );
      return inSavepoint(
        db,
        () => {
          // A host savepoint may still be deferred. Reserve the writer before
          // reading the creation fence or any participant's admission facts.
          if (
            area === 'turnBoundary' &&
            !isReadOnlyKernelCommand(command) &&
            tables.turnBoundary !== 'unused'
          )
            db.prepare(
              `UPDATE ${tables.turnBoundary.table} SET boundary_id = boundary_id WHERE 0`,
            ).run();
          return runKernelTransactionStep(
            command,
            context,
            tx,
            participants,
            db,
            boundFacts,
          );
        },
        // A refusal keeps nothing, not even an earlier participant's admission.
        (result) => !isParticipantRefusal(result),
      );
    }
    return inTransaction(
      db,
      () =>
        runKernelTransactionStep(
          command,
          context,
          tx,
          participants,
          db,
          boundFacts,
        ),
      isReadOnlyKernelCommand(command) && !readsTakeWriteLock
        ? 'DEFERRED'
        : 'IMMEDIATE',
      // A refusal keeps nothing, not even an earlier participant's admission.
      (result) => !isParticipantRefusal(result),
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
