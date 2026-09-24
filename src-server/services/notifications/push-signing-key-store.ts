/**
 * Custody of the Station's push signing key: `security/push-signing-key.json`
 * (0600), a P-256 key used ONLY to sign requests to the Kontour push gateway
 * (docs/design/notification-delivery.md, "Station contract").
 *
 * Domain-separated from `connection-signing-key.json` on purpose: that key's
 * tokens are connection proofs, not a general signature, and a gateway
 * request must never be something a connection proof could be replayed as
 * (or vice versa). The custody discipline is copied from
 * `ConnectionSigningKeyStore`: descriptor-bound guarded reads (no symlink, no
 * hard link, exact mode, size cap), and an atomic 0600 publish under the
 * shared file mutation lock.
 *
 * Created lazily on the first native-push registration, never at startup:
 * a Station nobody registered a phone with holds no push key at all.
 */
import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  type KeyObject,
  randomUUID,
  sign,
} from 'node:crypto';
import { join } from 'node:path';
import { assertExistingSecurityDirectory } from '@kontourai/station-shared/environment-security-record';
import { mutateJsonFileWithGuardedRead } from '@kontourai/station-shared/json-file-storage';
import { readPrivateJsonFile } from './private-json-file.js';

const FILE_NAME = 'push-signing-key.json';
const MAX_RECORD_BYTES = 4096;
/** Mirrors the gateway's `PUSH_JWT_TYPE` (deploy/push-gateway/src/station-auth.ts). */
export const PUSH_JWT_TYPE = 'station-push+jwt';
/** The gateway accepts at most 120 s; a short lifetime bounds a captured token. */
const TOKEN_LIFETIME_SECONDS = 60;
// SubjectPublicKeyInfo DER for a P-256 key ends in the 65-byte uncompressed
// point 0x04 || x || y. Reading it from there gives fixed 32-byte
// coordinates, which is the only encoding the gateway accepts.
const UNCOMPRESSED_POINT_BYTES = 65;

interface PrivateRecord {
  schemaVersion: 1;
  stationId: string;
  privateKeyPem: string;
  createdAt: number;
}

export interface PushPublicJwk {
  kty: 'EC';
  crv: 'P-256';
  x: string;
  y: string;
}

export interface PushSigningKey {
  readonly publicJwk: PushPublicJwk;
  /** RFC 7638 thumbprint: the identity the gateway stamps as `station_key`. */
  readonly thumbprint: string;
  /**
   * An ES256 JWS binding `body` (exact bytes) to `audience` for 60 seconds.
   * Send it as `Authorization: Station <jws>`.
   */
  signRequest(
    body: Uint8Array,
    input: { audience: string; nowMs: number },
  ): string;
}

class PushSigningKeyStoreError extends Error {
  constructor(readonly code: 'key_store_invalid') {
    super(`Station push signing key unavailable: ${code}`);
  }
}

function base64Url(value: Buffer | Uint8Array | string): string {
  return Buffer.from(value).toString('base64url');
}

/** RFC 7638 thumbprint over the required members in lexicographic order. */
export function pushJwkThumbprint(jwk: PushPublicJwk): string {
  const canonical = `{"crv":"${jwk.crv}","kty":"${jwk.kty}","x":"${jwk.x}","y":"${jwk.y}"}`;
  return createHash('sha256').update(canonical).digest('base64url');
}

function publicJwkOf(privateKey: KeyObject): PushPublicJwk {
  const spki = createPublicKey(privateKey).export({
    format: 'der',
    type: 'spki',
  });
  const point = spki.subarray(spki.length - UNCOMPRESSED_POINT_BYTES);
  if (point.length !== UNCOMPRESSED_POINT_BYTES || point[0] !== 0x04)
    throw new Error('unsupported public key');
  return {
    kty: 'EC',
    crv: 'P-256',
    x: base64Url(point.subarray(1, 33)),
    y: base64Url(point.subarray(33, 65)),
  };
}

