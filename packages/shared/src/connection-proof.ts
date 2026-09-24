import {
  type ApprovedStationConnectionTrust,
  STATION_CONNECTION_KEY_CANDIDATE_AUDIENCE,
  STATION_CONNECTION_KEY_CANDIDATE_LIFETIME_SECONDS,
  STATION_CONNECTION_KEY_CANDIDATE_PURPOSE,
  STATION_CONNECTION_KEY_CANDIDATE_TYPE,
  STATION_CONNECTION_KEY_CANDIDATE_VERSION,
  STATION_CONNECTION_PROOF_AUDIENCE,
  STATION_CONNECTION_PROOF_LIFETIME_SECONDS,
  STATION_CONNECTION_PROOF_MAX_BYTES,
  STATION_CONNECTION_PROOF_TYPE,
  type StationConnectionKeyCandidateClaimsV1,
  type StationConnectionKeyCandidateExpectationV1,
  type StationConnectionKeyCandidateV1,
  type StationConnectionKeyDescriptorV1,
  type StationConnectionProofBinding,
  type VerifiedStationConnectionKeyCandidateV1,
} from '@kontourai/station-contracts/connection-proof';
import {
  base64url,
  calculateJwkThumbprint,
  compactVerify,
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
const CANDIDATE_CODE_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const BROKER_CHALLENGE = /^[A-Za-z0-9_-]{43}$/;

function isCanonicalSha256Base64Url(value: unknown): value is string {
  if (typeof value !== 'string' || !DIGEST.test(value)) return false;
  try {
    const decoded = base64url.decode(value);
    return decoded.byteLength === 32 && base64url.encode(decoded) === value;
  } catch {
    return false;
  }
}

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

function candidateBrokerOrigin(value: unknown): string {
  if (typeof value !== 'string' || value.length > 2048) return refuse();
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return refuse();
  }
  const loopback = ['localhost', '127.0.0.1', '[::1]', '::1'].includes(
    url.hostname.toLowerCase(),
  );
  if (
    url.origin !== value ||
    url.pathname !== '/' ||
    url.search ||
    url.hash ||
    url.username ||
    url.password ||
    !(url.protocol === 'https:' || (url.protocol === 'http:' && loopback))
  )
    return refuse();
  return value;
}

const CANDIDATE_CLAIM_FIELDS = [
  'aud',
  'brokerOrigin',
  'challenge',
  'clientInstanceId',
  'clientKeyThumbprint',
  'confirmationCode',
  'exp',
  'iat',
  'keyId',
  'purpose',
  'candidate',
  'version',
] as const;

/** Copies and validates the closed Station-key candidate payload. */
export function copyStationConnectionKeyCandidateClaims(
  value: unknown,
): StationConnectionKeyCandidateClaimsV1 {
  const raw = exactFields(value, CANDIDATE_CLAIM_FIELDS);
  const candidate = copyStationConnectionTrust(
    raw.candidate as StationConnectionKeyDescriptorV1,
  );
  if (
    raw.version !== STATION_CONNECTION_KEY_CANDIDATE_VERSION ||
    raw.aud !== STATION_CONNECTION_KEY_CANDIDATE_AUDIENCE ||
    raw.purpose !== STATION_CONNECTION_KEY_CANDIDATE_PURPOSE ||
    typeof raw.challenge !== 'string' ||
    !BROKER_CHALLENGE.test(raw.challenge) ||
    !isCanonicalSha256Base64Url(raw.challenge) ||
    typeof raw.clientInstanceId !== 'string' ||
    !UUID.test(raw.clientInstanceId) ||
    !isCanonicalSha256Base64Url(raw.clientKeyThumbprint) ||
    typeof raw.confirmationCode !== 'string' ||
    !/^[0-9A-HJKMNP-TV-Z]{16}$/.test(raw.confirmationCode) ||
    typeof raw.keyId !== 'string' ||
    !DIGEST.test(raw.keyId) ||
    !Number.isSafeInteger(raw.iat) ||
    (raw.iat as number) < 0 ||
    !Number.isSafeInteger(raw.exp) ||
    (raw.exp as number) < 0
  )
    return refuse();
  return Object.freeze({
    version: STATION_CONNECTION_KEY_CANDIDATE_VERSION,
    aud: STATION_CONNECTION_KEY_CANDIDATE_AUDIENCE,
    purpose: STATION_CONNECTION_KEY_CANDIDATE_PURPOSE,
    brokerOrigin: candidateBrokerOrigin(raw.brokerOrigin),
    challenge: raw.challenge as string,
    clientInstanceId: raw.clientInstanceId,
    clientKeyThumbprint: raw.clientKeyThumbprint,
    confirmationCode: raw.confirmationCode,
    candidate,
    keyId: raw.keyId,
    iat: raw.iat as number,
    exp: raw.exp as number,
  });
}

