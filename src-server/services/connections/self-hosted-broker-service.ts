import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { closeSync, lstatSync, openSync } from 'node:fs';
import { dirname, isAbsolute } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const ID = /^[A-Za-z0-9_-]{8,128}$/;
const SDP_LIMIT = 128 * 1024;

export type BrokerCredential = { id: string; secret: string };
export type BrokerCredentialBundle = {
  connector: BrokerCredential;
  routing: BrokerCredential;
};
export function createBrokerCredentialBundle(): BrokerCredentialBundle {
  return {
    connector: {
      id: randomBytes(16).toString('base64url'),
      secret: randomBytes(32).toString('base64url'),
    },
    routing: {
      id: randomBytes(16).toString('base64url'),
      secret: randomBytes(32).toString('base64url'),
    },
  };
}
export type BrokerScope = {
  stationId: string;
  enrollmentId: string;
  routingGeneration: number;
  browserOrigin: string;
};

function digest(secret: string) {
  return createHash('sha256').update(secret).digest();
}
function assertPrivateFile(path: string) {
  const file = lstatSync(path);
  if (
    !file.isFile() ||
    file.isSymbolicLink() ||
    file.nlink !== 1 ||
    file.uid !== process.getuid?.() ||
    (file.mode & 0o077) !== 0
  )
    throw new Error('broker_database_must_be_private');
}
function assertText(value: string, name: string) {
  if (!ID.test(value)) throw new Error(`invalid_${name}`);
}
export function validateBrokerScope(value: unknown): BrokerScope {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('invalid_scope');
  const scope = value as Record<string, unknown>;
  if (
    Object.keys(scope).sort().join(',') !==
    'browserOrigin,enrollmentId,routingGeneration,stationId'
  )
    throw new Error('invalid_scope');
  if (
    typeof scope.stationId !== 'string' ||
    typeof scope.enrollmentId !== 'string'
  )
    throw new Error('invalid_scope');
  assertText(scope.stationId, 'station_id');
  assertText(scope.enrollmentId, 'enrollment_id');
  if (
    !Number.isSafeInteger(scope.routingGeneration) ||
    (scope.routingGeneration as number) < 1
  )
    throw new Error('invalid_generation');
  if (typeof scope.browserOrigin !== 'string')
    throw new Error('invalid_browser_origin');
  let origin: URL;
  try {
    origin = new URL(scope.browserOrigin);
  } catch {
    throw new Error('invalid_browser_origin');
  }
  const loopback =
    origin.hostname === '127.0.0.1' ||
    origin.hostname === '[::1]' ||
    origin.hostname === 'localhost';
  if (
    origin.origin !== scope.browserOrigin ||
    origin.pathname !== '/' ||
    origin.search ||
    origin.hash ||
    !(origin.protocol === 'https:' || (origin.protocol === 'http:' && loopback))
  )
    throw new Error('invalid_browser_origin');
  return scope as BrokerScope;
}

