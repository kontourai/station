import {
  RELAY_ENROLLMENT_ACTIVATE_PATH,
  RELAY_ENROLLMENT_BEGIN_PATH,
  RELAY_ENROLLMENT_FINALIZE_PATH,
  RELAY_ENROLLMENT_LOGIN_PATH,
  RELAY_ENROLLMENT_PROOF_AUDIENCE,
  RELAY_ENROLLMENT_PROOF_TYPE,
  RELAY_ENROLLMENT_VERSION,
  type RelayEnrollmentChallenge,
  type RelayEnrollmentContinuationBundle,
  type RelayEnrollmentDeliveredResponse,
  type RelayEnrollmentProofClaims,
  type RelayEnrollmentPublicKey,
} from '@kontourai/station-contracts/relay-enrollment';

const OPAQUE = /^[A-Za-z0-9_-]{43}$/;

function canonicalBrowserOrigin(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      url.origin === value &&
      (url.protocol === 'https:' ||
        (url.protocol === 'http:' &&
          ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)))
    );
  } catch {
    return false;
  }
}

/** Signing boundary for relay enrollment. Implementations keep private material in platform custody. */
export interface RelayEnrollmentSigner {
  readonly publicKey: RelayEnrollmentPublicKey;
  /** ES256, 64-byte IEEE-P1363 signature over the compact JWS signing input. */
  sign(input: Uint8Array): Promise<Uint8Array>;
}

export interface RelayEnrollmentKey extends RelayEnrollmentSigner {
  readonly privateKey: CryptoKey;
}

function parsePublicKey(
  value: RelayEnrollmentPublicKey,
): RelayEnrollmentPublicKey {
  if (
    value?.kty !== 'EC' ||
    value.crv !== 'P-256' ||
    !OPAQUE.test(value.x) ||
    !OPAQUE.test(value.y)
  )
    throw new Error('Invalid relay enrollment public key.');
  return Object.freeze({ kty: 'EC', crv: 'P-256', x: value.x, y: value.y });
}

function base64url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

function encode(value: unknown): string {
  return base64url(new TextEncoder().encode(JSON.stringify(value)));
}

async function thumbprint(
  publicKey: RelayEnrollmentPublicKey,
): Promise<string> {
  const canonical = JSON.stringify({
    crv: publicKey.crv,
    kty: publicKey.kty,
    x: publicKey.x,
    y: publicKey.y,
  });
  return base64url(
    new Uint8Array(
      await crypto.subtle.digest(
        'SHA-256',
        new TextEncoder().encode(canonical),
      ),
    ),
  );
}

/** Generate a fresh, non-extractable P-256 key for one enrollment attempt. */
export async function createRelayEnrollmentKey(): Promise<RelayEnrollmentKey> {
  const pair = await crypto.subtle.generateKey(
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['sign', 'verify'],
  );
  const jwk = await crypto.subtle.exportKey('jwk', pair.publicKey);
  const publicKey = parsePublicKey({
    kty: jwk.kty as 'EC',
    crv: jwk.crv as 'P-256',
    x: jwk.x!,
    y: jwk.y!,
  });
  return restoreRelayEnrollmentKey(pair.privateKey, publicKey);
}

/** Rebind restored platform custody without exporting private key bytes. */
export function restoreRelayEnrollmentKey(
  privateKey: CryptoKey,
  publicKey: RelayEnrollmentPublicKey,
): RelayEnrollmentKey {
  if (
    privateKey.extractable ||
    privateKey.algorithm.name !== 'ECDSA' ||
    !('namedCurve' in privateKey.algorithm) ||
    privateKey.algorithm.namedCurve !== 'P-256' ||
    !privateKey.usages.includes('sign')
  )
    throw new Error(
      'Relay enrollment requires a non-extractable P-256 signing key.',
    );
  const checkedKey = parsePublicKey(publicKey);
  return Object.freeze({
    privateKey,
    publicKey: checkedKey,
    async sign(input: Uint8Array) {
      return new Uint8Array(
        await crypto.subtle.sign(
          { name: 'ECDSA', hash: 'SHA-256' },
          privateKey,
          new Uint8Array(input),
        ),
      );
    },
  });
}

