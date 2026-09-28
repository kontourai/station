import { DatabaseSync } from 'node:sqlite';
import { NativeDeviceProofReplayedError } from './native-device-proof-verifier.js';

const JTI_PATTERN = /^[A-Za-z0-9_-]{16,128}$/;
const SCHEMA_VERSION = 1;
const DEFAULT_MAX_ENTRIES = 4096;

const BASE64URL_JTI = JTI_PATTERN;

export class NativeDeviceProofReplayStoreUnavailableError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'NativeDeviceProofReplayStoreUnavailableError';
  }
}

interface ReplayRow {
  jti: string;
}

interface MetaRow {
  value: string;
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
    db.exec(
      'CREATE TABLE IF NOT EXISTS native_device_proof_replay_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)',
    );
    db.exec(
      'CREATE TABLE IF NOT EXISTS native_device_proof_replay (jti TEXT PRIMARY KEY, expires_at INTEGER NOT NULL)',
    );
    const versionRow = db
      .prepare(
        "SELECT value FROM native_device_proof_replay_meta WHERE key = 'schema_version'",
      )
      .get() as MetaRow | undefined;
    if (versionRow === undefined) {
      db.prepare(
        "INSERT INTO native_device_proof_replay_meta (key, value) VALUES ('schema_version', ?)",
      ).run(String(SCHEMA_VERSION));
    } else if (versionRow.value !== String(SCHEMA_VERSION)) {
      throw new Error(
        `native_device_proof_replay schema version ${versionRow.value} is not ${SCHEMA_VERSION}`,
      );
    }
    const stationRow = db
      .prepare(
        "SELECT value FROM native_device_proof_replay_meta WHERE key = 'station_id'",
      )
      .get() as MetaRow | undefined;
    if (stationRow === undefined) {
      db.prepare(
        "INSERT INTO native_device_proof_replay_meta (key, value) VALUES ('station_id', ?)",
      ).run(this.stationId);
    } else if (stationRow.value !== this.stationId) {
      throw new Error(
        'native_device_proof_replay database belongs to a different Station ID',
      );
    }
    const replayColumns = db
      .prepare('PRAGMA table_info(native_device_proof_replay)')
      .all() as {
      name: string;
    }[];
    const columnNames = replayColumns
      .map((column) => column.name)
      .sort()
      .join(',');
    if (columnNames !== 'expires_at,jti')
      throw new Error(
        `native_device_proof_replay has unexpected columns: ${columnNames}`,
      );
  }

  async consume(jti: string, expiresAt: number): Promise<void> {
    if (this.closed)
      throw new NativeDeviceProofReplayStoreUnavailableError(
        'Native Device replay store is closed.',
      );
    if (typeof jti !== 'string' || !BASE64URL_JTI.test(jti))
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
    if (expiresAt <= now)
      throw new NativeDeviceProofReplayStoreUnavailableError(
        'Native Device proof is already expired; nothing is consumed.',
      );
    try {
      this.db.exec('BEGIN IMMEDIATE');
      try {
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
