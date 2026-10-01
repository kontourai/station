import { closeSync, constants, lstatSync, openSync } from 'node:fs';
import { dirname, isAbsolute } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { NativeDeviceProofReplayedError } from './native-device-proof-verifier.js';

const JTI_PATTERN = /^[A-Za-z0-9_-]{16,128}$/;
const SCHEMA_VERSION = 1;
const DEFAULT_MAX_ENTRIES = 4096;
const META_DDL =
  'CREATE TABLE native_device_proof_replay_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT';
const REPLAY_DDL =
  'CREATE TABLE native_device_proof_replay (jti TEXT PRIMARY KEY, expires_at INTEGER NOT NULL) STRICT';
const MAX_DATABASE_BYTES = 128 * 1024 * 1024;

function assertPrivateReplayPath(dbPath: string): void {
  if (!isAbsolute(dbPath))
    throw new Error('Native Device replay database path must be absolute.');
  const parent = lstatSync(dirname(dbPath));
  if (
    !parent.isDirectory() ||
    parent.isSymbolicLink() ||
    (process.platform !== 'win32' &&
      ((parent.mode & 0o777) !== 0o700 || parent.uid !== process.getuid?.()))
  )
    throw new Error('Native Device replay database parent is not private.');
  let databaseExists = true;
  try {
    lstatSync(dbPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    databaseExists = false;
  }
  if (!databaseExists) {
    const descriptor = openSync(
      dbPath,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
      0o600,
    );
    closeSync(descriptor);
  }
  for (const path of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) {
    let status: ReturnType<typeof lstatSync>;
    try {
      status = lstatSync(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT' && path !== dbPath)
        continue;
      throw error;
    }
    if (
      !status.isFile() ||
      status.isSymbolicLink() ||
      status.nlink !== 1 ||
      status.size > MAX_DATABASE_BYTES ||
      (process.platform !== 'win32' &&
        ((status.mode & 0o777) !== 0o600 || status.uid !== process.getuid?.()))
    )
      throw new Error('Native Device replay database file is not private.');
  }
}

export class NativeDeviceProofReplayStoreUnavailableError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'NativeDeviceProofReplayStoreUnavailableError';
  }
}

interface ReplayRow {
  jti: string;
}

export interface NativeDeviceReplayStoreOptions {
  readonly maxEntries?: number;
  readonly nowSeconds?: () => number;
}

export class NativeDeviceProofReplayStoreSqlite {
  private readonly db: DatabaseSync;
  private readonly stationId: string;
  private readonly maxEntries: number;
  private readonly nowSeconds: () => number;
  private closed = false;

  constructor(
    dbPath: string,
    stationId: string,
    options: NativeDeviceReplayStoreOptions = {},
  ) {
    if (
      typeof stationId !== 'string' ||
      stationId.length === 0 ||
      stationId.length > 512
    )
      throw new NativeDeviceProofReplayStoreUnavailableError(
        'Native Device replay store requires a bounded Station ID.',
      );
    this.stationId = stationId;
    this.maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
    if (!Number.isSafeInteger(this.maxEntries) || this.maxEntries < 1)
      throw new NativeDeviceProofReplayStoreUnavailableError(
        'Native Device replay store capacity must be a positive integer.',
      );
    this.nowSeconds =
      options.nowSeconds ?? (() => Math.floor(Date.now() / 1000));
    let db: DatabaseSync | undefined;
    try {
      assertPrivateReplayPath(dbPath);
      db = new DatabaseSync(dbPath);
      db.exec('PRAGMA busy_timeout = 5000');
      db.exec('PRAGMA journal_mode = WAL');
      this.assertUsable(db);
    } catch (cause) {
      try {
        db?.close();
      } catch {
        // the open failure is the actionable error
      }
      throw new NativeDeviceProofReplayStoreUnavailableError(
        'Native Device replay store cannot be opened; failing closed.',
        { cause },
      );
    }
    this.db = db;
  }