/** Metadata-only broker authority. It never stores Station credentials, account identity or content. */
export class SelfHostedBrokerService {
  private readonly db: DatabaseSync;
  constructor(
    path: string,
    private readonly now = () => Date.now(),
  ) {
    if (!isAbsolute(path))
      throw new Error('broker_database_path_must_be_absolute');
    const parent = lstatSync(dirname(path));
    if (
      !parent.isDirectory() ||
      parent.isSymbolicLink() ||
      parent.uid !== process.getuid?.() ||
      (parent.mode & 0o077) !== 0
    )
      throw new Error('broker_database_parent_must_be_private');
    try {
      closeSync(openSync(path, 'wx', 0o600));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      assertPrivateFile(path);
    }
    for (const suffix of ['-wal', '-shm', '-journal']) {
      try {
        assertPrivateFile(path + suffix);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }
    this.db = new DatabaseSync(path, { timeout: 5000 });
    const application = this.db.prepare('PRAGMA application_id').get() as {
      application_id: number;
    };
    const tables = this.db
      .prepare("SELECT count(*) count FROM sqlite_master WHERE type='table'")
      .get() as { count: number };
    if (tables.count > 0 && application.application_id !== 0x53544252) {
      this.db.close();
      throw new Error('broker_database_schema_refused');
    }
    const version = this.db.prepare('PRAGMA user_version').get() as {
      user_version: number;
    };
    if (tables.count > 0 && version.user_version !== 1) {
      this.db.close();
      throw new Error('broker_database_version_refused');
    }
    if (tables.count === 0)
      this.db.exec('PRAGMA application_id=1398030930; PRAGMA user_version=1');
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;
      CREATE TABLE IF NOT EXISTS broker_leases(
        station_id TEXT PRIMARY KEY, enrollment_id TEXT NOT NULL, generation INTEGER NOT NULL,
        browser_origin TEXT NOT NULL, connector_id TEXT NOT NULL, connector_hash BLOB NOT NULL,
        routing_id TEXT NOT NULL, routing_hash BLOB NOT NULL,
        expires_at INTEGER NOT NULL, lease_revision INTEGER NOT NULL, last_seen_at INTEGER, withdrawn_at INTEGER);
      CREATE TABLE IF NOT EXISTS broker_connections(
        station_id TEXT NOT NULL, enrollment_id TEXT NOT NULL, generation INTEGER NOT NULL,
        client_id TEXT NOT NULL, nonce TEXT NOT NULL, offer_sdp TEXT NOT NULL, answer_sdp TEXT,
        station_proof TEXT, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL,
        PRIMARY KEY(station_id, client_id, nonce));
      CREATE INDEX IF NOT EXISTS broker_connection_expiry ON broker_connections(expires_at);`);
    for (const suffix of ['-wal', '-shm']) assertPrivateFile(path + suffix);
  }
  close() {
    this.db.close();
  }
  isOriginAllowed(origin: string) {
    const row = this.db
      .prepare(
        'SELECT 1 allowed FROM broker_leases WHERE browser_origin=? AND withdrawn_at IS NULL AND expires_at>? LIMIT 1',
      )
      .get(origin, this.now()) as { allowed: number } | undefined;
    return row?.allowed === 1;
  }
  private transaction<T>(operation: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = operation();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
  provision(
    input: BrokerScope,
    ttlMs = 60_000,
    bundle = createBrokerCredentialBundle(),
  ) {
    const scope = validateBrokerScope(input);
    const { connector, routing } = bundle;
    const result = this.transaction(() => {
      const existing = this.db
        .prepare('SELECT * FROM broker_leases WHERE station_id=?')
        .get(scope.stationId) as any;
      if (existing?.generation === scope.routingGeneration) {
        const same =
          existing.enrollment_id === scope.enrollmentId &&
          existing.browser_origin === scope.browserOrigin &&
          existing.connector_id === connector.id &&
          existing.routing_id === routing.id &&
          timingSafeEqual(
            Buffer.from(existing.connector_hash),
            digest(connector.secret),
          ) &&
          timingSafeEqual(
            Buffer.from(existing.routing_hash),
            digest(routing.secret),
          );
        if (!same) throw new Error('stale_generation');
        return { changes: 0, idempotent: true };
      }
      const written = this.db
        .prepare(`INSERT INTO broker_leases VALUES(?,?,?,?,?,?,?,?,?,0,NULL,NULL)
      ON CONFLICT(station_id) DO UPDATE SET enrollment_id=excluded.enrollment_id,generation=excluded.generation,
      browser_origin=excluded.browser_origin,connector_id=excluded.connector_id,connector_hash=excluded.connector_hash,
      routing_id=excluded.routing_id,routing_hash=excluded.routing_hash,
      expires_at=excluded.expires_at,withdrawn_at=NULL WHERE excluded.generation > broker_leases.generation`)
        .run(
          scope.stationId,
          scope.enrollmentId,
          scope.routingGeneration,
          scope.browserOrigin,
          connector.id,
          digest(connector.secret),
          routing.id,
          digest(routing.secret),
          this.now() + ttlMs,
        );
      if (Number(written.changes) === 1)
        this.db
          .prepare(
            'DELETE FROM broker_connections WHERE station_id=? AND generation<>?',
          )
          .run(scope.stationId, scope.routingGeneration);
      return { changes: Number(written.changes), idempotent: false };
    });
    if (result.changes !== 1 && !result.idempotent)
      throw new Error('stale_generation');
    return { connector, routing, scope };
  }
  private lease(
    scope: BrokerScope,
    credential: BrokerCredential,
    kind: 'connector' | 'routing',
  ) {
    scope = validateBrokerScope(scope);
    assertText(credential.id, 'credential_id');
    const row = this.db
      .prepare(`SELECT * FROM broker_leases WHERE station_id=?`)
      .get(scope.stationId) as any;
    const hash = row?.[`${kind}_hash`] as Uint8Array | undefined;
    if (
      !row ||
      row.enrollment_id !== scope.enrollmentId ||
      row.generation !== scope.routingGeneration ||
      row.browser_origin !== scope.browserOrigin ||
      row[`${kind}_id`] !== credential.id ||
      row.withdrawn_at !== null ||
      row.expires_at <= this.now() ||
      !hash ||
      !timingSafeEqual(Buffer.from(hash), digest(credential.secret))
    )
      throw new Error('broker_credential_refused');
    return row;
  }
  renew(
    scope: BrokerScope,
    credential: BrokerCredential,
    expectedRevision: number,
    ttlMs = 60_000,
  ) {
    return this.transaction(() => {
      const lease = this.lease(scope, credential, 'connector');
      if (lease.lease_revision !== expectedRevision)
        throw new Error('lease_conflict');
      const next = Math.max(this.now(), lease.expires_at as number) + ttlMs;
      const result = this.db
        .prepare(
          `UPDATE broker_leases SET expires_at=?,lease_revision=lease_revision+1 WHERE station_id=? AND generation=? AND lease_revision=? AND withdrawn_at IS NULL`,
        )
        .run(next, scope.stationId, scope.routingGeneration, expectedRevision);
      if (result.changes !== 1) throw new Error('lease_conflict');
      return { expiresAt: next, revision: expectedRevision + 1 };
    });
  }
  register(scope: BrokerScope, credential: BrokerCredential) {
    return this.transaction(() => {
      this.lease(scope, credential, 'connector');
      const result = this.db
        .prepare(
          'UPDATE broker_leases SET last_seen_at=? WHERE station_id=? AND enrollment_id=? AND generation=? AND withdrawn_at IS NULL',
        )
        .run(
          this.now(),
          scope.stationId,
          scope.enrollmentId,
          scope.routingGeneration,
        );
      if (result.changes !== 1) throw new Error('lease_conflict');
      return { registeredAt: this.now() };
    });
  }
  status(scope: BrokerScope, credential: BrokerCredential) {
    const lease = this.lease(scope, credential, 'routing');
    return {
      state:
        typeof lease.last_seen_at === 'number' &&
        lease.last_seen_at + 30_000 > this.now()
          ? 'online'
          : 'offline',
      routingGeneration: scope.routingGeneration,
      expiresAt: lease.expires_at,
    };
  }
  withdraw(scope: BrokerScope, credential: BrokerCredential) {
    this.transaction(() => {
      this.lease(scope, credential, 'connector');
      const result = this.db
        .prepare(
          'UPDATE broker_leases SET withdrawn_at=? WHERE station_id=? AND generation=?',
        )
        .run(this.now(), scope.stationId, scope.routingGeneration);
      if (result.changes !== 1) throw new Error('lease_conflict');
      this.db
        .prepare(
          'DELETE FROM broker_connections WHERE station_id=? AND generation=?',
        )
        .run(scope.stationId, scope.routingGeneration);
    });
  }
  open(
    scope: BrokerScope,
    credential: BrokerCredential,
    input: { clientId: string; nonce: string; offerSdp: string },
  ) {
    return this.transaction(() => {
      this.lease(scope, credential, 'routing');
      assertText(input.clientId, 'client_id');
      assertText(input.nonce, 'nonce');
      if (Buffer.byteLength(input.offerSdp) > SDP_LIMIT)
        throw new Error('offer_too_large');
      const now = this.now();
      this.db
        .prepare('DELETE FROM broker_connections WHERE created_at + 330000 <=?')
        .run(now);
      const total = (
        this.db
          .prepare(
            'SELECT count(*) n FROM broker_connections WHERE expires_at>?',
          )
          .get(now) as any
      ).n;
      const station = (
        this.db
          .prepare(
            'SELECT count(*) n FROM broker_connections WHERE station_id=? AND expires_at>?',
          )
          .get(scope.stationId, now) as any
      ).n;
      if (total >= 1024 || station >= 32) throw new Error('pending_limit');
      try {
        this.db
          .prepare(
            'INSERT INTO broker_connections VALUES(?,?,?,?,?,?,NULL,NULL,?,?)',
          )
          .run(
            scope.stationId,
            scope.enrollmentId,
            scope.routingGeneration,
            input.clientId,
            input.nonce,
            input.offerSdp,
            now,
            now + 30_000,
          );
      } catch {
        throw new Error('connection_replayed');
      }
      return { expiresAt: now + 30_000 };
    });
  }
  answer(
    scope: BrokerScope,
    credential: BrokerCredential,
    input: {
      clientId: string;
      nonce: string;
      answerSdp: string;
      stationProof: string;
    },
  ) {
    this.lease(scope, credential, 'connector');
    if (
      Buffer.byteLength(input.answerSdp) > SDP_LIMIT ||
      Buffer.byteLength(input.stationProof) > 256 * 1024
    )
      throw new Error('answer_too_large');
    const result = this.db
      .prepare(
        `UPDATE broker_connections SET answer_sdp=?,station_proof=? WHERE station_id=? AND enrollment_id=? AND generation=? AND client_id=? AND nonce=? AND answer_sdp IS NULL AND expires_at>?`,
      )
      .run(
        input.answerSdp,
        input.stationProof,
        scope.stationId,
        scope.enrollmentId,
        scope.routingGeneration,
        input.clientId,
        input.nonce,
        this.now(),
      );
    if (result.changes !== 1) throw new Error('connection_unavailable');
  }
  offers(scope: BrokerScope, credential: BrokerCredential) {
    this.lease(scope, credential, 'connector');
    return this.db
      .prepare(`SELECT client_id AS clientId, nonce, offer_sdp AS offerSdp, expires_at AS expiresAt
      FROM broker_connections WHERE station_id=? AND enrollment_id=? AND generation=? AND answer_sdp IS NULL AND expires_at>? ORDER BY created_at LIMIT 32`)
      .all(
        scope.stationId,
        scope.enrollmentId,
        scope.routingGeneration,
        this.now(),
      );
  }
  read(
    scope: BrokerScope,
    credential: BrokerCredential,
    clientId: string,
    nonce: string,
  ) {
    this.lease(scope, credential, 'routing');
    const row = this.db
      .prepare(
        'SELECT answer_sdp,station_proof,expires_at FROM broker_connections WHERE station_id=? AND enrollment_id=? AND generation=? AND client_id=? AND nonce=?',
      )
      .get(
        scope.stationId,
        scope.enrollmentId,
        scope.routingGeneration,
        clientId,
        nonce,
      ) as any;
    if (!row || row.expires_at <= this.now())
      throw new Error('connection_unavailable');
    return {
      answerSdp: row.answer_sdp,
      stationProof: row.station_proof,
      expiresAt: row.expires_at,
    };
  }
}