/** Create the one-time proof required before Station invokes the local password provider. */
export async function createRelayEnrollmentLoginProof(
  signer: RelayEnrollmentSigner,
  challenge: RelayEnrollmentChallenge,
  request: { method: string; url: string; clientOrigin: string },
  nowMs: number = Date.now(),
): Promise<string> {
  const key = parsePublicKey(signer.publicKey);
  if (
    challenge.version !== RELAY_ENROLLMENT_VERSION ||
    challenge.purpose !== 'login' ||
    !OPAQUE.test(challenge.enrollmentId) ||
    !OPAQUE.test(challenge.keyThumbprint) ||
    !OPAQUE.test(challenge.nonce) ||
    !Number.isSafeInteger(nowMs) ||
    nowMs < 0
  )
    throw new Error('Invalid relay enrollment challenge.');
  const parsedOrigin = new URL(challenge.requestOrigin);
  const parsedClientOrigin = new URL(challenge.clientOrigin);
  const target = new URL(request.url);
  if (
    parsedOrigin.origin !== challenge.requestOrigin ||
    parsedClientOrigin.origin !== challenge.clientOrigin ||
    !canonicalBrowserOrigin(challenge.clientOrigin) ||
    request.clientOrigin !== challenge.clientOrigin ||
    target.origin !== challenge.requestOrigin ||
    target.pathname !== RELAY_ENROLLMENT_LOGIN_PATH ||
    target.search ||
    target.hash ||
    request.method.toUpperCase() !== 'POST'
  )
    throw new Error(
      'Relay enrollment proof target does not match its challenge.',
    );
  const expiresAtMs = Date.parse(challenge.expiresAt);
  const iat = Math.floor(nowMs / 1000);
  const exp = Math.min(iat + 30, Math.floor(expiresAtMs / 1000));
  if (!Number.isFinite(expiresAtMs) || expiresAtMs <= nowMs || exp <= iat)
    throw new Error('Relay enrollment challenge has expired.');
  if ((await thumbprint(key)) !== challenge.keyThumbprint)
    throw new Error('Relay enrollment key does not match its challenge.');
  const header = encode({ alg: 'ES256', typ: RELAY_ENROLLMENT_PROOF_TYPE });
  const claims: RelayEnrollmentProofClaims = {
    v: RELAY_ENROLLMENT_VERSION,
    aud: RELAY_ENROLLMENT_PROOF_AUDIENCE,
    stationId: challenge.stationId,
    enrollmentId: challenge.enrollmentId,
    clientOrigin: challenge.clientOrigin,
    keyThumbprint: challenge.keyThumbprint,
    nonce: challenge.nonce,
    purpose: 'login',
    htm: 'POST',
    htu: challenge.requestOrigin + target.pathname,
    jti: base64url(crypto.getRandomValues(new Uint8Array(16))),
    iat,
    exp,
  };
  const payload = encode(claims);
  const signingInput = `${header}.${payload}`;
  const signature = await signer.sign(new TextEncoder().encode(signingInput));
  if (signature.byteLength !== 64)
    throw new Error(
      'Relay enrollment signer returned an incompatible signature.',
    );
  return `${signingInput}.${base64url(signature)}`;
}

