import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

const ID = /^[A-Za-z0-9_-]{8,128}$/;
const ORIGIN = /^https?:\/\/[^/]+$/;
const SDP_LIMIT = 128 * 1024;

export type BrokerCredential = { id: string; secret: string };
type Scope = {
  stationId: string;
  enrollmentId: string;
  generation: number;
  browserOrigin: string;
};

function digest(secret: string) {
  return createHash('sha256').update(secret).digest();
}
function assertText(value: string, name: string) {
  if (!ID.test(value)) throw new Error(`invalid_${name}`);
}
function assertScope(scope: Scope) {
  assertText(scope.stationId, 'station_id');
  assertText(scope.enrollmentId, 'enrollment_id');
  if (!Number.isSafeInteger(scope.generation) || scope.generation < 1)
    throw new Error('invalid_generation');
  if (!ORIGIN.test(scope.browserOrigin))
    throw new Error('invalid_browser_origin');
}

/** Metadata-only broker authority. It never stores Station credentials, account identity or content. */
export class SelfHostedBrokerService {
  private readonly db: DatabaseSync;
  constructor(
    path: string,
    private readonly now = () => Date.now(),
  ) {
    if (!path.startsWith('/'))
      throw new Error('broker_database_path_must_be_absolute');
    this.db = new DatabaseSync(path, { timeout: 5000 });
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;
      CREATE TABLE IF NOT EXISTS broker_leases(
        station_id TEXT PRIMARY KEY, enrollment_id TEXT NOT NULL, generation INTEGER NOT NULL,
        browser_origin TEXT NOT NULL, connector_hash BLOB NOT NULL, routing_hash BLOB NOT NULL,
        expires_at INTEGER NOT NULL, withdrawn_at INTEGER);
      CREATE TABLE IF NOT EXISTS broker_connections(
        station_id TEXT NOT NULL, enrollment_id TEXT NOT NULL, generation INTEGER NOT NULL,
        client_id TEXT NOT NULL, nonce TEXT NOT NULL, offer_sdp TEXT NOT NULL, answer_sdp TEXT,
        station_proof TEXT, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL,
        PRIMARY KEY(station_id, client_id, nonce));
      CREATE INDEX IF NOT EXISTS broker_connection_expiry ON broker_connections(expires_at);`);
  }
  close() {
    this.db.close();
  }
  provision(scope: Scope, ttlMs = 60_000) {
    assertScope(scope);
    const connector = {
      id: randomBytes(16).toString('base64url'),
      secret: randomBytes(32).toString('base64url'),
    };
    const routing = {
      id: randomBytes(16).toString('base64url'),
      secret: randomBytes(32).toString('base64url'),
    };
    const result = this.db
      .prepare(`INSERT INTO broker_leases VALUES(?,?,?,?,?,?,?,NULL)
      ON CONFLICT(station_id) DO UPDATE SET enrollment_id=excluded.enrollment_id,generation=excluded.generation,
      browser_origin=excluded.browser_origin,connector_hash=excluded.connector_hash,routing_hash=excluded.routing_hash,
      expires_at=excluded.expires_at,withdrawn_at=NULL WHERE excluded.generation > broker_leases.generation`)
      .run(
        scope.stationId,
        scope.enrollmentId,
        scope.generation,
        scope.browserOrigin,
        digest(connector.secret),
        digest(routing.secret),
        this.now() + ttlMs,
      );
    if (result.changes !== 1) throw new Error('stale_generation');
    return { connector, routing, scope };
  }
  private lease(
    scope: Scope,
    credential: BrokerCredential,
    kind: 'connector' | 'routing',
  ) {
    assertScope(scope);
    assertText(credential.id, 'credential_id');
    const row = this.db
      .prepare(`SELECT * FROM broker_leases WHERE station_id=?`)
      .get(scope.stationId) as any;
    const hash = row?.[`${kind}_hash`] as Uint8Array | undefined;
    if (
      !row ||
      row.enrollment_id !== scope.enrollmentId ||
      row.generation !== scope.generation ||
      row.browser_origin !== scope.browserOrigin ||
      row.withdrawn_at !== null ||
      row.expires_at <= this.now() ||
      !hash ||
      !timingSafeEqual(Buffer.from(hash), digest(credential.secret))
    )
      throw new Error('broker_credential_refused');
    return row;
  }
  renew(
    scope: Scope,
    credential: BrokerCredential,
    expectedExpiresAt: number,
    ttlMs = 60_000,
  ) {
    this.lease(scope, credential, 'connector');
    const next = this.now() + ttlMs;
    const result = this.db
      .prepare(
        `UPDATE broker_leases SET expires_at=? WHERE station_id=? AND generation=? AND expires_at=? AND withdrawn_at IS NULL`,
      )
      .run(next, scope.stationId, scope.generation, expectedExpiresAt);
    if (result.changes !== 1) throw new Error('lease_conflict');
    return { expiresAt: next };
  }
  withdraw(scope: Scope, credential: BrokerCredential) {
    this.lease(scope, credential, 'connector');
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db
        .prepare(
          'UPDATE broker_leases SET withdrawn_at=? WHERE station_id=? AND generation=?',
        )
        .run(this.now(), scope.stationId, scope.generation);
      this.db
        .prepare('DELETE FROM broker_connections WHERE station_id=?')
        .run(scope.stationId);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
  open(
    scope: Scope,
    credential: BrokerCredential,
    input: { clientId: string; nonce: string; offerSdp: string },
  ) {
    this.lease(scope, credential, 'routing');
    assertText(input.clientId, 'client_id');
    assertText(input.nonce, 'nonce');
    if (Buffer.byteLength(input.offerSdp) > SDP_LIMIT)
      throw new Error('offer_too_large');
    const now = this.now();
    this.db
      .prepare('DELETE FROM broker_connections WHERE expires_at<=?')
      .run(now);
    const total = (
      this.db.prepare('SELECT count(*) n FROM broker_connections').get() as any
    ).n;
    const station = (
      this.db
        .prepare('SELECT count(*) n FROM broker_connections WHERE station_id=?')
        .get(scope.stationId) as any
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
          scope.generation,
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
  }
  answer(
    scope: Scope,
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
        scope.generation,
        input.clientId,
        input.nonce,
        this.now(),
      );
    if (result.changes !== 1) throw new Error('connection_unavailable');
  }
  read(
    scope: Scope,
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
        scope.generation,
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
