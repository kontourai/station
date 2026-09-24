import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { closeSync, lstatSync, openSync } from 'node:fs';
import { dirname, isAbsolute } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { STATION_CONNECTION_PROOF_MAX_BYTES } from '@kontourai/station-contracts/connection-proof';
import {
  SELF_HOSTED_BROKER_CLIENT_GRANT_VERSION,
  SELF_HOSTED_BROKER_INVITATION_VERSION,
  SELF_HOSTED_BROKER_NATIVE_CLIENT_GRANT_VERSION,
  SELF_HOSTED_BROKER_NATIVE_CONNECTION_ANSWER_VERSION,
  SELF_HOSTED_BROKER_NATIVE_CONNECTION_OFFER_VERSION,
  SELF_HOSTED_BROKER_NATIVE_CONNECTION_OPEN_VERSION,
  SELF_HOSTED_BROKER_NATIVE_CONNECTION_OPENED_VERSION,
  SELF_HOSTED_BROKER_NATIVE_INVITATION_VERSION,
  type SelfHostedBrokerClientGrantV1,
  type SelfHostedBrokerNativeClientGrantV2,
  type SelfHostedBrokerNativeClientSurfaceV2,
  type SelfHostedBrokerNativeConnectionAnswerV2,
  type SelfHostedBrokerNativeConnectionOfferV2,
  type SelfHostedBrokerNativeConnectionOpenedV2,
  type SelfHostedBrokerNativeConnectionOpenV2,
  type SelfHostedBrokerNativeRedemptionProofV2,
  type SelfHostedBrokerNativeRouteInvitationV2,
  type SelfHostedBrokerNativeScopeV2,
  type SelfHostedBrokerRouteInvitationV1,
  type SelfHostedBrokerScopeV1,
} from '@kontourai/station-contracts/self-hosted-broker';
import { calculateJwkThumbprint, compactVerify, importJWK } from 'jose';

const ID = /^[A-Za-z0-9_-]{8,128}$/;
const SECRET = /^[A-Za-z0-9_-]{43}$/;
const SDP_LIMIT = 128 * 1024;
const INVITATION_MAX_AGE_MS = 5 * 60_000;
const GRANT_MAX_AGE_MS = 30 * 24 * 60 * 60_000;
const NATIVE_GRANT_MAX_AGE_MS = 24 * 60 * 60_000;
const SIGNING_KEY_ID = /^[A-Za-z0-9_-]{43}$/;
const CLIENT_INSTANCE_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const APP_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9.-]{0,254}$/;
type NativeChannel = SelfHostedBrokerNativeClientSurfaceV2['channel'];
const NATIVE_CHANNELS: ReadonlySet<NativeChannel> = new Set([
  'dev',
  'stable',
  'beta',
  'nightly',
]);
function isNativeChannel(value: unknown): value is NativeChannel {
  return (
    typeof value === 'string' && NATIVE_CHANNELS.has(value as NativeChannel)
  );
}

export type BrokerCredential = { id: string; secret: string };
export type BrokerCredentialBundle = {
  connector: BrokerCredential;
  routing: BrokerCredential;
};
interface LeaseRow {
  station_id: string;
  enrollment_id: string;
  generation: number;
  browser_origin: string;
  connector_id: string;
  connector_hash: Uint8Array;
  routing_id: string;
  routing_hash: Uint8Array;
  expires_at: number;
  lease_revision: number;
  last_seen_at: number | null;
  withdrawn_at: number | null;
}
interface InvitationRow {
  invitation_id: string;
  station_id: string;
  enrollment_id: string;
  generation: number;
  browser_origin: string;
  broker_origin: string;
  signing_key_id: string;
  signing_generation: number;
  secret_hash: Uint8Array;
  expires_at: number;
  grant_expires_at: number;
  consumed_at: number | null;
}
interface GrantRow {
  grant_id: string;
  invitation_id: string;
  station_id: string;
  enrollment_id: string;
  generation: number;
  browser_origin: string;
  broker_origin: string;
  signing_key_id: string;
  signing_generation: number;
  secret_hash: Uint8Array;
  issued_at: number;
  expires_at: number;
  revoked_at: number | null;
}
interface NativeInvitationRow {
  invitation_id: string;
  station_id: string;
  enrollment_id: string;
  generation: number;
  broker_origin: string;
  signing_key_id: string;
  signing_generation: number;
  app_identifier: string;
  channel: string;
  client_instance_id: string;
  key_thumbprint: string;
  secret_hash: Uint8Array;
  expires_at: number;
  grant_expires_at: number;
  consumed_at: number | null;
}
interface NativeGrantRow {
  grant_id: string;
  invitation_id: string;
  station_id: string;
  enrollment_id: string;
  generation: number;
  broker_origin: string;
  signing_key_id: string;
  signing_generation: number;
  app_identifier: string;
  channel: string;
  client_instance_id: string;
  key_thumbprint: string;
  proof_public_key: string;
  secret_hash: Uint8Array;
  issued_at: number;
  expires_at: number;
  revoked_at: number | null;
}
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
export function assertSelfHostedBrokerPlatform(platform = process.platform) {
  if (platform === 'win32')
    throw new Error(
      'self_hosted_broker_private_custody_unavailable_on_windows',
    );
  if (process.getuid === undefined)
    throw new Error('self_hosted_broker_private_custody_unavailable');
}
function posixUid() {
  assertSelfHostedBrokerPlatform();
  return process.getuid!();
}
export type BrokerScope = SelfHostedBrokerScopeV1;