/** Canonical UTF-8 wire bytes shared by the Station signer and verifiers. */
export function serializeStationConnectionKeyCandidateClaims(
  value: StationConnectionKeyCandidateClaimsV1,
): Uint8Array {
  const claims = copyStationConnectionKeyCandidateClaims(value);
  return new TextEncoder().encode(
    JSON.stringify({
      aud: claims.aud,
      brokerOrigin: claims.brokerOrigin,
      challenge: claims.challenge,
      clientInstanceId: claims.clientInstanceId,
      clientKeyThumbprint: claims.clientKeyThumbprint,
      confirmationCode: claims.confirmationCode,
      exp: claims.exp,
      iat: claims.iat,
      keyId: claims.keyId,
      purpose: claims.purpose,
      candidate: {
        stationId: claims.candidate.stationId,
        enrollmentId: claims.candidate.enrollmentId,
        generation: claims.candidate.generation,
        signingKey: {
          kty: claims.candidate.signingKey.kty,
          crv: claims.candidate.signingKey.crv,
          x: claims.candidate.signingKey.x,
          y: claims.candidate.signingKey.y,
        },
      },
      version: claims.version,
    }),
  );
}

/**
 * Derives an 80-bit short authentication string from canonical Station trust.
 * It proves only that two displays refer to the same descriptor; it does not
 * create approval or elevate the self-signed candidate to a trust anchor.
 */
export async function stationConnectionKeyConfirmationCode(
  value: StationConnectionKeyDescriptorV1,
): Promise<string> {
  const trust = copyStationConnectionTrust(value);
  const descriptor = new TextEncoder().encode(
    JSON.stringify({
      stationId: trust.stationId,
      enrollmentId: trust.enrollmentId,
      generation: trust.generation,
      signingKey: {
        kty: trust.signingKey.kty,
        crv: trust.signingKey.crv,
        x: trust.signingKey.x,
        y: trust.signingKey.y,
      },
    }),
  );
  const domain = new TextEncoder().encode(
    'station-connection-key-confirmation/v1\0',
  );
  const input = new Uint8Array(domain.length + descriptor.length);
  input.set(domain);
  input.set(descriptor, domain.length);
  const digest = new Uint8Array(
    await crypto.subtle.digest('SHA-256', input),
  ).subarray(0, 10);
  let code = '';
  let accumulator = 0;
  let bits = 0;
  for (const byte of digest) {
    accumulator = (accumulator << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      code += CANDIDATE_CODE_ALPHABET[(accumulator >> bits) & 31];
    }
    accumulator &= (1 << bits) - 1;
  }
  if (bits !== 0 || code.length !== 16) return refuse();
  return code;
}

export function formatStationConnectionKeyConfirmationCode(code: string) {
  if (!/^[0-9A-HJKMNP-TV-Z]{16}$/.test(code)) return refuse();
  return `${code.slice(0, 4)}-${code.slice(4, 8)}-${code.slice(8, 12)}-${code.slice(12, 16)}`;
}

function candidateCompactJws(value: StationConnectionKeyCandidateV1 | string) {
  let compactJws: unknown = value;
  if (typeof value !== 'string') {
    const envelope = exactFields(value, ['version', 'compactJws']);
    if (envelope.version !== STATION_CONNECTION_KEY_CANDIDATE_VERSION)
      return refuse();
    compactJws = envelope.compactJws;
  }
  if (
    typeof compactJws !== 'string' ||
    compactJws.length > 8192 ||
    !/^[A-Za-z0-9_.-]+$/.test(compactJws)
  )
    return refuse();
  return compactJws;
}