async function createPurposeProof(
  signer: RelayEnrollmentSigner,
  challenge: RelayEnrollmentChallenge,
  request: { method: string; url: string; clientOrigin: string },
  purpose: 'finalize' | 'activate',
  nonce: string,
  bindings: Record<string, string>,
  nowMs: number,
): Promise<string> {
  const key = parsePublicKey(signer.publicKey);
  const target = new URL(request.url);
  if (
    challenge.version !== RELAY_ENROLLMENT_VERSION ||
    !OPAQUE.test(challenge.enrollmentId) ||
    !OPAQUE.test(challenge.keyThumbprint) ||
    !OPAQUE.test(nonce) ||
    !canonicalBrowserOrigin(challenge.clientOrigin) ||
    request.clientOrigin !== challenge.clientOrigin ||
    target.origin !== challenge.requestOrigin ||
    target.search ||
    target.hash ||
    request.method.toUpperCase() !== 'POST' ||
    (purpose === 'finalize' &&
      target.pathname !== RELAY_ENROLLMENT_FINALIZE_PATH) ||
    (purpose === 'activate' &&
      target.pathname !== RELAY_ENROLLMENT_ACTIVATE_PATH)
  )
    throw new Error(
      'Relay enrollment proof target does not match its binding.',
    );
  const expiresAtMs = Date.parse(challenge.expiresAt);
  const iat = Math.floor(nowMs / 1000);
  const exp = Math.min(iat + 30, Math.floor(expiresAtMs / 1000));
  if (!Number.isFinite(expiresAtMs) || expiresAtMs <= nowMs || exp <= iat)
    throw new Error('Relay enrollment challenge has expired.');
  if ((await thumbprint(key)) !== challenge.keyThumbprint)
    throw new Error('Relay enrollment key does not match its challenge.');
  if (
    Object.values(bindings).some(
      (value) => !OPAQUE.test(value) && value.length > 128,
    )
  )
    throw new Error('Invalid relay enrollment proof binding.');
  const header = encode({ alg: 'ES256', typ: RELAY_ENROLLMENT_PROOF_TYPE });
  const claims = {
    v: RELAY_ENROLLMENT_VERSION,
    aud: RELAY_ENROLLMENT_PROOF_AUDIENCE,
    stationId: challenge.stationId,
    enrollmentId: challenge.enrollmentId,
    clientOrigin: challenge.clientOrigin,
    keyThumbprint: challenge.keyThumbprint,
    nonce,
    purpose,
    htm: 'POST' as const,
    htu: challenge.requestOrigin + target.pathname,
    jti: base64url(crypto.getRandomValues(new Uint8Array(16))),
    iat,
    exp,
    ...bindings,
  };
  const signingInput = `${header}.${encode(claims)}`;
  const signature = await signer.sign(new TextEncoder().encode(signingInput));
  if (signature.byteLength !== 64)
    throw new Error(
      'Relay enrollment signer returned an incompatible signature.',
    );
  return `${signingInput}.${base64url(signature)}`;
}

/** Proof for approval polling/finalize. A pending response contains no credentials. */
export function createRelayEnrollmentFinalizeProof(
  signer: RelayEnrollmentSigner,
  challenge: RelayEnrollmentChallenge,
  request: { method: string; url: string; clientOrigin: string },
  nowMs: number = Date.now(),
): Promise<string> {
  return createPurposeProof(
    signer,
    challenge,
    request,
    'finalize',
    challenge.nonce,
    {},
    nowMs,
  );
}

/** Canonical digest binds the exact delivered Device and continuation secret bundle. */
export async function digestRelayEnrollmentBundle(
  bundle: RelayEnrollmentContinuationBundle,
): Promise<string> {
  const canonical = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(canonical);
    if (!value || typeof value !== 'object') return value;
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [
          key,
          canonical((value as Record<string, unknown>)[key]),
        ]),
    );
  };
  return base64url(
    new Uint8Array(
      await crypto.subtle.digest(
        'SHA-256',
        new TextEncoder().encode(JSON.stringify(canonical(bundle))),
      ),
    ),
  );
}

/** ACK proof binds receipt of the exact delivered secrets to their Device and authority IDs. */
export async function createRelayEnrollmentActivationProof(
  signer: RelayEnrollmentSigner,
  challenge: RelayEnrollmentChallenge,
  delivery: RelayEnrollmentDeliveredResponse,
  request: { method: string; url: string; clientOrigin: string },
  nowMs: number = Date.now(),
): Promise<string> {
  if (
    delivery.version !== RELAY_ENROLLMENT_VERSION ||
    delivery.state !== 'delivered' ||
    delivery.enrollmentId !== challenge.enrollmentId ||
    delivery.bundle.deviceId !== delivery.bundle.continuation.deviceId ||
    delivery.bundle.stationId !== challenge.stationId ||
    delivery.bundle.continuation.clientOrigin !== challenge.clientOrigin ||
    (await digestRelayEnrollmentBundle(delivery.bundle)) !==
      delivery.bundleDigest
  )
    throw new Error('Relay enrollment delivery does not match its challenge.');
  return createPurposeProof(
    signer,
    challenge,
    request,
    'activate',
    delivery.activationNonce,
    {
      deviceId: delivery.bundle.deviceId,
      authorityKey: delivery.bundle.continuation.authorityKey,
      bundleDigest: delivery.bundleDigest,
    },
    nowMs,
  );
}

/** Public path constant for callers that transport the proof over an existing relay channel. */
export const RELAY_ENROLLMENT_CLIENT_PATHS = Object.freeze({
  begin: RELAY_ENROLLMENT_BEGIN_PATH,
  login: RELAY_ENROLLMENT_LOGIN_PATH,
  finalize: RELAY_ENROLLMENT_FINALIZE_PATH,
  activate: RELAY_ENROLLMENT_ACTIVATE_PATH,
});