function digest(secret: string) {
  return createHash('sha256').update(secret).digest();
}
function grantDigest(secret: string) {
  return digest(`client-grant/v1:${secret}`);
}
function invitationDigest(secret: string) {
  return digest(`route-invitation/v1:${secret}`);
}
function nativeInvitationDigest(secret: string) {
  return digest(`native-route-invitation/v2:${secret}`);
}
function nativeGrantDigest(secret: string) {
  return digest(`native-client-grant/v2:${secret}`);
}
function validateNativeScope(value: unknown): SelfHostedBrokerNativeScopeV2 {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('invalid_native_scope');
  const scope = value as Record<string, unknown>;
  if (
    Object.keys(scope).sort().join(',') !==
    'enrollmentId,routingGeneration,stationId'
  )
    throw new Error('invalid_native_scope');
  if (typeof scope.stationId !== 'string')
    throw new Error('invalid_station_id');
  if (typeof scope.enrollmentId !== 'string')
    throw new Error('invalid_enrollment_id');
  assertText(scope.stationId, 'station_id');
  assertText(scope.enrollmentId, 'enrollment_id');
  if (
    !Number.isSafeInteger(scope.routingGeneration) ||
    (scope.routingGeneration as number) < 1
  )
    throw new Error('invalid_generation');
  return {
    stationId: scope.stationId,
    enrollmentId: scope.enrollmentId,
    routingGeneration: scope.routingGeneration as number,
  };
}
function validateNativeSurface(
  value: unknown,
): SelfHostedBrokerNativeClientSurfaceV2 {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('invalid_native_surface');
  const surface = value as Record<string, unknown>;
  if (
    Object.keys(surface).sort().join(',') !==
    'appIdentifier,channel,clientInstanceId,keyThumbprint,kind'
  )
    throw new Error('invalid_native_surface');
  if (
    surface.kind !== 'station-native' ||
    typeof surface.appIdentifier !== 'string' ||
    !APP_IDENTIFIER.test(surface.appIdentifier) ||
    !isNativeChannel(surface.channel) ||
    typeof surface.clientInstanceId !== 'string' ||
    !CLIENT_INSTANCE_ID.test(surface.clientInstanceId) ||
    typeof surface.keyThumbprint !== 'string' ||
    !SECRET.test(surface.keyThumbprint)
  )
    throw new Error('invalid_native_surface');
  return {
    kind: 'station-native',
    appIdentifier: surface.appIdentifier,
    channel: surface.channel,
    clientInstanceId: surface.clientInstanceId,
    keyThumbprint: surface.keyThumbprint,
  };
}
function validateNativePublicKey(value: unknown) {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('invalid_native_proof');
  const key = value as Record<string, unknown>;
  if (
    Object.keys(key).sort().join(',') !== 'crv,kty,x,y' ||
    key.kty !== 'EC' ||
    key.crv !== 'P-256' ||
    typeof key.x !== 'string' ||
    !SECRET.test(key.x) ||
    typeof key.y !== 'string' ||
    !SECRET.test(key.y)
  )
    throw new Error('invalid_native_proof');
  return {
    jwk: { kty: 'EC' as const, crv: 'P-256' as const, x: key.x, y: key.y },
  };
}
function nativeProofPayload(
  invitation: SelfHostedBrokerNativeRouteInvitationV2,
  nonce: string,
) {
  // Property order is the wire contract. Clients sign these exact UTF-8 bytes
  // with ES256; the invitation secret is represented only by its digest.
  return JSON.stringify({
    aud: 'station-self-hosted-broker',
    purpose: 'redeem-native-route-invitation',
    version: invitation.version,
    brokerOrigin: invitation.brokerOrigin,
    scope: {
      stationId: invitation.scope.stationId,
      enrollmentId: invitation.scope.enrollmentId,
      routingGeneration: invitation.scope.routingGeneration,
    },
    stationSigningKeyId: invitation.stationSigningKeyId,
    stationSigningGeneration: invitation.stationSigningGeneration,
    surface: {
      kind: invitation.surface.kind,
      appIdentifier: invitation.surface.appIdentifier,
      channel: invitation.surface.channel,
      clientInstanceId: invitation.surface.clientInstanceId,
      keyThumbprint: invitation.surface.keyThumbprint,
    },
    invitationId: invitation.invitationId,
    invitationSecretDigest: nativeInvitationDigest(
      invitation.invitationSecret,
    ).toString('base64url'),
    expiresAt: invitation.expiresAt,
    nonce,
  });
}
/** Stable signing bytes for native clients that implement the v2 broker exchange. */
export function serializeNativeBrokerRedemptionPayload(
  invitation: SelfHostedBrokerNativeRouteInvitationV2,
  nonce: string,
): Uint8Array {
  return Buffer.from(nativeProofPayload(invitation, nonce), 'utf8');
}
async function assertNativeProof(
  invitation: SelfHostedBrokerNativeRouteInvitationV2,
  value: unknown,
) {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('invalid_native_proof');
  const proof = value as Record<string, unknown>;
  if (
    Object.keys(proof).sort().join(',') !== 'jws,nonce,publicKey' ||
    typeof proof.nonce !== 'string' ||
    !SECRET.test(proof.nonce) ||
    typeof proof.jws !== 'string' ||
    proof.jws.length > 4096
  )
    throw new Error('invalid_native_proof');
  const { jwk } = validateNativePublicKey(proof.publicKey);
  if ((await calculateJwkThumbprint(jwk)) !== invitation.surface.keyThumbprint)
    throw new Error('invalid_native_proof');
  try {
    const key = await importJWK(jwk, 'ES256');
    const verified = await compactVerify(proof.jws, key, {
      algorithms: ['ES256'],
    });
    if (
      Object.keys(verified.protectedHeader).sort().join(',') !== 'alg,typ' ||
      verified.protectedHeader.alg !== 'ES256' ||
      verified.protectedHeader.typ !== 'station-broker-native-redemption+jws' ||
      !timingSafeEqual(
        Buffer.from(verified.payload),
        Buffer.from(
          serializeNativeBrokerRedemptionPayload(invitation, proof.nonce),
        ),
      )
    )
      throw new Error('invalid_native_proof');
    return jwk;
  } catch {
    throw new Error('invalid_native_proof');
  }
}
function assertPrivateFile(path: string) {
  const file = lstatSync(path);
  if (
    !file.isFile() ||
    file.isSymbolicLink() ||
    file.nlink !== 1 ||
    file.uid !== posixUid() ||
    (file.mode & 0o077) !== 0
  )
    throw new Error('broker_database_must_be_private');
}
function assertText(value: string, name: string) {
  if (!ID.test(value)) throw new Error(`invalid_${name}`);
}
function canonicalBrokerOrigin(value: string) {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('invalid_broker_origin');
  }
  const loopback = ['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname);
  if (
    url.origin !== value ||
    url.pathname !== '/' ||
    url.search ||
    url.hash ||
    url.username ||
    url.password ||
    !(url.protocol === 'https:' || (url.protocol === 'http:' && loopback))
  )
    throw new Error('invalid_broker_origin');
  return url.origin;
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
  return {
    stationId: scope.stationId,
    enrollmentId: scope.enrollmentId,
    routingGeneration: scope.routingGeneration as number,
    browserOrigin: scope.browserOrigin,
  };
}