  private assertUsable(db: DatabaseSync): void {
    const quickCheck = db.prepare('PRAGMA quick_check').get() as
      | { quick_check: string }
      | undefined;
    if (quickCheck?.quick_check !== 'ok')
      throw new Error(
        `sqlite quick_check reported: ${quickCheck?.quick_check ?? 'no row'}`,
      );
    const tables = db
      .prepare(
        "SELECT name, sql FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
      )
      .all() as Array<{ name: string; sql: string }>;
    if (tables.length === 0) {
      db.exec('BEGIN IMMEDIATE');
      try {
        db.exec(META_DDL);
        db.exec(REPLAY_DDL);
        db.prepare(
          'INSERT INTO native_device_proof_replay_meta (key, value) VALUES (?, ?)',
        ).run('schema_version', String(SCHEMA_VERSION));
        db.prepare(
          'INSERT INTO native_device_proof_replay_meta (key, value) VALUES (?, ?)',
        ).run('station_id', this.stationId);
        db.prepare(
          'INSERT INTO native_device_proof_replay_meta (key, value) VALUES (?, ?)',
        ).run('clock_floor', '0');
        db.exec('COMMIT');
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
      return;
    }
    if (
      tables.length !== 2 ||
      tables[0]?.name !== 'native_device_proof_replay' ||
      tables[0].sql !== REPLAY_DDL ||
      tables[1]?.name !== 'native_device_proof_replay_meta' ||
      tables[1].sql !== META_DDL
    )
      throw new Error('Native Device replay database schema is unavailable.');
    const meta = db
      .prepare(
        'SELECT key, value FROM native_device_proof_replay_meta ORDER BY key',
      )
      .all() as Array<{ key: string; value: string }>;
    if (
      meta.length !== 3 ||
      meta[0]?.key !== 'clock_floor' ||
      !/^\d+$/.test(meta[0].value) ||
      !Number.isSafeInteger(Number(meta[0].value)) ||
      meta[1]?.key !== 'schema_version' ||
      meta[1].value !== String(SCHEMA_VERSION) ||
      meta[2]?.key !== 'station_id' ||
      meta[2].value !== this.stationId
    )
      throw new Error(
        'Native Device replay database authority is unavailable.',
      );
  }

  async consume(jti: string, expiresAt: number): Promise<void> {
    if (this.closed)
      throw new NativeDeviceProofReplayStoreUnavailableError(
        'Native Device replay store is closed.',
      );
    if (typeof jti !== 'string' || !JTI_PATTERN.test(jti))
      throw new NativeDeviceProofReplayStoreUnavailableError(
        'Native Device replay store received a malformed JTI.',
      );
    if (
      typeof expiresAt !== 'number' ||
      !Number.isSafeInteger(expiresAt) ||
      expiresAt <= 0
    )
      throw new NativeDeviceProofReplayStoreUnavailableError(
        'Native Device replay store received a malformed expiry.',
      );
    const now = this.nowSeconds();
    if (!Number.isSafeInteger(now) || now < 0)
      throw new NativeDeviceProofReplayStoreUnavailableError(
        'Native Device replay store verification clock is invalid.',
      );
    if (expiresAt <= now)
      throw new NativeDeviceProofReplayStoreUnavailableError(
        'Native Device proof is already expired; nothing is consumed.',
      );
    try {
      this.db.exec('BEGIN IMMEDIATE');
      try {
        const floor = this.db
          .prepare(
            "SELECT value FROM native_device_proof_replay_meta WHERE key='clock_floor'",
          )
          .get()?.value;
        if (
          typeof floor !== 'string' ||
          !/^\d+$/.test(floor) ||
          !Number.isSafeInteger(Number(floor)) ||
          now < Number(floor)
        )
          throw new Error(
            'Native Device replay verification time moved backwards.',
          );
        this.db
          .prepare(
            "UPDATE native_device_proof_replay_meta SET value=? WHERE key='clock_floor'",
          )
          .run(String(now));
        this.db
          .prepare(
            'DELETE FROM native_device_proof_replay WHERE expires_at <= ?',
          )
          .run(now);
        const existing = this.db
          .prepare('SELECT jti FROM native_device_proof_replay WHERE jti = ?')
          .get(jti) as ReplayRow | undefined;
        if (existing !== undefined) throw new NativeDeviceProofReplayedError();
        const countRow = this.db
          .prepare('SELECT COUNT(*) AS count FROM native_device_proof_replay')
          .get() as { count: number };
        if (countRow.count >= this.maxEntries)
          throw new Error(
            `native_device_proof_replay is at capacity (${this.maxEntries} rows)`,
          );
        const inserted = this.db
          .prepare(
            'INSERT INTO native_device_proof_replay (jti, expires_at) VALUES (?, ?)',
          )
          .run(jti, expiresAt);
        if (inserted.changes !== 1)
          throw new Error('native_device_proof_replay insert changed no rows');
        this.db.exec('COMMIT');
      } catch (inner) {
        try {
          this.db.exec('ROLLBACK');
        } catch {
          // the transaction may already be gone; the original error is truth
        }
        if (inner instanceof NativeDeviceProofReplayedError) throw inner;
        if (
          inner instanceof Error &&
          /UNIQUE constraint failed/.test(inner.message)
        )
          throw new NativeDeviceProofReplayedError();
        throw inner;
      }
    } catch (cause) {
      if (cause instanceof NativeDeviceProofReplayedError) throw cause;
      throw new NativeDeviceProofReplayStoreUnavailableError(
        'Native Device replay store write failed; the proof is not consumed.',
        { cause },
      );
    }
  }

  has(jti: string): boolean {
    const row = this.db
      .prepare('SELECT jti FROM native_device_proof_replay WHERE jti = ?')
      .get(jti) as ReplayRow | undefined;
    return row !== undefined;
  }

  size(): number {
    const row = this.db
      .prepare('SELECT COUNT(*) AS count FROM native_device_proof_replay')
      .get() as { count: number };
    return row.count;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.db.close();
  }
}
