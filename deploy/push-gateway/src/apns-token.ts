// APNs provider authentication token (ES256 JWT signed with the team's .p8 key).
//
// APNs answers 429 TooManyProviderTokenUpdates when it sees a new provider
// token more often than roughly every 20 minutes, and every Worker isolate
// would otherwise sign its own. WebCrypto's ECDSA is randomized, so two
// isolates signing the same claims produce different tokens. Signing here is
// deterministic instead (RFC 6979 nonces via @noble/curves) and `iat` is
// floored to a shared window, so every isolate derives the byte-identical
// token for a window without any shared storage.

import { p256 } from '@noble/curves/nist.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { base64UrlEncode } from './station-auth.ts';

/** APNs accepts a token for 60 minutes; the whole fleet rolls every 45. */
export const APNS_TOKEN_WINDOW_SECONDS = 45 * 60;

const APPLE_ID = /^[A-Z0-9]{10}$/;

export interface ApnsCredentials {
  teamId: string;
  keyId: string;
  /** The .p8 file: a PKCS#8 PEM holding a P-256 private key. */
  privateKeyPem: string;
}

/**
 * Accepts the three configuration values only when all are present and
 * plausible; anything else leaves APNs delivery off (the routes answer 503).
 * Whether the key is really a P-256 key is only known when it is first used.
 */
export function parseApnsCredentials(input: {
  teamId: string | undefined;
  keyId: string | undefined;
  authKey: string | undefined;
}): ApnsCredentials | null {
  const { teamId, keyId, authKey } = input;
  if (!teamId || !APPLE_ID.test(teamId)) return null;
  if (!keyId || !APPLE_ID.test(keyId)) return null;
  if (!authKey?.includes('PRIVATE KEY')) return null;
  // `wrangler secret put` from a one-line paste keeps literal "\n" sequences.
  return { teamId, keyId, privateKeyPem: authKey.replace(/\\n/g, '\n') };
}

export function providerTokenIssuedAt(nowSeconds: number): number {
  return (
    Math.floor(nowSeconds / APNS_TOKEN_WINDOW_SECONDS) *
    APNS_TOKEN_WINDOW_SECONDS
  );
}

function pemToDer(pem: string): Uint8Array<ArrayBuffer> {
  const body = pem.replace(/-----[^-]+-----/g, '').replace(/\s+/g, '');
  return Uint8Array.from(atob(body), (c) => c.charCodeAt(0));
}

function base64UrlToBytes(value: string): Uint8Array {
  const padded =
    value.replaceAll('-', '+').replaceAll('_', '/') +
    '='.repeat((4 - (value.length % 4)) % 4);
  return Uint8Array.from(atob(padded), (c) => c.charCodeAt(0));
}

/** WebCrypto only parses the PKCS#8 document; noble signs with the scalar. */
async function signingScalar(pem: string): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    'pkcs8',
    pemToDer(pem),
    { name: 'ECDSA', namedCurve: 'P-256' },
    true,
    ['sign'],
  );
  const jwk = await crypto.subtle.exportKey('jwk', key);
  if (jwk.crv !== 'P-256' || typeof jwk.d !== 'string')
    throw new Error('APNs key is not a P-256 private key');
  const scalar = base64UrlToBytes(jwk.d);
  if (scalar.length !== 32)
    throw new Error('APNs key scalar has the wrong length');
  return scalar;
}

const encodeJson = (value: object) =>
  base64UrlEncode(new TextEncoder().encode(JSON.stringify(value)));

/** Identical inputs give byte-identical output. */
function signWithScalar(
  credentials: ApnsCredentials,
  scalar: Uint8Array,
  issuedAt: number,
): string {
  const signingInput = `${encodeJson({ alg: 'ES256', kid: credentials.keyId })}.${encodeJson(
    { iss: credentials.teamId, iat: issuedAt },
  )}`;
  const signature = p256.sign(
    sha256(new TextEncoder().encode(signingInput)),
    scalar,
    // Deterministic k is the point of this module: no hedging entropy.
    { prehash: false, extraEntropy: false, format: 'compact' },
  );
  return `${signingInput}.${base64UrlEncode(signature)}`;
}

async function keyFingerprint(pem: string): Promise<string> {
  const digest = new Uint8Array(
    await crypto.subtle.digest('SHA-256', new TextEncoder().encode(pem)),
  );
  return Array.from(digest.slice(0, 8), (b) =>
    b.toString(16).padStart(2, '0'),
  ).join('');
}

interface CachedToken {
  issuedAt: number;
  jwt: string;
  scalar: Uint8Array;
}

// Only avoids re-signing on every push; correctness does not depend on it,
// because any isolate derives the same token for the same window. Keyed on the
// key's fingerprint so a rotated key never reuses the previous key's token.
const isolateCache = new Map<string, CachedToken>();

export function resetProviderTokenCacheForTest(): void {
  isolateCache.clear();
}

export async function providerToken(
  credentials: ApnsCredentials,
  nowSeconds: number,
): Promise<string> {
  const issuedAt = providerTokenIssuedAt(nowSeconds);
  const cacheKey = `${credentials.teamId}:${credentials.keyId}:${await keyFingerprint(
    credentials.privateKeyPem,
  )}`;
  const cached = isolateCache.get(cacheKey);
  if (cached?.issuedAt === issuedAt) return cached.jwt;
  const scalar =
    cached?.scalar ?? (await signingScalar(credentials.privateKeyPem));
  const jwt = signWithScalar(credentials, scalar, issuedAt);
  isolateCache.set(cacheKey, { issuedAt, jwt, scalar });
  return jwt;
}