/** Metadata-only broker authority. It never stores Station credentials, account identity or content. */
export class SelfHostedBrokerService {
  private readonly db: DatabaseSync;
  private nativeConnectionMaintenance: NodeJS.Timeout | undefined;
  constructor(
    path: string,
    private readonly now = () => Date.now(),
  ) {
    assertSelfHostedBrokerPlatform();
    if (!isAbsolute(path))
      throw new Error('broker_database_path_must_be_absolute');
    const parent = lstatSync(dirname(path));
    if (
      !parent.isDirectory() ||
      parent.isSymbolicLink() ||
      parent.uid !== posixUid() ||
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
    if (
      application.application_id !== 0 &&
      application.application_id !== 0x53544252
    ) {
      this.db.close();
      throw new Error('broker_database_schema_refused');
    }
    const version = this.db.prepare('PRAGMA user_version').get() as {
      user_version: number;
    };
    if (![0, 1, 2, 3, 4].includes(version.user_version)) {
      this.db.close();
      throw new Error('broker_database_version_refused');
    }
    if (version.user_version === 0 && tables.count !== 0) {
      this.db.close();
      throw new Error('broker_database_schema_refused');
    }
    if (version.user_version > 0) {
      const expected =
        version.user_version === 1
          ? ['broker_leases', 'broker_connections']
          : [
              'broker_leases',
              'broker_connections',
              'broker_route_invitations',
              'broker_client_grants',
              'broker_connection_owners',
              ...(version.user_version >= 3
                ? [
                    'broker_native_route_invitations',
                    'broker_native_client_grants',
                  ]
                : []),
              ...(version.user_version === 4
                ? ['broker_native_connections']
                : []),
            ];
      const present = this.db
        .prepare("SELECT name FROM sqlite_master WHERE type='table'")
        .all() as { name: string }[];
      if (
        application.application_id !== 0x53544252 ||
        expected.some(
          (name) => !present.some((table) => table.name === name),
        ) ||
        present.some((table) => !expected.includes(table.name))
      ) {
        this.db.close();
        throw new Error('broker_database_schema_refused');
      }
    }
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON');
    // Versions 2, 3 and 4 add only tables. Legacy pending rows have no
    // client-grant owner, so they remain usable solely by the legacy operator
    // routing key. Native grants have separate tables and are never accepted
    // by v1 signaling. DDL and version marker commit together.
    try {
      this.db.exec(`BEGIN IMMEDIATE;
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
      CREATE INDEX IF NOT EXISTS broker_connection_expiry ON broker_connections(expires_at);
      CREATE TABLE IF NOT EXISTS broker_route_invitations(
        invitation_id TEXT PRIMARY KEY, station_id TEXT NOT NULL,
        enrollment_id TEXT NOT NULL, generation INTEGER NOT NULL,
        browser_origin TEXT NOT NULL, broker_origin TEXT NOT NULL,
        signing_key_id TEXT NOT NULL, signing_generation INTEGER NOT NULL,
        secret_hash BLOB NOT NULL, expires_at INTEGER NOT NULL,
        grant_expires_at INTEGER NOT NULL, consumed_at INTEGER);
      CREATE INDEX IF NOT EXISTS broker_invitation_station ON broker_route_invitations(station_id, expires_at);
      CREATE TABLE IF NOT EXISTS broker_client_grants(
        grant_id TEXT PRIMARY KEY, invitation_id TEXT NOT NULL,
        station_id TEXT NOT NULL,
        enrollment_id TEXT NOT NULL, generation INTEGER NOT NULL,
        browser_origin TEXT NOT NULL, broker_origin TEXT NOT NULL,
        signing_key_id TEXT NOT NULL, signing_generation INTEGER NOT NULL,
        secret_hash BLOB NOT NULL, issued_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        revoked_at INTEGER);
      CREATE INDEX IF NOT EXISTS broker_grant_station ON broker_client_grants(station_id, expires_at);
      CREATE TABLE IF NOT EXISTS broker_connection_owners(
        station_id TEXT NOT NULL, client_id TEXT NOT NULL, nonce TEXT NOT NULL,
        grant_id TEXT NOT NULL,
        PRIMARY KEY(station_id, client_id, nonce),
        FOREIGN KEY(station_id, client_id, nonce)
          REFERENCES broker_connections(station_id, client_id, nonce) ON DELETE CASCADE);
      CREATE INDEX IF NOT EXISTS broker_connection_grant ON broker_connection_owners(grant_id);
      CREATE TABLE IF NOT EXISTS broker_native_route_invitations(
        invitation_id TEXT PRIMARY KEY, station_id TEXT NOT NULL,
        enrollment_id TEXT NOT NULL, generation INTEGER NOT NULL,
        broker_origin TEXT NOT NULL, signing_key_id TEXT NOT NULL,
        signing_generation INTEGER NOT NULL, app_identifier TEXT NOT NULL,
        channel TEXT NOT NULL, client_instance_id TEXT NOT NULL,
        key_thumbprint TEXT NOT NULL, secret_hash BLOB NOT NULL,
        expires_at INTEGER NOT NULL, grant_expires_at INTEGER NOT NULL,
        consumed_at INTEGER);
      CREATE INDEX IF NOT EXISTS broker_native_invitation_station
        ON broker_native_route_invitations(station_id, expires_at);
      CREATE TABLE IF NOT EXISTS broker_native_client_grants(
        grant_id TEXT PRIMARY KEY, invitation_id TEXT NOT NULL,
        station_id TEXT NOT NULL, enrollment_id TEXT NOT NULL,
        generation INTEGER NOT NULL, broker_origin TEXT NOT NULL,
        signing_key_id TEXT NOT NULL, signing_generation INTEGER NOT NULL,
        app_identifier TEXT NOT NULL, channel TEXT NOT NULL,
        client_instance_id TEXT NOT NULL, key_thumbprint TEXT NOT NULL,
        proof_public_key TEXT NOT NULL, secret_hash BLOB NOT NULL,
        issued_at INTEGER NOT NULL, expires_at INTEGER NOT NULL,
        revoked_at INTEGER);
      CREATE INDEX IF NOT EXISTS broker_native_grant_station
        ON broker_native_client_grants(station_id, expires_at);
      CREATE TABLE IF NOT EXISTS broker_native_connections(
        station_id TEXT NOT NULL, enrollment_id TEXT NOT NULL,
        generation INTEGER NOT NULL, client_id TEXT NOT NULL, nonce TEXT NOT NULL,
        grant_id TEXT NOT NULL, offer_sdp TEXT NOT NULL, answer_sdp TEXT,
        station_proof TEXT, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL,
        PRIMARY KEY(station_id, client_id, nonce),
        FOREIGN KEY(grant_id) REFERENCES broker_native_client_grants(grant_id));
      CREATE INDEX IF NOT EXISTS broker_native_connection_expiry
        ON broker_native_connections(expires_at);
      CREATE INDEX IF NOT EXISTS broker_native_connection_grant
        ON broker_native_connections(grant_id);
      PRAGMA application_id=1398030930;
      PRAGMA user_version=4;
      COMMIT;`);
    } catch (error) {
      try {
        this.db.exec('ROLLBACK');
      } catch {
        // A failed BEGIN or SQLite's own rollback leaves no active transaction.
      }
      this.db.close();
      throw error;
    }
    for (const suffix of ['-wal', '-shm']) assertPrivateFile(path + suffix);
    this.retireUnavailableNativeConnections();
    this.nativeConnectionMaintenance = setInterval(
      () => this.retireUnavailableNativeConnections(),
      10_000,
    );
    this.nativeConnectionMaintenance.unref();
  }
  close() {
    if (this.nativeConnectionMaintenance) {
      clearInterval(this.nativeConnectionMaintenance);
      this.nativeConnectionMaintenance = undefined;
    }
    this.db.close();
  }
  isOriginAllowed(origin: string) {
    const row = this.db
      .prepare(
        `SELECT 1 allowed FROM broker_leases l
         WHERE l.withdrawn_at IS NULL AND l.expires_at>?
           AND (
             l.browser_origin=?
             OR EXISTS (
               SELECT 1 FROM broker_route_invitations i
               WHERE i.station_id=l.station_id AND i.enrollment_id=l.enrollment_id
                 AND i.generation=l.generation AND i.browser_origin=?
                 AND i.expires_at>? AND i.consumed_at IS NULL
             )
             OR EXISTS (
               SELECT 1 FROM broker_client_grants g
               WHERE g.station_id=l.station_id AND g.enrollment_id=l.enrollment_id
                 AND g.generation=l.generation AND g.browser_origin=?
                 AND g.expires_at>? AND g.revoked_at IS NULL
             )
           ) LIMIT 1`,
      )
      .get(this.now(), origin, origin, this.now(), origin, this.now()) as
      | { allowed: number }
      | undefined;
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
  /** A connector must never receive or finish work after its client grant retires. */
  private retireUnavailableClientConnections() {
    const now = this.now();
    this.db
      .prepare(
        `UPDATE broker_connections
         SET offer_sdp='',answer_sdp=NULL,station_proof=NULL,
             expires_at=MIN(expires_at,?)
         WHERE EXISTS (
          SELECT 1 FROM broker_connection_owners o
          LEFT JOIN broker_client_grants g ON g.grant_id=o.grant_id
          WHERE o.station_id=broker_connections.station_id
            AND o.client_id=broker_connections.client_id
            AND o.nonce=broker_connections.nonce
            AND (g.grant_id IS NULL OR g.revoked_at IS NOT NULL OR g.expires_at<=?)
        )`,
      )
      .run(now, now);
  }
  private retireUnavailableNativeConnections() {
    const now = this.now();
    this.db
      .prepare(
        `UPDATE broker_native_connections
         SET offer_sdp='',answer_sdp=NULL,station_proof=NULL,expires_at=MIN(expires_at,?)
         WHERE (expires_at<=? OR EXISTS (
           SELECT 1 FROM broker_native_client_grants g
           WHERE g.grant_id=broker_native_connections.grant_id
             AND (g.revoked_at IS NOT NULL OR g.expires_at<=?)
         ))
           AND (offer_sdp<>'' OR answer_sdp IS NOT NULL OR station_proof IS NOT NULL)`,
      )
      .run(now, now, now);
    this.db
      .prepare(
        'DELETE FROM broker_native_connections WHERE created_at + 330000 <=?',
      )
      .run(now);
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
        .get(scope.stationId) as LeaseRow | undefined;
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
      expires_at=excluded.expires_at,lease_revision=0,last_seen_at=NULL,withdrawn_at=NULL WHERE excluded.generation > broker_leases.generation`)
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
      if (Number(written.changes) === 1) {
        this.db
          .prepare('DELETE FROM broker_native_connections WHERE station_id=?')
          .run(scope.stationId);
        this.db
          .prepare('DELETE FROM broker_route_invitations WHERE station_id=?')
          .run(scope.stationId);
        this.db
          .prepare('DELETE FROM broker_client_grants WHERE station_id=?')
          .run(scope.stationId);
        this.db
          .prepare(
            'DELETE FROM broker_native_route_invitations WHERE station_id=?',
          )
          .run(scope.stationId);
        this.db
          .prepare('DELETE FROM broker_native_client_grants WHERE station_id=?')
          .run(scope.stationId);
      }
      return { changes: Number(written.changes), idempotent: false };
    });
    if (result.changes !== 1 && !result.idempotent)
      throw new Error('stale_generation');
    return { connector, routing, scope };
  }
  /** The operator owns issuance; invitation possession never approves a Station key. */
  issueInvitation(input: {
    scope: BrokerScope;
    routingCredential: BrokerCredential;
    brokerOrigin: string;
    clientOrigin: string;
    stationSigningKeyId: string;
    stationSigningGeneration: number;
    invitationTtlMs?: number;
    grantTtlMs?: number;
  }): SelfHostedBrokerRouteInvitationV1 {
    const scope = validateBrokerScope(input.scope);
    const brokerOrigin = canonicalBrokerOrigin(input.brokerOrigin);
    const clientScope = validateBrokerScope({
      ...scope,
      browserOrigin: input.clientOrigin,
    });
    if (!SIGNING_KEY_ID.test(input.stationSigningKeyId))
      throw new Error('invalid_signing_key_id');
    if (
      !Number.isSafeInteger(input.stationSigningGeneration) ||
      input.stationSigningGeneration < 1
    )
      throw new Error('invalid_signing_generation');
    const invitationTtlMs = input.invitationTtlMs ?? INVITATION_MAX_AGE_MS;
    const grantTtlMs = input.grantTtlMs ?? GRANT_MAX_AGE_MS;
    if (
      !Number.isSafeInteger(invitationTtlMs) ||
      invitationTtlMs < 1 ||
      invitationTtlMs > INVITATION_MAX_AGE_MS ||
      !Number.isSafeInteger(grantTtlMs) ||
      grantTtlMs < 1 ||
      grantTtlMs > GRANT_MAX_AGE_MS
    )
      throw new Error('invalid_invitation_lifetime');
    const invitationId = randomBytes(16).toString('base64url');
    const invitationSecret = randomBytes(32).toString('base64url');
    return this.transaction(() => {
      this.lease(scope, input.routingCredential, 'routing');
      const now = this.now();
      this.db
        .prepare(
          'DELETE FROM broker_route_invitations WHERE expires_at<=? OR consumed_at IS NOT NULL',
        )
        .run(now);
      const stationCount = (
        this.db
          .prepare(
            'SELECT count(*) n FROM broker_route_invitations WHERE station_id=?',
          )
          .get(scope.stationId) as { n: number }
      ).n;
      const totalCount = (
        this.db
          .prepare('SELECT count(*) n FROM broker_route_invitations')
          .get() as { n: number }
      ).n;
      if (stationCount >= 64 || totalCount >= 1024)
        throw new Error('invitation_limit');
      const expiresAt = now + invitationTtlMs;
      this.db
        .prepare(
          'INSERT INTO broker_route_invitations VALUES(?,?,?,?,?,?,?,?,?,?,?,NULL)',
        )
        .run(
          invitationId,
          scope.stationId,
          scope.enrollmentId,
          scope.routingGeneration,
          clientScope.browserOrigin,
          brokerOrigin,
          input.stationSigningKeyId,
          input.stationSigningGeneration,
          invitationDigest(invitationSecret),
          expiresAt,
          now + grantTtlMs,
        );
      return {
        version: SELF_HOSTED_BROKER_INVITATION_VERSION,
        brokerOrigin,
        scope: clientScope,
        stationSigningKeyId: input.stationSigningKeyId,
        stationSigningGeneration: input.stationSigningGeneration,
        invitationId,
        invitationSecret,
        expiresAt,
      };
    });
  }
  /** Operator issuance binds a routing-only invite to one native proof key. */
  issueNativeInvitation(input: {
    scope: BrokerScope;
    routingCredential: BrokerCredential;
    brokerOrigin: string;
    surface: SelfHostedBrokerNativeClientSurfaceV2;
    stationSigningKeyId: string;
    stationSigningGeneration: number;
    invitationTtlMs?: number;
    grantTtlMs?: number;
  }): SelfHostedBrokerNativeRouteInvitationV2 {
    const scope = validateBrokerScope(input.scope);
    const nativeScope = validateNativeScope({
      stationId: scope.stationId,
      enrollmentId: scope.enrollmentId,
      routingGeneration: scope.routingGeneration,
    });
    const surface = validateNativeSurface(input.surface);
    const brokerOrigin = canonicalBrokerOrigin(input.brokerOrigin);
    if (!SIGNING_KEY_ID.test(input.stationSigningKeyId))
      throw new Error('invalid_signing_key_id');
    if (
      !Number.isSafeInteger(input.stationSigningGeneration) ||
      input.stationSigningGeneration < 1
    )
      throw new Error('invalid_signing_generation');
    const invitationTtlMs = input.invitationTtlMs ?? INVITATION_MAX_AGE_MS;
    const grantTtlMs = input.grantTtlMs ?? NATIVE_GRANT_MAX_AGE_MS;
    if (
      !Number.isSafeInteger(invitationTtlMs) ||
      invitationTtlMs < 1 ||
      invitationTtlMs > INVITATION_MAX_AGE_MS ||
      !Number.isSafeInteger(grantTtlMs) ||
      grantTtlMs < 1 ||
      grantTtlMs > NATIVE_GRANT_MAX_AGE_MS
    )
      throw new Error('invalid_invitation_lifetime');
    const invitationId = randomBytes(16).toString('base64url');
    const invitationSecret = randomBytes(32).toString('base64url');
    return this.transaction(() => {
      this.lease(scope, input.routingCredential, 'routing');
      const now = this.now();
      this.db
        .prepare(
          'DELETE FROM broker_native_route_invitations WHERE expires_at<=? OR consumed_at IS NOT NULL',
        )
        .run(now);
      const stationCount = (
        this.db
          .prepare(
            'SELECT count(*) n FROM broker_native_route_invitations WHERE station_id=?',
          )
          .get(scope.stationId) as { n: number }
      ).n;
      const totalCount = (
        this.db
          .prepare('SELECT count(*) n FROM broker_native_route_invitations')
          .get() as { n: number }
      ).n;
      if (stationCount >= 64 || totalCount >= 1024)
        throw new Error('invitation_limit');
      const expiresAt = now + invitationTtlMs;
      this.db
        .prepare(
          'INSERT INTO broker_native_route_invitations VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,NULL)',
        )
        .run(
          invitationId,
          nativeScope.stationId,
          nativeScope.enrollmentId,
          nativeScope.routingGeneration,
          brokerOrigin,
          input.stationSigningKeyId,
          input.stationSigningGeneration,
          surface.appIdentifier,
          surface.channel,
          surface.clientInstanceId,
          surface.keyThumbprint,
          nativeInvitationDigest(invitationSecret),
          expiresAt,
          now + grantTtlMs,
        );
      return {
        version: SELF_HOSTED_BROKER_NATIVE_INVITATION_VERSION,
        brokerOrigin,
        scope: nativeScope,
        stationSigningKeyId: input.stationSigningKeyId,
        stationSigningGeneration: input.stationSigningGeneration,
        surface,
        invitationId,
        invitationSecret,
        expiresAt,
      };
    });
  }
  /** One-use native redemption; a JWS proof binds the exact invite and install key. */
  async redeemNativeInvitation(
    invitation: SelfHostedBrokerNativeRouteInvitationV2,
    proof: SelfHostedBrokerNativeRedemptionProofV2,
  ): Promise<SelfHostedBrokerNativeClientGrantV2> {
    if (
      !invitation ||
      typeof invitation !== 'object' ||
      Object.keys(invitation).sort().join(',') !==
        'brokerOrigin,expiresAt,invitationId,invitationSecret,scope,stationSigningGeneration,stationSigningKeyId,surface,version' ||
      invitation.version !== SELF_HOSTED_BROKER_NATIVE_INVITATION_VERSION ||
      !ID.test(invitation.invitationId) ||
      !SECRET.test(invitation.invitationSecret) ||
      !SIGNING_KEY_ID.test(invitation.stationSigningKeyId) ||
      !Number.isSafeInteger(invitation.stationSigningGeneration) ||
      invitation.stationSigningGeneration < 1 ||
      !Number.isSafeInteger(invitation.expiresAt)
    )
      throw new Error('invalid_native_invitation');
    const scope = validateNativeScope(invitation.scope);
    const brokerOrigin = canonicalBrokerOrigin(invitation.brokerOrigin);
    const surface = validateNativeSurface(invitation.surface);
    const normalizedInvitation = {
      ...invitation,
      brokerOrigin,
      scope,
      surface,
    };
    const proofPublicKey = await assertNativeProof(normalizedInvitation, proof);
    return this.transaction(() => {
      const row = this.db
        .prepare(
          'SELECT * FROM broker_native_route_invitations WHERE invitation_id=?',
        )
        .get(invitation.invitationId) as NativeInvitationRow | undefined;
      if (
        !row ||
        row.station_id !== scope.stationId ||
        row.enrollment_id !== scope.enrollmentId ||
        row.generation !== scope.routingGeneration ||
        row.broker_origin !== brokerOrigin ||
        row.signing_key_id !== invitation.stationSigningKeyId ||
        row.signing_generation !== invitation.stationSigningGeneration ||
        row.app_identifier !== surface.appIdentifier ||
        row.channel !== surface.channel ||
        row.client_instance_id !== surface.clientInstanceId ||
        row.key_thumbprint !== surface.keyThumbprint ||
        row.expires_at !== invitation.expiresAt ||
        row.consumed_at !== null ||
        row.expires_at <= this.now() ||
        row.grant_expires_at <= this.now() ||
        !timingSafeEqual(
          Buffer.from(row.secret_hash),
          nativeInvitationDigest(invitation.invitationSecret),
        )
      )
        throw new Error('native_invitation_refused');
      const lease = this.db
        .prepare('SELECT * FROM broker_leases WHERE station_id=?')
        .get(scope.stationId) as LeaseRow | undefined;
      if (
        !lease ||
        lease.enrollment_id !== scope.enrollmentId ||
        lease.generation !== scope.routingGeneration ||
        lease.withdrawn_at !== null ||
        lease.expires_at <= this.now()
      )
        throw new Error('native_invitation_refused');
      this.db
        .prepare(
          `DELETE FROM broker_native_connections
           WHERE grant_id IN (
             SELECT grant_id FROM broker_native_client_grants
             WHERE expires_at<=? OR revoked_at IS NOT NULL
           )`,
        )
        .run(this.now());
      this.db
        .prepare(
          'DELETE FROM broker_native_client_grants WHERE expires_at<=? OR revoked_at IS NOT NULL',
        )
        .run(this.now());
      const stationCount = (
        this.db
          .prepare(
            'SELECT count(*) n FROM broker_native_client_grants WHERE station_id=?',
          )
          .get(scope.stationId) as { n: number }
      ).n;
      const totalCount = (
        this.db
          .prepare('SELECT count(*) n FROM broker_native_client_grants')
          .get() as { n: number }
      ).n;
      if (stationCount >= 256 || totalCount >= 4096)
        throw new Error('grant_limit');
      const credential = {
        id: randomBytes(16).toString('base64url'),
        secret: randomBytes(32).toString('base64url'),
      };
      const publicKeyJson = JSON.stringify(proofPublicKey);
      this.db
        .prepare(
          'UPDATE broker_native_route_invitations SET consumed_at=? WHERE invitation_id=? AND consumed_at IS NULL',
        )
        .run(this.now(), invitation.invitationId);
      this.db
        .prepare(
          'INSERT INTO broker_native_client_grants VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,NULL)',
        )
        .run(
          credential.id,
          invitation.invitationId,
          scope.stationId,
          scope.enrollmentId,
          scope.routingGeneration,
          brokerOrigin,
          invitation.stationSigningKeyId,
          invitation.stationSigningGeneration,
          surface.appIdentifier,
          surface.channel,
          surface.clientInstanceId,
          surface.keyThumbprint,
          publicKeyJson,
          nativeGrantDigest(credential.secret),
          this.now(),
          row.grant_expires_at,
        );
      return {
        version: SELF_HOSTED_BROKER_NATIVE_CLIENT_GRANT_VERSION,
        brokerOrigin,
        scope,
        stationSigningKeyId: invitation.stationSigningKeyId,
        stationSigningGeneration: invitation.stationSigningGeneration,
        surface,
        proofPublicKey,
        credential,
        expiresAt: row.grant_expires_at,
      };
    });
  }
  /** One BEGIN IMMEDIATE owns consume and publication; lost responses need a new invite. */
  redeemInvitation(
    invitation: SelfHostedBrokerRouteInvitationV1,
    requestOrigin: string,
  ): SelfHostedBrokerClientGrantV1 {
    if (
      !invitation ||
      typeof invitation !== 'object' ||
      Object.keys(invitation).sort().join(',') !==
        'brokerOrigin,expiresAt,invitationId,invitationSecret,scope,stationSigningGeneration,stationSigningKeyId,version' ||
      invitation.version !== SELF_HOSTED_BROKER_INVITATION_VERSION ||
      !ID.test(invitation.invitationId) ||
      !SECRET.test(invitation.invitationSecret) ||
      !SIGNING_KEY_ID.test(invitation.stationSigningKeyId) ||
      !Number.isSafeInteger(invitation.stationSigningGeneration) ||
      !Number.isSafeInteger(invitation.expiresAt)
    )
      throw new Error('invalid_invitation');
    const scope = validateBrokerScope(invitation.scope);
    const brokerOrigin = canonicalBrokerOrigin(invitation.brokerOrigin);
    if (requestOrigin !== scope.browserOrigin)
      throw new Error('broker_credential_refused');
    return this.transaction(() => {
      const row = this.db
        .prepare('SELECT * FROM broker_route_invitations WHERE invitation_id=?')
        .get(invitation.invitationId) as InvitationRow | undefined;
      if (
        !row ||
        row.station_id !== scope.stationId ||
        row.enrollment_id !== scope.enrollmentId ||
        row.generation !== scope.routingGeneration ||
        row.browser_origin !== scope.browserOrigin ||
        row.broker_origin !== brokerOrigin ||
        row.signing_key_id !== invitation.stationSigningKeyId ||
        row.signing_generation !== invitation.stationSigningGeneration ||
        row.expires_at !== invitation.expiresAt ||
        row.consumed_at !== null ||
        row.expires_at <= this.now() ||
        row.grant_expires_at <= this.now() ||
        !timingSafeEqual(
          Buffer.from(row.secret_hash),
          invitationDigest(invitation.invitationSecret),
        )
      )
        throw new Error('invitation_refused');
      const lease = this.db
        .prepare('SELECT * FROM broker_leases WHERE station_id=?')
        .get(scope.stationId) as LeaseRow | undefined;
      if (
        !lease ||
        lease.enrollment_id !== scope.enrollmentId ||
        lease.generation !== scope.routingGeneration ||
        lease.withdrawn_at !== null ||
        lease.expires_at <= this.now()
      )
        throw new Error('invitation_refused');
      this.db
        .prepare(
          'DELETE FROM broker_client_grants WHERE expires_at<=? OR revoked_at IS NOT NULL',
        )
        .run(this.now());
      const stationCount = (
        this.db
          .prepare(
            'SELECT count(*) n FROM broker_client_grants WHERE station_id=?',
          )
          .get(scope.stationId) as { n: number }
      ).n;
      const totalCount = (
        this.db
          .prepare('SELECT count(*) n FROM broker_client_grants')
          .get() as {
          n: number;
        }
      ).n;
      if (stationCount >= 256 || totalCount >= 4096)
        throw new Error('grant_limit');
      const credential = {
        id: randomBytes(16).toString('base64url'),
        secret: randomBytes(32).toString('base64url'),
      };
      this.db
        .prepare(
          'UPDATE broker_route_invitations SET consumed_at=? WHERE invitation_id=? AND consumed_at IS NULL',
        )
        .run(this.now(), invitation.invitationId);
      this.db
        .prepare(
          'INSERT INTO broker_client_grants VALUES(?,?,?,?,?,?,?,?,?,?,?,?,NULL)',
        )
        .run(
          credential.id,
          invitation.invitationId,
          scope.stationId,
          scope.enrollmentId,
          scope.routingGeneration,
          scope.browserOrigin,
          brokerOrigin,
          invitation.stationSigningKeyId,
          invitation.stationSigningGeneration,
          grantDigest(credential.secret),
          this.now(),
          row.grant_expires_at,
        );
      return {
        version: SELF_HOSTED_BROKER_CLIENT_GRANT_VERSION,
        brokerOrigin,
        scope,
        stationSigningKeyId: invitation.stationSigningKeyId,
        stationSigningGeneration: invitation.stationSigningGeneration,
        credential,
        expiresAt: row.grant_expires_at,
      };
    });
  }
  /** Revokes one client's routing, including unanswered signaling, not Station access. */
  revokeClientGrant(
    scope: BrokerScope,
    routingCredential: BrokerCredential,
    grantId: string,
  ) {
    scope = validateBrokerScope(scope);
    assertText(grantId, 'grant_id');
    this.transaction(() => {
      this.lease(scope, routingCredential, 'routing');
      this.revokeGrantId(scope, grantId);
    });
  }
  /** A client can retire its own routing grant without possessing operator authority. */
  retireOwnClientGrant(scope: BrokerScope, credential: BrokerCredential) {
    scope = validateBrokerScope(scope);
    this.transaction(() => {
      const { grantId } = this.routingOwner(scope, credential);
      if (!grantId) throw new Error('broker_credential_refused');
      this.revokeGrantId(scope, grantId);
    });
  }
  private revokeGrantId(scope: BrokerScope, grantId: string) {
    const changed = this.db
      .prepare(
        'UPDATE broker_client_grants SET revoked_at=? WHERE grant_id=? AND station_id=? AND enrollment_id=? AND generation=? AND revoked_at IS NULL',
      )
      .run(
        this.now(),
        grantId,
        scope.stationId,
        scope.enrollmentId,
        scope.routingGeneration,
      );
    if (changed.changes !== 1) throw new Error('grant_unavailable');
    this.db
      .prepare(
        `UPDATE broker_connections
         SET offer_sdp='',answer_sdp=NULL,station_proof=NULL,
             expires_at=MIN(expires_at,?)
         WHERE (station_id,client_id,nonce) IN
           (SELECT station_id,client_id,nonce FROM broker_connection_owners WHERE grant_id=?)`,
      )
      .run(this.now(), grantId);
  }
  /** Revokes native routing independently from browser grants and Station access. */
  revokeNativeClientGrant(
    scope: BrokerScope,
    routingCredential: BrokerCredential,
    grantId: string,
  ) {
    scope = validateBrokerScope(scope);
    assertText(grantId, 'grant_id');
    this.transaction(() => {
      this.lease(scope, routingCredential, 'routing');
      const changed = this.db
        .prepare(
          'UPDATE broker_native_client_grants SET revoked_at=? WHERE grant_id=? AND station_id=? AND enrollment_id=? AND generation=? AND revoked_at IS NULL',
        )
        .run(
          this.now(),
          grantId,
          scope.stationId,
          scope.enrollmentId,
          scope.routingGeneration,
        );
      if (changed.changes !== 1) throw new Error('grant_unavailable');
      this.retireNativeGrantConnections(grantId);
    });
  }
  /** A native client can retire only its own grant using its bearer credential. */
  retireOwnNativeClientGrant(
    scope: SelfHostedBrokerNativeScopeV2,
    credential: BrokerCredential,
    surface: SelfHostedBrokerNativeClientSurfaceV2,
  ) {
    scope = validateNativeScope(scope);
    surface = validateNativeSurface(surface);
    return this.transaction(() => {
      const { grant } = this.nativeRoutingOwner(
        scope,
        credential,
        surface,
        true,
      );
      if (grant.revoked_at === null) {
        this.db
          .prepare(
            'UPDATE broker_native_client_grants SET revoked_at=? WHERE grant_id=? AND revoked_at IS NULL',
          )
          .run(this.now(), grant.grant_id);
      }
      this.retireNativeGrantConnections(grant.grant_id);
      return { retired: true };
    });
  }
  private retireNativeGrantConnections(grantId: string) {
    const now = this.now();
    this.db
      .prepare(
        `UPDATE broker_native_connections
         SET offer_sdp='',answer_sdp=NULL,station_proof=NULL,
             expires_at=MIN(expires_at,?)
         WHERE grant_id=?`,
      )
      .run(now, grantId);
  }
  /** A native client opens one bounded offer under its exact install grant. */
  openNativeConnection(
    scope: SelfHostedBrokerNativeScopeV2,
    credential: BrokerCredential,
    surface: SelfHostedBrokerNativeClientSurfaceV2,
    input: SelfHostedBrokerNativeConnectionOpenV2,
  ): SelfHostedBrokerNativeConnectionOpenedV2 {
    scope = validateNativeScope(scope);
    surface = validateNativeSurface(surface);
    if (
      !input ||
      input.version !== SELF_HOSTED_BROKER_NATIVE_CONNECTION_OPEN_VERSION
    )
      throw new Error('invalid_native_connection');
    assertText(input.nonce, 'nonce');
    if (
      typeof input.offerSdp !== 'string' ||
      input.offerSdp.length === 0 ||
      Buffer.byteLength(input.offerSdp) > SDP_LIMIT
    )
      throw new Error('offer_too_large');
    return this.transaction(() => {
      const { grant } = this.nativeRoutingOwner(scope, credential, surface);
      const now = this.now();
      this.retireUnavailableNativeConnections();
      const total = (
        this.db
          .prepare(
            'SELECT count(*) n FROM broker_native_connections WHERE expires_at>?',
          )
          .get(now) as { n: number }
      ).n;
      const station = (
        this.db
          .prepare(
            'SELECT count(*) n FROM broker_native_connections WHERE station_id=? AND expires_at>?',
          )
          .get(scope.stationId, now) as { n: number }
      ).n;
      const retained = (
        this.db
          .prepare('SELECT count(*) n FROM broker_native_connections')
          .get() as { n: number }
      ).n;
      if (total >= 1024 || station >= 32 || retained >= 10240)
        throw new Error('pending_limit');
      const clientId = surface.clientInstanceId;
      const replay = this.db
        .prepare(
          'SELECT 1 found FROM broker_native_connections WHERE station_id=? AND client_id=? AND nonce=?',
        )
        .get(scope.stationId, clientId, input.nonce);
      if (replay) throw new Error('connection_replayed');
      const expiresAt = now + 30_000;
      this.db
        .prepare(
          'INSERT INTO broker_native_connections VALUES(?,?,?,?,?,?,?,?,?,?,?)',
        )
        .run(
          scope.stationId,
          scope.enrollmentId,
          scope.routingGeneration,
          clientId,
          input.nonce,
          grant.grant_id,
          input.offerSdp,
          null,
          null,
          now,
          expiresAt,
        );
      return {
        version: SELF_HOSTED_BROKER_NATIVE_CONNECTION_OPENED_VERSION,
        expiresAt,
      };
    });
  }
  /** The native bearer reads only signaling owned by its exact grant and surface. */
  readNativeConnection(
    scope: SelfHostedBrokerNativeScopeV2,
    credential: BrokerCredential,
    surface: SelfHostedBrokerNativeClientSurfaceV2,
    nonce: string,
  ): SelfHostedBrokerNativeConnectionAnswerV2 {
    scope = validateNativeScope(scope);
    surface = validateNativeSurface(surface);
    assertText(nonce, 'nonce');
    const result = this.transaction(() => {
      const { grant } = this.nativeRoutingOwner(
        scope,
        credential,
        surface,
        true,
      );
      this.retireUnavailableNativeConnections();
      if (grant.revoked_at !== null || grant.expires_at <= this.now())
        return { kind: 'refused' as const };
      const row = this.db
        .prepare(
          `SELECT answer_sdp,station_proof,expires_at
           FROM broker_native_connections
           WHERE station_id=? AND enrollment_id=? AND generation=?
             AND client_id=? AND nonce=? AND grant_id=?`,
        )
        .get(
          scope.stationId,
          scope.enrollmentId,
          scope.routingGeneration,
          surface.clientInstanceId,
          nonce,
          grant.grant_id,
        ) as
        | {
            answer_sdp: string | null;
            station_proof: string | null;
            expires_at: number;
          }
        | undefined;
      if (!row || row.expires_at <= this.now())
        return { kind: 'unavailable' as const };
      return {
        kind: 'answer' as const,
        answer: {
          version: SELF_HOSTED_BROKER_NATIVE_CONNECTION_ANSWER_VERSION,
          answerSdp: row.answer_sdp,
          stationProof: row.station_proof,
          expiresAt: row.expires_at,
        },
      };
    });
    if (result.kind === 'refused') throw new Error('broker_credential_refused');
    if (result.kind === 'unavailable')
      throw new Error('connection_unavailable');
    return result.answer;
  }
  /** Only the opted-in Station connector can see native v2 offers. */
  nativeOffers(
    scope: BrokerScope,
    connectorCredential: BrokerCredential,
    surface: SelfHostedBrokerNativeClientSurfaceV2,
    limit = 1,
  ): SelfHostedBrokerNativeConnectionOfferV2[] {
    scope = validateBrokerScope(scope);
    surface = validateNativeSurface(surface);
    // Four maximum-size (128 KiB) offers plus metadata stay below the
    // client's 1 MiB bounded response budget.
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 4)
      throw new Error('invalid_request');
    return this.transaction(() => {
      this.lease(scope, connectorCredential, 'connector');
      this.retireUnavailableNativeConnections();
      const rows = this.db
        .prepare(
          `SELECT c.client_id AS clientId,c.nonce,c.offer_sdp AS offerSdp,
                  c.expires_at AS expiresAt,g.app_identifier AS appIdentifier,
                  g.channel,g.client_instance_id AS clientInstanceId,
                  g.key_thumbprint AS keyThumbprint,
                  g.signing_key_id AS stationSigningKeyId,
                  g.signing_generation AS stationSigningGeneration
           FROM broker_native_connections c
           JOIN broker_native_client_grants g ON g.grant_id=c.grant_id
           WHERE c.station_id=? AND c.enrollment_id=? AND c.generation=?
             AND c.answer_sdp IS NULL AND c.expires_at>?
             AND g.revoked_at IS NULL AND g.expires_at>?
             AND g.app_identifier=? AND g.channel=?
             AND g.client_instance_id=? AND g.key_thumbprint=?
           ORDER BY c.created_at,c.client_id LIMIT ?`,
        )
        .all(
          scope.stationId,
          scope.enrollmentId,
          scope.routingGeneration,
          this.now(),
          this.now(),
          surface.appIdentifier,
          surface.channel,
          surface.clientInstanceId,
          surface.keyThumbprint,
          limit,
        ) as {
        clientId: string;
        nonce: string;
        offerSdp: string;
        expiresAt: number;
        appIdentifier: string;
        channel: SelfHostedBrokerNativeClientSurfaceV2['channel'];
        clientInstanceId: string;
        keyThumbprint: string;
        stationSigningKeyId: string;
        stationSigningGeneration: number;
      }[];
      return rows.map((row) => ({
        version: SELF_HOSTED_BROKER_NATIVE_CONNECTION_OFFER_VERSION,
        scope: {
          stationId: scope.stationId,
          enrollmentId: scope.enrollmentId,
          routingGeneration: scope.routingGeneration,
        },
        surface: {
          kind: 'station-native',
          appIdentifier: row.appIdentifier,
          channel: row.channel,
          clientInstanceId: row.clientInstanceId,
          keyThumbprint: row.keyThumbprint,
        },
        stationSigningKeyId: row.stationSigningKeyId,
        stationSigningGeneration: row.stationSigningGeneration,
        clientId: row.clientId,
        nonce: row.nonce,
        offerSdp: row.offerSdp,
        expiresAt: row.expiresAt,
      }));
    });
  }
  /** Connector answer admission rechecks the exact native surface and grant. */
  answerNativeConnection(
    scope: BrokerScope,
    connectorCredential: BrokerCredential,
    input: {
      version: typeof SELF_HOSTED_BROKER_NATIVE_CONNECTION_ANSWER_VERSION;
      surface: SelfHostedBrokerNativeClientSurfaceV2;
      stationSigningKeyId: string;
      stationSigningGeneration: number;
      clientId: string;
      nonce: string;
      answerSdp: string;
      stationProof: string;
    },
  ) {
    scope = validateBrokerScope(scope);
    const surface = validateNativeSurface(input.surface);
    if (input.version !== SELF_HOSTED_BROKER_NATIVE_CONNECTION_ANSWER_VERSION)
      throw new Error('invalid_native_connection');
    if (
      !SIGNING_KEY_ID.test(input.stationSigningKeyId) ||
      !Number.isSafeInteger(input.stationSigningGeneration) ||
      input.stationSigningGeneration < 1
    )
      throw new Error('invalid_signing_generation');
    assertText(input.clientId, 'client_id');
    assertText(input.nonce, 'nonce');
    if (
      input.clientId !== surface.clientInstanceId ||
      typeof input.answerSdp !== 'string' ||
      input.answerSdp.length === 0 ||
      typeof input.stationProof !== 'string' ||
      input.stationProof.length === 0 ||
      Buffer.byteLength(input.answerSdp) > SDP_LIMIT ||
      Buffer.byteLength(input.stationProof) > STATION_CONNECTION_PROOF_MAX_BYTES
    )
      throw new Error('answer_too_large');
    this.transaction(() => {
      this.lease(scope, connectorCredential, 'connector');
      this.retireUnavailableNativeConnections();
      const changed = this.db
        .prepare(
          `UPDATE broker_native_connections
           SET answer_sdp=?,station_proof=?
           WHERE station_id=? AND enrollment_id=? AND generation=?
             AND client_id=? AND nonce=? AND answer_sdp IS NULL AND expires_at>?
             AND EXISTS (
               SELECT 1 FROM broker_native_client_grants g
               WHERE g.grant_id=broker_native_connections.grant_id
                 AND g.revoked_at IS NULL AND g.expires_at>?
                 AND g.signing_key_id=? AND g.signing_generation=?
                 AND g.app_identifier=? AND g.channel=?
                 AND g.client_instance_id=? AND g.key_thumbprint=?
             )`,
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
          this.now(),
          input.stationSigningKeyId,
          input.stationSigningGeneration,
          surface.appIdentifier,
          surface.channel,
          surface.clientInstanceId,
          surface.keyThumbprint,
        );
      if (changed.changes !== 1) throw new Error('connection_unavailable');
    });
    return { accepted: true };
  }
  /** Native inventory exposes binding metadata and state, never credentials or proof material. */
  listNativeClientGrants(
    scope: BrokerScope,
    routingCredential: BrokerCredential,
  ) {
    scope = validateBrokerScope(scope);
    this.lease(scope, routingCredential, 'routing');
    return this.db
      .prepare(
        `SELECT grant_id AS grantId,invitation_id AS invitationId,
                signing_key_id AS stationSigningKeyId,
                signing_generation AS stationSigningGeneration,
                app_identifier AS appIdentifier,channel,
                client_instance_id AS clientInstanceId,
                key_thumbprint AS keyThumbprint,
                issued_at AS issuedAt,expires_at AS expiresAt,
                revoked_at AS revokedAt
         FROM broker_native_client_grants
         WHERE station_id=? AND enrollment_id=? AND generation=?
         ORDER BY issued_at DESC,grant_id LIMIT 256`,
      )
      .all(scope.stationId, scope.enrollmentId, scope.routingGeneration);
  }
  /** Operator inventory contains identifiers and state, never routing secrets. */
  listClientGrants(scope: BrokerScope, routingCredential: BrokerCredential) {
    scope = validateBrokerScope(scope);
    this.lease(scope, routingCredential, 'routing');
    return this.db
      .prepare(
        `SELECT grant_id AS grantId,invitation_id AS invitationId,
                signing_key_id AS stationSigningKeyId,
                signing_generation AS stationSigningGeneration,
                issued_at AS issuedAt,expires_at AS expiresAt,revoked_at AS revokedAt
         FROM broker_client_grants
         WHERE station_id=? AND enrollment_id=? AND generation=?
         ORDER BY issued_at DESC,grant_id LIMIT 256`,
      )
      .all(scope.stationId, scope.enrollmentId, scope.routingGeneration);
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
      .get(scope.stationId) as LeaseRow | undefined;
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
  /** Operator routing and per-client grants are distinct credential classes. */
  private routingOwner(scope: BrokerScope, credential: BrokerCredential) {
    scope = validateBrokerScope(scope);
    if (
      !credential ||
      typeof credential.id !== 'string' ||
      !ID.test(credential.id) ||
      typeof credential.secret !== 'string' ||
      !SECRET.test(credential.secret)
    )
      throw new Error('broker_credential_refused');
    const lease = this.db
      .prepare('SELECT * FROM broker_leases WHERE station_id=?')
      .get(scope.stationId) as LeaseRow | undefined;
    if (
      !lease ||
      lease.enrollment_id !== scope.enrollmentId ||
      lease.generation !== scope.routingGeneration ||
      lease.withdrawn_at !== null ||
      lease.expires_at <= this.now()
    )
      throw new Error('broker_credential_refused');
    if (credential.id === lease.routing_id) {
      this.lease(scope, credential, 'routing');
      return { lease, grantId: null };
    }
    const grant = this.db
      .prepare('SELECT * FROM broker_client_grants WHERE grant_id=?')
      .get(credential.id) as GrantRow | undefined;
    if (
      !grant ||
      grant.station_id !== scope.stationId ||
      grant.enrollment_id !== scope.enrollmentId ||
      grant.generation !== scope.routingGeneration ||
      grant.browser_origin !== scope.browserOrigin ||
      grant.revoked_at !== null ||
      grant.expires_at <= this.now() ||
      !timingSafeEqual(
        Buffer.from(grant.secret_hash),
        grantDigest(credential.secret),
      )
    )
      throw new Error('broker_credential_refused');
    return { lease, grantId: grant.grant_id };
  }
  private nativeRoutingOwner(
    scope: SelfHostedBrokerNativeScopeV2,
    credential: BrokerCredential,
    surface: SelfHostedBrokerNativeClientSurfaceV2,
    allowRetired = false,
  ) {
    scope = validateNativeScope(scope);
    surface = validateNativeSurface(surface);
    if (
      !credential ||
      typeof credential.id !== 'string' ||
      !ID.test(credential.id) ||
      typeof credential.secret !== 'string' ||
      !SECRET.test(credential.secret)
    )
      throw new Error('broker_credential_refused');
    const lease = this.db
      .prepare('SELECT * FROM broker_leases WHERE station_id=?')
      .get(scope.stationId) as LeaseRow | undefined;
    if (
      !lease ||
      lease.enrollment_id !== scope.enrollmentId ||
      lease.generation !== scope.routingGeneration ||
      lease.withdrawn_at !== null ||
      lease.expires_at <= this.now()
    )
      throw new Error('broker_credential_refused');
    const grant = this.db
      .prepare('SELECT * FROM broker_native_client_grants WHERE grant_id=?')
      .get(credential.id) as NativeGrantRow | undefined;
    if (
      !grant ||
      grant.station_id !== scope.stationId ||
      grant.enrollment_id !== scope.enrollmentId ||
      grant.generation !== scope.routingGeneration ||
      grant.app_identifier !== surface.appIdentifier ||
      grant.channel !== surface.channel ||
      grant.client_instance_id !== surface.clientInstanceId ||
      grant.key_thumbprint !== surface.keyThumbprint ||
      (!allowRetired && grant.revoked_at !== null) ||
      (!allowRetired && grant.expires_at <= this.now()) ||
      !timingSafeEqual(
        Buffer.from(grant.secret_hash),
        nativeGrantDigest(credential.secret),
      )
    )
      throw new Error('broker_credential_refused');
    return { lease, grant };
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
      const next = this.now() + ttlMs;
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
      const lease = this.lease(scope, credential, 'connector');
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
      return {
        registeredAt: this.now(),
        revision: lease.lease_revision,
        expiresAt: lease.expires_at,
      };
    });
  }
  status(scope: BrokerScope, credential: BrokerCredential) {
    const { lease } = this.routingOwner(scope, credential);
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
      this.db
        .prepare('DELETE FROM broker_route_invitations WHERE station_id=?')
        .run(scope.stationId);
      this.db
        .prepare('DELETE FROM broker_client_grants WHERE station_id=?')
        .run(scope.stationId);
      this.db
        .prepare(
          'DELETE FROM broker_native_route_invitations WHERE station_id=?',
        )
        .run(scope.stationId);
      this.db
        .prepare('DELETE FROM broker_native_connections WHERE station_id=?')
        .run(scope.stationId);
      this.db
        .prepare('DELETE FROM broker_native_client_grants WHERE station_id=?')
        .run(scope.stationId);
    });
  }
  open(
    scope: BrokerScope,
    credential: BrokerCredential,
    input: { clientId: string; nonce: string; offerSdp: string },
  ) {
    return this.transaction(() => {
      const { grantId: owner } = this.routingOwner(scope, credential);
      assertText(input.clientId, 'client_id');
      assertText(input.nonce, 'nonce');
      if (
        typeof input.offerSdp !== 'string' ||
        input.offerSdp.length === 0 ||
        Buffer.byteLength(input.offerSdp) > SDP_LIMIT
      )
        throw new Error('offer_too_large');
      const now = this.now();
      this.db
        .prepare(
          "UPDATE broker_connections SET offer_sdp='',answer_sdp=NULL,station_proof=NULL WHERE expires_at<=? AND offer_sdp<>''",
        )
        .run(now);
      this.db
        .prepare('DELETE FROM broker_connections WHERE created_at + 330000 <=?')
        .run(now);
      const total = (
        this.db
          .prepare(
            'SELECT count(*) n FROM broker_connections WHERE expires_at>?',
          )
          .get(now) as { n: number }
      ).n;
      const station = (
        this.db
          .prepare(
            'SELECT count(*) n FROM broker_connections WHERE station_id=? AND expires_at>?',
          )
          .get(scope.stationId, now) as { n: number }
      ).n;
      const retained = (
        this.db.prepare('SELECT count(*) n FROM broker_connections').get() as {
          n: number;
        }
      ).n;
      if (total >= 1024 || station >= 32 || retained >= 10240)
        throw new Error('pending_limit');
      const replay = this.db
        .prepare(
          'SELECT 1 found FROM broker_connections WHERE station_id=? AND client_id=? AND nonce=?',
        )
        .get(scope.stationId, input.clientId, input.nonce);
      if (replay) throw new Error('connection_replayed');
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
      if (owner)
        this.db
          .prepare('INSERT INTO broker_connection_owners VALUES(?,?,?,?)')
          .run(scope.stationId, input.clientId, input.nonce, owner);
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
    return this.transaction(() => {
      this.lease(scope, credential, 'connector');
      this.retireUnavailableClientConnections();
      if (
        typeof input.answerSdp !== 'string' ||
        input.answerSdp.length === 0 ||
        typeof input.stationProof !== 'string' ||
        input.stationProof.length === 0 ||
        Buffer.byteLength(input.answerSdp) > SDP_LIMIT ||
        Buffer.byteLength(input.stationProof) >
          STATION_CONNECTION_PROOF_MAX_BYTES
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
    });
  }
  offers(scope: BrokerScope, credential: BrokerCredential, limit = 32) {
    return this.transaction(() => {
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 32)
        throw new Error('invalid_request');
      this.lease(scope, credential, 'connector');
      this.retireUnavailableClientConnections();
      const now = this.now();
      this.db
        .prepare(
          "UPDATE broker_connections SET offer_sdp='',answer_sdp=NULL,station_proof=NULL WHERE expires_at<=? AND offer_sdp<>''",
        )
        .run(now);
      return this.db
        .prepare(`SELECT c.client_id AS clientId,c.nonce,c.offer_sdp AS offerSdp,
                         c.expires_at AS expiresAt,
                         COALESCE(g.browser_origin,?) AS browserOrigin
      FROM broker_connections c
      LEFT JOIN broker_connection_owners o
        ON o.station_id=c.station_id AND o.client_id=c.client_id AND o.nonce=c.nonce
      LEFT JOIN broker_client_grants g ON g.grant_id=o.grant_id
      WHERE c.station_id=? AND c.enrollment_id=? AND c.generation=?
        AND c.answer_sdp IS NULL AND c.expires_at>?
      ORDER BY c.created_at,c.client_id LIMIT ?`)
        .all(
          scope.browserOrigin,
          scope.stationId,
          scope.enrollmentId,
          scope.routingGeneration,
          now,
          limit,
        );
    });
  }
  read(
    scope: BrokerScope,
    credential: BrokerCredential,
    clientId: string,
    nonce: string,
  ) {
    return this.transaction(() => {
      const { grantId: owner } = this.routingOwner(scope, credential);
      const row = this.db
        .prepare(
          `SELECT c.answer_sdp,c.station_proof,c.expires_at,o.grant_id
           FROM broker_connections c LEFT JOIN broker_connection_owners o
           ON o.station_id=c.station_id AND o.client_id=c.client_id AND o.nonce=c.nonce
           WHERE c.station_id=? AND c.enrollment_id=? AND c.generation=? AND c.client_id=? AND c.nonce=?`,
        )
        .get(
          scope.stationId,
          scope.enrollmentId,
          scope.routingGeneration,
          clientId,
          nonce,
        ) as
        | {
            answer_sdp: string | null;
            station_proof: string | null;
            expires_at: number;
            grant_id: string | null;
          }
        | undefined;
      if (!row || row.expires_at <= this.now() || row.grant_id !== owner)
        throw new Error('connection_unavailable');
      return {
        answerSdp: row.answer_sdp,
        stationProof: row.station_proof,
        expiresAt: row.expires_at,
      };
    });
  }
}