async function verifyCandidateSignature(
  compactJws: string,
): Promise<StationConnectionKeyCandidateClaimsV1> {
  const parts = compactJws.split('.');
  if (parts.length !== 3) return refuse();
  let untrusted: unknown;
  try {
    untrusted = JSON.parse(
      new TextDecoder('utf-8', { fatal: true }).decode(
        base64url.decode(parts[1]!),
      ),
    );
  } catch {
    return refuse();
  }
  const claims = copyStationConnectionKeyCandidateClaims(untrusted);
  const key = await importJWK(claims.candidate.signingKey, 'ES256');
  const verified = await compactVerify(compactJws, key, {
    algorithms: ['ES256'],
  });
  if (
    Object.keys(verified.protectedHeader).sort().join(',') !== 'alg,typ' ||
    verified.protectedHeader.alg !== 'ES256' ||
    verified.protectedHeader.typ !== STATION_CONNECTION_KEY_CANDIDATE_TYPE
  )
    return refuse();
  const canonicalPayload = serializeStationConnectionKeyCandidateClaims(claims);
  if (
    verified.payload.byteLength !== canonicalPayload.byteLength ||
    verified.payload.some((byte, index) => byte !== canonicalPayload[index])
  )
    return refuse();
  return claims;
}

async function verifyCandidateExpectation(
  claims: StationConnectionKeyCandidateClaimsV1,
  expected: StationConnectionKeyCandidateExpectationV1,
) {
  const expectedOrigin = candidateBrokerOrigin(expected.brokerOrigin);
  const now = expected.now ?? Math.floor(Date.now() / 1000);
  if (
    typeof expected.challenge !== 'string' ||
    !BROKER_CHALLENGE.test(expected.challenge) ||
    !isCanonicalSha256Base64Url(expected.challenge) ||
    typeof expected.clientInstanceId !== 'string' ||
    !UUID.test(expected.clientInstanceId) ||
    !isCanonicalSha256Base64Url(expected.clientKeyThumbprint) ||
    typeof expected.stationId !== 'string' ||
    !UUID.test(expected.stationId) ||
    typeof expected.enrollmentId !== 'string' ||
    !UUID.test(expected.enrollmentId) ||
    !Number.isSafeInteger(now) ||
    now < 0
  )
    return refuse();
  const [keyId, confirmationCode] = await Promise.all([
    calculateJwkThumbprint(claims.candidate.signingKey, 'sha256'),
    stationConnectionKeyConfirmationCode(claims.candidate),
  ]);
  if (
    claims.brokerOrigin !== expectedOrigin ||
    claims.challenge !== expected.challenge ||
    claims.clientInstanceId !== expected.clientInstanceId ||
    claims.clientKeyThumbprint !== expected.clientKeyThumbprint ||
    claims.candidate.stationId !== expected.stationId ||
    claims.candidate.enrollmentId !== expected.enrollmentId ||
    claims.keyId !== keyId ||
    claims.exp <= now ||
    claims.iat > now + 5 ||
    claims.iat < now - STATION_CONNECTION_KEY_CANDIDATE_LIFETIME_SECONDS ||
    claims.exp <= claims.iat ||
    claims.exp - claims.iat >
      STATION_CONNECTION_KEY_CANDIDATE_LIFETIME_SECONDS ||
    claims.confirmationCode !== confirmationCode
  )
    return refuse();
}

/** Verifies a candidate against a fresh local challenge and selected broker. */
export async function verifyStationConnectionKeyCandidate(
  value: StationConnectionKeyCandidateV1 | string,
  expected: StationConnectionKeyCandidateExpectationV1,
): Promise<VerifiedStationConnectionKeyCandidateV1> {
  try {
    const compactJws = candidateCompactJws(value);
    const claims = await verifyCandidateSignature(compactJws);
    await verifyCandidateExpectation(claims, expected);
    return { status: 'candidate', claims };
  } catch {
    return refuse();
  }
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
