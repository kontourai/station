import {
  type ApprovedStationConnectionTrust,
  STATION_CONNECTION_PROOF_AUDIENCE,
  STATION_CONNECTION_PROOF_LIFETIME_SECONDS,
  STATION_CONNECTION_PROOF_MAX_BYTES,
  STATION_CONNECTION_PROOF_TYPE,
  type StationConnectionProofBinding,
} from '@kontourai/station-contracts/connection-proof';
import {
  base64url,
  calculateJwkThumbprint,
  importJWK,
  jwtVerify,
  SignJWT,
} from 'jose';
import { randomCorrelationId } from './random-id.js';

const BINDING_FIELDS = [
  'stationId',
  'enrollmentId',
  'generation',
  'connectionId',
  'clientNonce',
  'clientFingerprint',
  'stationFingerprint',
  'offerSha256',
  'answerSha256',
] as const;
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const DIGEST = /^[A-Za-z0-9_-]{43}$/;
const FINGERPRINT = /^(?:[0-9A-F]{2}:){31}[0-9A-F]{2}$/;

export class ConnectionProofError extends Error {
  readonly code = 'connection_proof_refused';
  constructor() {
    super('Station connection proof refused');
  }
}

function refuse(): never {
  throw new ConnectionProofError();
}
function exactFields(
  value: unknown,
  keys: readonly string[],
): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    return refuse();
  const actual = Object.keys(value);
  if (
    actual.length !== keys.length ||
    actual.some((key) => !keys.includes(key))
  )
    return refuse();
  return value as Record<string, unknown>;
}

/** Copy a closed transport binding; do not retain caller-owned mutable objects. */
export function copyConnectionProofBinding(
  value: unknown,
): StationConnectionProofBinding {
  const raw = { ...exactFields(value, BINDING_FIELDS) };
  for (const name of ['stationId', 'enrollmentId', 'connectionId'])
    if (typeof raw[name] !== 'string' || !UUID.test(raw[name])) return refuse();
  for (const name of ['clientNonce', 'offerSha256', 'answerSha256'])
    if (typeof raw[name] !== 'string' || !DIGEST.test(raw[name]))
      return refuse();
  for (const name of ['clientFingerprint', 'stationFingerprint'])
    if (typeof raw[name] !== 'string' || !FINGERPRINT.test(raw[name]))
      return refuse();
  if (!Number.isSafeInteger(raw.generation) || (raw.generation as number) < 1)
    return refuse();
  return Object.freeze({ ...raw }) as unknown as StationConnectionProofBinding;
}

export function copyStationConnectionTrust(
  value: ApprovedStationConnectionTrust,
): ApprovedStationConnectionTrust {
  const raw = {
    ...exactFields(value, [
      'stationId',
      'enrollmentId',
      'generation',
      'signingKey',
    ]),
  };
  const key = { ...exactFields(raw.signingKey, ['kty', 'crv', 'x', 'y']) };
  if (
    key.kty !== 'EC' ||
    key.crv !== 'P-256' ||
    typeof key.x !== 'string' ||
    typeof key.y !== 'string' ||
    !DIGEST.test(key.x) ||
    !DIGEST.test(key.y) ||
    typeof raw.stationId !== 'string' ||
    !UUID.test(raw.stationId) ||
    typeof raw.enrollmentId !== 'string' ||
    !UUID.test(raw.enrollmentId) ||
    !Number.isSafeInteger(raw.generation) ||
    (raw.generation as number) < 1
  )
    return refuse();
  return Object.freeze({
    stationId: raw.stationId,
    enrollmentId: raw.enrollmentId,
    generation: raw.generation as number,
    signingKey: Object.freeze({ kty: 'EC', crv: 'P-256', x: key.x, y: key.y }),
  });
}

/** Public-key identifier, not an assertion that its source is trusted. */
export async function stationConnectionSigningKeyId(
  value: ApprovedStationConnectionTrust,
): Promise<string> {
  const trust = copyStationConnectionTrust(value);
  try {
    await importJWK(trust.signingKey, 'ES256');
    return await calculateJwkThumbprint(trust.signingKey);
  } catch {
    return refuse();
  }
}

function sameEnrollment(
  binding: StationConnectionProofBinding,
  trust: ApprovedStationConnectionTrust,
) {
  return (
    binding.stationId === trust.stationId &&
    binding.enrollmentId === trust.enrollmentId &&
    binding.generation === trust.generation
  );
}

/** SHA-256 over the exact SDP bytes, without normalizing transport metadata. */
export async function connectionDescriptionDigest(
  description: string,
): Promise<string> {
  if (typeof description !== 'string' || description.length > 64 * 1024)
    return refuse();
  const bytes = new TextEncoder().encode(description);
  if (bytes.length > 64 * 1024) return refuse();
  return base64url.encode(
    new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)),
  );
}