function materialize(record: PrivateRecord): PushSigningKey {
  const privateKey = createPrivateKey(record.privateKeyPem);
  if (
    privateKey.asymmetricKeyType !== 'ec' ||
    privateKey.asymmetricKeyDetails?.namedCurve !== 'prime256v1'
  )
    throw new Error('unsupported key');
  const publicJwk = publicJwkOf(privateKey);
  const encodedHeader = base64Url(
    JSON.stringify({ alg: 'ES256', typ: PUSH_JWT_TYPE, jwk: publicJwk }),
  );
  return Object.freeze({
    publicJwk: Object.freeze({ ...publicJwk }),
    thumbprint: pushJwkThumbprint(publicJwk),
    signRequest(body: Uint8Array, input: { audience: string; nowMs: number }) {
      const iat = Math.floor(input.nowMs / 1000);
      const claims = {
        aud: input.audience,
        iat,
        exp: iat + TOKEN_LIFETIME_SECONDS,
        jti: randomUUID(),
        bsh: createHash('sha256').update(body).digest('base64url'),
      };
      const signingInput = `${encodedHeader}.${base64Url(JSON.stringify(claims))}`;
      // JWS ES256 is the raw r||s form, not DER.
      const signature = sign('sha256', Buffer.from(signingInput), {
        key: privateKey,
        dsaEncoding: 'ieee-p1363',
      });
      return `${signingInput}.${base64Url(signature)}`;
    },
  });
}

/**
 * Station-local custody only. The public JWK and thumbprint are safe to hand
 * to a paired phone; the private key never leaves this file.
 */
export class PushSigningKeyStore {
  readonly #directory: string;
  readonly #path: string;
  readonly #stationId: () => string;

  /**
   * `stationId` is read per operation: a key minted for one environment is
   * never used to sign for another (an environment reset replaces the key,
   * together with every registration that pinned the old one).
   */
  constructor(homeDir: string, stationId: () => string) {
    this.#directory = join(homeDir, 'security');
    this.#path = join(this.#directory, FILE_NAME);
    this.#stationId = stationId;
  }

  /** Throws on a present but unsafe/corrupt file; null when there is none. */
  #readRecord(): PrivateRecord | null {
    assertExistingSecurityDirectory(this.#directory);
    let value: unknown;
    try {
      value = readPrivateJsonFile(
        this.#path,
        MAX_RECORD_BYTES,
        'Station push signing key',
      );
    } catch {
      throw new PushSigningKeyStoreError('key_store_invalid');
    }
    if (value === null) return null;
    try {
      if (!value || typeof value !== 'object' || Array.isArray(value))
        throw new Error('invalid record');
      const record = value as PrivateRecord;
      if (
        Object.keys(record).sort().join(',') !==
          'createdAt,privateKeyPem,schemaVersion,stationId' ||
        record.schemaVersion !== 1 ||
        typeof record.stationId !== 'string' ||
        record.stationId.length === 0 ||
        !Number.isSafeInteger(record.createdAt) ||
        record.createdAt < 0 ||
        typeof record.privateKeyPem !== 'string' ||
        record.privateKeyPem.length > 2048
      )
        throw new Error('invalid record');
      // Parse now so a present-but-broken key is refused, not deferred.
      materialize(record);
      return record;
    } catch {
      // Parser/crypto errors can carry private input; never attach them.
      throw new PushSigningKeyStoreError('key_store_invalid');
    }
  }

  /**
   * The current Station's key, or null when none was created yet (or the
   * file belongs to a previous environment). Reloaded on every call, so a
   * replaced key is never signed with from a stale cache.
   */
  read(): PushSigningKey | null {
    const record = this.#readRecord();
    if (!record || record.stationId !== this.#stationId()) return null;
    return materialize(record);
  }

  /** Returns the existing key, creating it on first use. */
  async loadOrCreate(): Promise<PushSigningKey> {
    const existing = this.read();
    if (existing) return existing;
    const stationId = this.#stationId();
    const committed = await mutateJsonFileWithGuardedRead<PrivateRecord | null>(
      this.#path,
      null,
      async () => this.#readRecord(),
      (current) => {
        if (current && current.stationId === stationId) return current;
        const keys = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
        return {
          schemaVersion: 1,
          stationId,
          privateKeyPem: keys.privateKey
            .export({ format: 'pem', type: 'pkcs8' })
            .toString(),
          createdAt: Date.now(),
        };
      },
      {
        maxBytes: MAX_RECORD_BYTES,
        label: 'Station push signing key',
        beforeCommit: () => {
          assertExistingSecurityDirectory(this.#directory);
        },
      },
    );
    if (!committed) throw new PushSigningKeyStoreError('key_store_invalid');
    return materialize(committed);
  }
}