/** Cryptographic primitive only. The Station issuer owns current admission. */
export async function signStationConnectionProof(input: {
  trust: ApprovedStationConnectionTrust;
  binding: StationConnectionProofBinding;
  signingKey: Parameters<SignJWT['sign']>[0];
  now: number;
}): Promise<string> {
  const trust = copyStationConnectionTrust(input.trust);
  const binding = copyConnectionProofBinding(input.binding);
  const now = input.now;
  const signingKey = input.signingKey;
  if (!sameEnrollment(binding, trust) || !Number.isSafeInteger(now) || now < 0)
    return refuse();
  const kid = await calculateJwkThumbprint(trust.signingKey, 'sha256');
  return (
    new SignJWT({ version: 1, binding })
      .setProtectedHeader({
        alg: 'ES256',
        typ: STATION_CONNECTION_PROOF_TYPE,
        kid,
      })
      .setIssuer(`urn:station:${trust.stationId}`)
      .setAudience(STATION_CONNECTION_PROOF_AUDIENCE)
      // This is a correlation ID, not a credential or secret challenge. The
      // independently generated client nonce and exact binding prevent replay.
      .setJti(randomCorrelationId())
      .setIssuedAt(now)
      .setNotBefore(now)
      .setExpirationTime(now + STATION_CONNECTION_PROOF_LIFETIME_SECONDS)
      .sign(signingKey)
  );
}

/**
 * One expected handshake, one successful consumption. Trust and expectations
 * must come from their local owners, never from the broker's token payload.
 * Invalid attempts do not consume the challenge. Concurrent valid attempts
 * cannot both succeed after asynchronous signature verification.
 */
export function createStationConnectionProofVerifier(input: {
  trust: ApprovedStationConnectionTrust;
  expected: StationConnectionProofBinding;
  now?: () => number;
  isCurrent: () => boolean;
}) {
  const trust = copyStationConnectionTrust(input.trust);
  const expected = copyConnectionProofBinding(input.expected);
  if (!sameEnrollment(expected, trust)) return refuse();
  const now = input.now ?? (() => Math.floor(Date.now() / 1000));
  const isCurrent = input.isCurrent;
  let consumed = false;
  let validity: { notBefore: number; expiresAt: number } | undefined;
  return Object.freeze({
    /** Recheck an already verified handshake after a caller's additional await. */
    assertStillCurrent(): void {
      try {
        const current = now();
        if (
          !consumed ||
          !validity ||
          isCurrent() !== true ||
          !Number.isSafeInteger(current) ||
          current < validity.notBefore ||
          current >= validity.expiresAt
        )
          refuse();
      } catch {
        refuse();
      }
    },
    async verifyAndConsume(
      token: string,
    ): Promise<StationConnectionProofBinding> {
      try {
        if (
          consumed ||
          isCurrent() !== true ||
          typeof token !== 'string' ||
          token.length > STATION_CONNECTION_PROOF_MAX_BYTES ||
          !/^[A-Za-z0-9_.-]+$/.test(token)
        )
          return refuse();
        const time = now();
        if (!Number.isSafeInteger(time) || time < 0) return refuse();
        const key = await importJWK(trust.signingKey, 'ES256');
        const { payload, protectedHeader } = await jwtVerify(token, key, {
          algorithms: ['ES256'],
          typ: STATION_CONNECTION_PROOF_TYPE,
          issuer: `urn:station:${trust.stationId}`,
          audience: STATION_CONNECTION_PROOF_AUDIENCE,
          requiredClaims: ['iat', 'nbf', 'exp', 'jti'],
          maxTokenAge: STATION_CONNECTION_PROOF_LIFETIME_SECONDS,
          currentDate: new Date(time * 1000),
          clockTolerance: 0,
        });
        exactFields(protectedHeader, ['alg', 'typ', 'kid']);
        if (
          protectedHeader.kid !==
          (await calculateJwkThumbprint(trust.signingKey, 'sha256'))
        )
          return refuse();
        exactFields(payload, [
          'version',
          'binding',
          'iss',
          'aud',
          'iat',
          'nbf',
          'exp',
          'jti',
        ]);
        if (
          payload.version !== 1 ||
          typeof payload.jti !== 'string' ||
          !UUID.test(payload.jti) ||
          !Number.isSafeInteger(payload.iat) ||
          !Number.isSafeInteger(payload.exp) ||
          payload.nbf !== payload.iat ||
          payload.exp !==
            (payload.iat as number) +
              STATION_CONNECTION_PROOF_LIFETIME_SECONDS ||
          payload.aud !== STATION_CONNECTION_PROOF_AUDIENCE
        )
          return refuse();
        const binding = copyConnectionProofBinding(payload.binding);
        if (BINDING_FIELDS.some((field) => binding[field] !== expected[field]))
          return refuse();
        // Recheck authority and expiry after every asynchronous crypto operation.
        const current = now();
        if (
          consumed ||
          isCurrent() !== true ||
          !Number.isSafeInteger(current) ||
          current < (payload.iat as number) ||
          current >= (payload.exp as number)
        )
          return refuse();
        consumed = true;
        validity = {
          notBefore: payload.iat as number,
          expiresAt: payload.exp as number,
        };
        return binding;
      } catch {
        return refuse();
      }
    },
  });
}
