import {
  NATIVE_DEVICE_PROOF_LIFETIME_SECONDS,
  NATIVE_DEVICE_PROOF_MAX_LENGTH,
  NATIVE_DEVICE_PROOF_REQUEST_PURPOSE,
  NATIVE_DEVICE_PROOF_TYPE,
  NATIVE_DEVICE_PROOF_VERSION,
  type NativeDeviceBindingSnapshot,
} from '@kontourai/station-contracts/native-device-proof';
import type { SelfHostedBrokerNativeClientSurfaceV2 } from '@kontourai/station-contracts/self-hosted-broker';

/** Application-channel pilot body bound, matching the SDK signer. */
const NATIVE_DEVICE_PROOF_BODY_MAX_BYTES = 16 * 1024;
/** Allowed future-clock skew when rejecting not-yet-valid proofs. */
const NATIVE_DEVICE_PROOF_CLOCK_SKEW_SECONDS = 5;

const BASE64URL_SEGMENT = /^[A-Za-z0-9_-]+$/;
const BASE64URL_SHA256 = /^[A-Za-z0-9_-]{43}$/;
const BASE64URL_JTI = /^[A-Za-z0-9_-]{16,128}$/;
const HTTP_METHOD = /^[A-Z]{1,16}$/;
const OPAQUE_ID = /^[A-Za-z0-9_-]{43}$/;
const APP_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9.-]{0,254}$/;
const CLIENT_INSTANCE_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type NativeDeviceProofBindingStatus = 'approved' | 'rotated' | 'revoked';

export type NativeDeviceProofPeerStatus = 'current' | 'aborted';

/** Approved Device proof key, as a bare P-256 EC public JWK. */
export interface NativeDeviceProofPublicKeyJwk {
  readonly kty: 'EC';
  readonly crv: 'P-256';
  readonly x: string;
  readonly y: string;
}

/**
 * Caller-supplied view of the currently approved Device proof binding: the
 * contract snapshot plus the approved public key that the thumbprint names.
 */
export interface NativeDeviceProofBindingView {
  readonly status: NativeDeviceProofBindingStatus;
  readonly snapshot?: NativeDeviceBindingSnapshot;
  readonly deviceProofKey?: NativeDeviceProofPublicKeyJwk;
}

/**
 * Validated `deviceId`/`bindingId` selectors parsed from the proof's
 * claims and handed to `authority.binding` for state lookup. They are lookup
 * HINTS only: signature, full binding and peer checks — not these selectors —
 * establish authority, and the same selectors are passed on every recheck.
 */
export interface NativeDeviceProofAuthoritySelectors {
  readonly deviceId: string;
  readonly bindingId: string;
}

/** Caller-supplied private verified native peer fact. */
export interface NativeDeviceProofPeerView {
  readonly status: NativeDeviceProofPeerStatus;
  readonly snapshot?: {
    readonly stationId: string;
    readonly stationAudience: string;
    readonly surface: SelfHostedBrokerNativeClientSurfaceV2;
    readonly peerNonce: string;
  };
}

/**
 * Thrown by a replay store when the JTI was already consumed. The verifier
 * rethrows this specific signal; any other store failure fails closed.
 */
export class NativeDeviceProofReplayedError extends Error {
  constructor(message = 'Native Device proof JTI was already consumed.') {
    super(message);
    this.name = 'NativeDeviceProofReplayedError';
  }
}

/**
 * One-use JTI consumption seam. Implementations must consume exactly once,
 * signal a replayed JTI with `NativeDeviceProofReplayedError`, and must fail
 * closed on any other error.
 */
export interface NativeDeviceProofReplayStore {
  consume(jti: string, expiresAt: number): Promise<void>;
}

export type NativeDeviceProofRejectionReason =
  | 'malformed_proof'
  | 'oversized_proof'
  | 'oversized_body'
  | 'invalid_header'
  | 'invalid_claims'
  | 'expired'
  | 'not_yet_valid'
  | 'binding_mismatch'
  | 'peer_mismatch'
  | 'peer_not_current'
  | 'binding_not_approved'
  | 'route_mismatch'
  | 'body_mismatch'
  | 'signature_invalid'
  | 'replay_store_unavailable';

export class NativeDeviceProofRejectedError extends Error {
  readonly reason: NativeDeviceProofRejectionReason;

  constructor(
    reason: NativeDeviceProofRejectionReason,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = 'NativeDeviceProofRejectedError';
    this.reason = reason;
  }
}

export interface NativeDeviceProofRequestInput {
  readonly method: string;
  /** Exact request path including query, without scheme or authority. */
  readonly path: string;
  /** Exact transmitted body bytes. */
  readonly body: Uint8Array;
}

/** Verified Device identity returned only after the JTI is consumed. */
export interface NativeDeviceProofVerification {
  readonly deviceId: string;
  readonly bindingId: string;
}

export interface NativeDeviceProofVerifierDeps {
  readonly replayStore: NativeDeviceProofReplayStore;
  readonly nowSeconds?: () => number;
}

function verificationClock(deps: NativeDeviceProofVerifierDeps): number {
  const clockSource = deps.nowSeconds ? deps.nowSeconds() : Date.now() / 1000;
  const clock = Math.floor(clockSource);
  if (
    !Number.isFinite(clockSource) ||
    !Number.isSafeInteger(clock) ||
    clock < 0
  )
    throw new NativeDeviceProofRejectedError(
      'invalid_claims',
      'Native Device proof verification clock is invalid.',
    );
  return clock;
}

const base64urlDecode = (segment: string): Uint8Array => {
  const normalized = segment.replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(normalized);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1)
    bytes[index] = binary.charCodeAt(index);
  return bytes;
};

const base64urlEncode = (bytes: Uint8Array): string => {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
};

function decodeCanonicalSegment(segment: string): Uint8Array {
  if (!BASE64URL_SEGMENT.test(segment))
    throw new NativeDeviceProofRejectedError(
      'malformed_proof',
      'Native Device proof uses invalid base64url.',
    );
  let bytes: Uint8Array;
  try {
    bytes = base64urlDecode(segment);
  } catch (cause) {
    throw new NativeDeviceProofRejectedError(
      'malformed_proof',
      'Native Device proof segment cannot be decoded.',
      { cause },
    );
  }
  if (base64urlEncode(bytes) !== segment)
    throw new NativeDeviceProofRejectedError(
      'malformed_proof',
      'Native Device proof uses non-canonical base64url.',
    );
  return bytes;
}

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const exactKeys = (
  value: Record<string, unknown>,
  keys: readonly string[],
): boolean =>
  Object.keys(value).length === keys.length &&
  keys.every((key) => Object.hasOwn(value, key));

const surfacesEqual = (
  a: SelfHostedBrokerNativeClientSurfaceV2,
  b: SelfHostedBrokerNativeClientSurfaceV2,
): boolean =>
  a.kind === b.kind &&
  a.appIdentifier === b.appIdentifier &&
  a.channel === b.channel &&
  a.clientInstanceId === b.clientInstanceId &&
  a.keyThumbprint === b.keyThumbprint;

const bindingsEqual = (
  a: NativeDeviceBindingSnapshot,
  b: NativeDeviceBindingSnapshot,
): boolean =>
  a.stationId === b.stationId &&
  a.stationAudience === b.stationAudience &&
  a.deviceId === b.deviceId &&
  a.bindingId === b.bindingId &&
  a.deviceProofKeyThumbprint === b.deviceProofKeyThumbprint &&
  a.peerNonce === b.peerNonce &&
  surfacesEqual(a.surface, b.surface);

const peersEqual = (
  a: NonNullable<NativeDeviceProofPeerView['snapshot']>,
  b: NonNullable<NativeDeviceProofPeerView['snapshot']>,
): boolean =>
  a.stationId === b.stationId &&
  a.stationAudience === b.stationAudience &&
  a.peerNonce === b.peerNonce &&
  surfacesEqual(a.surface, b.surface);

const publicKeysEqual = (
  a: NativeDeviceProofPublicKeyJwk,
  b: NativeDeviceProofPublicKeyJwk,
): boolean => a.kty === b.kty && a.crv === b.crv && a.x === b.x && a.y === b.y;

const canonicalAudience = (value: unknown): string | undefined => {
  if (typeof value !== 'string') return undefined;
  try {
    const url = new URL(value);
    if (url.origin !== value) return undefined;
    if (url.username || url.password) return undefined;
    if (
      url.protocol !== 'https:' &&
      !(
        url.protocol === 'http:' &&
        ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
      )
    )
      return undefined;
    return value;
  } catch {
    return undefined;
  }
};

const canonicalRequestPath = (value: string): boolean => {
  if (
    !value.startsWith('/') ||
    value.startsWith('//') ||
    value.length > 2048 ||
    /[\\#\r\n\0]/.test(value)
  )
    return false;
  try {
    const parsed = new URL(value, 'https://station.invalid');
    return parsed.pathname + parsed.search === value;
  } catch {
    return false;
  }
};

interface DecodedProof {
  readonly claims: Record<string, unknown>;
  readonly signedInput: Uint8Array;
  readonly signature: Uint8Array;
}

function decodeProof(proof: string): DecodedProof {
  if (typeof proof !== 'string' || proof.length === 0)
    throw new NativeDeviceProofRejectedError(
      'malformed_proof',
      'Native Device proof is not a compact JWS.',
    );
  if (proof.length > NATIVE_DEVICE_PROOF_MAX_LENGTH)
    throw new NativeDeviceProofRejectedError(
      'oversized_proof',
      'Native Device proof exceeds the pilot size bound.',
    );
  const segments = proof.split('.');
  if (segments.length !== 3)
    throw new NativeDeviceProofRejectedError(
      'malformed_proof',
      'Native Device proof is not a three-segment compact JWS.',
    );
  const [headerSegment, payloadSegment, signatureSegment] = segments;
  const headerBytes = decodeCanonicalSegment(headerSegment);
  const payloadBytes = decodeCanonicalSegment(payloadSegment);
  const signature = decodeCanonicalSegment(signatureSegment);
  if (signature.byteLength !== 64)
    throw new NativeDeviceProofRejectedError(
      'malformed_proof',
      'Native Device proof signature is not 64 bytes.',
    );

  let header: unknown;
  let claims: unknown;
  try {
    const decoder = new TextDecoder('utf-8', { fatal: true });
    header = JSON.parse(decoder.decode(headerBytes));
    claims = JSON.parse(decoder.decode(payloadBytes));
  } catch (cause) {
    throw new NativeDeviceProofRejectedError(
      'malformed_proof',
      'Native Device proof segments are not valid JSON.',
      { cause },
    );
  }

  if (
    !isPlainObject(header) ||
    !exactKeys(header, ['alg', 'typ']) ||
    header.alg !== 'ES256' ||
    header.typ !== NATIVE_DEVICE_PROOF_TYPE
  )
    throw new NativeDeviceProofRejectedError(
      'invalid_header',
      'Native Device proof header is not the exact ES256 request-proof typ.',
    );

  if (!isPlainObject(claims))
    throw new NativeDeviceProofRejectedError(
      'invalid_claims',
      'Native Device proof payload is not an object.',
    );

  const signedInput = new TextEncoder().encode(
    `${headerSegment}.${payloadSegment}`,
  );
  return { claims, signedInput, signature };
}

interface ValidatedClaims {
  readonly aud: string;
  readonly stationId: string;
  readonly deviceId: string;
  readonly bindingId: string;
  readonly deviceProofKeyThumbprint: string;
  readonly surface: SelfHostedBrokerNativeClientSurfaceV2;
  readonly peerNonce: string;
  readonly htm: string;
  readonly htu: string;
  readonly bodySha256: string;
  readonly jti: string;
  readonly iat: number;
  readonly exp: number;
}

const CLAIM_KEYS = [
  'version',
  'aud',
  'purpose',
  'stationId',
  'deviceId',
  'bindingId',
  'deviceProofKeyThumbprint',
  'surface',
  'peerNonce',
  'htm',
  'htu',
  'bodySha256',
  'jti',
  'iat',
  'exp',
] as const;

function validateClaims(
  claims: Record<string, unknown>,
  now: number,
): ValidatedClaims {
  if (!exactKeys(claims, CLAIM_KEYS))
    throw new NativeDeviceProofRejectedError(
      'invalid_claims',
      'Native Device proof claims are not the exact v1 claim set.',
    );
  if (
    claims.version !== NATIVE_DEVICE_PROOF_VERSION ||
    claims.purpose !== NATIVE_DEVICE_PROOF_REQUEST_PURPOSE
  )
    throw new NativeDeviceProofRejectedError(
      'invalid_claims',
      'Native Device proof version or purpose is wrong.',
    );
  const aud = canonicalAudience(claims.aud);
  if (!aud)
    throw new NativeDeviceProofRejectedError(
      'invalid_claims',
      'Native Device proof audience is not a canonical Station origin.',
    );
  const stringClaim = (key: string, maxLength = 512): string => {
    const value = claims[key];
    if (
      typeof value !== 'string' ||
      value.length === 0 ||
      value.length > maxLength
    )
      throw new NativeDeviceProofRejectedError(
        'invalid_claims',
        `Native Device proof claim ${key} is not a bounded string.`,
      );
    return value;
  };
  const stationId = stringClaim('stationId');
  const deviceId = stringClaim('deviceId');
  const bindingId = stringClaim('bindingId');
  const deviceProofKeyThumbprint = stringClaim('deviceProofKeyThumbprint');
  const peerNonce = stringClaim('peerNonce');
  const jti = stringClaim('jti');
  const htm = stringClaim('htm');
  const htu = stringClaim('htu', 2048);
  const bodySha256 = stringClaim('bodySha256');
  if (!OPAQUE_ID.test(deviceProofKeyThumbprint) || !OPAQUE_ID.test(peerNonce))
    throw new NativeDeviceProofRejectedError(
      'invalid_claims',
      'Native Device proof key thumbprint or peer nonce is not an opaque id.',
    );
  if (!BASE64URL_JTI.test(jti))
    throw new NativeDeviceProofRejectedError(
      'invalid_claims',
      'Native Device proof JTI is not canonical base64url.',
    );
  if (!BASE64URL_SHA256.test(bodySha256))
    throw new NativeDeviceProofRejectedError(
      'invalid_claims',
      'Native Device proof body digest is not base64url SHA-256.',
    );
  if (!HTTP_METHOD.test(htm))
    throw new NativeDeviceProofRejectedError(
      'invalid_claims',
      'Native Device proof method is not an alphabetic HTTP method.',
    );
  if (!canonicalRequestPath(htu))
    throw new NativeDeviceProofRejectedError(
      'invalid_claims',
      'Native Device proof target is not a canonical path.',
    );
  const surface = claims.surface;
  if (
    !isPlainObject(surface) ||
    !exactKeys(surface, [
      'kind',
      'appIdentifier',
      'channel',
      'clientInstanceId',
      'keyThumbprint',
    ]) ||
    surface.kind !== 'station-native' ||
    typeof surface.appIdentifier !== 'string' ||
    typeof surface.clientInstanceId !== 'string' ||
    typeof surface.keyThumbprint !== 'string' ||
    !OPAQUE_ID.test(surface.keyThumbprint) ||
    !APP_IDENTIFIER.test(surface.appIdentifier) ||
    !CLIENT_INSTANCE_ID.test(surface.clientInstanceId) ||
    (surface.channel !== 'dev' &&
      surface.channel !== 'stable' &&
      surface.channel !== 'beta' &&
      surface.channel !== 'nightly')
  )
    throw new NativeDeviceProofRejectedError(
      'invalid_claims',
      'Native Device proof surface is not a v2 native client surface.',
    );
  const iat = claims.iat;
  const exp = claims.exp;
  if (
    typeof iat !== 'number' ||
    !Number.isSafeInteger(iat) ||
    typeof exp !== 'number' ||
    !Number.isSafeInteger(exp)
  )
    throw new NativeDeviceProofRejectedError(
      'invalid_claims',
      'Native Device proof timestamps are not epoch seconds.',
    );
  if (exp - iat > NATIVE_DEVICE_PROOF_LIFETIME_SECONDS || exp <= iat)
    throw new NativeDeviceProofRejectedError(
      'invalid_claims',
      'Native Device proof lifetime exceeds the 30 second bound.',
    );
  if (iat > now + NATIVE_DEVICE_PROOF_CLOCK_SKEW_SECONDS)
    throw new NativeDeviceProofRejectedError(
      'not_yet_valid',
      'Native Device proof is dated in the future.',
    );
  if (now >= exp)
    throw new NativeDeviceProofRejectedError(
      'expired',
      'Native Device proof is expired.',
    );
  return {
    aud,
    stationId,
    deviceId,
    bindingId,
    deviceProofKeyThumbprint,
    surface: {
      kind: 'station-native',
      appIdentifier: surface.appIdentifier,
      channel: surface.channel,
      clientInstanceId: surface.clientInstanceId,
      keyThumbprint: surface.keyThumbprint,
    },
    peerNonce,
    htm,
    htu,
    bodySha256,
    jti,
    iat,
    exp,
  };
}

async function sha256Base64Url(bytes: Uint8Array): Promise<string> {
  const digest = new Uint8Array(
    await crypto.subtle.digest('SHA-256', copyBytes(bytes)),
  );
  return base64urlEncode(digest);
}

const copyBytes = (bytes: Uint8Array): Uint8Array<ArrayBuffer> => {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy;
};

const constantTimeEquals = (a: string, b: string): boolean => {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let index = 0; index < a.length; index += 1)
    diff |= a.charCodeAt(index) ^ b.charCodeAt(index);
  return diff === 0;
};

/**
 * Verifies one compact ES256 native Device request JWS against the
 * caller-supplied current approved Device proof binding and private verified
 * native peer fact, and the exact request method, path and body bytes.
 *
 * This helper alone grants no authority: it returns a verified Device ID and
 * binding ID only after the one-use JTI is consumed. It accepts no
 * bearer/cookie input, grants no storage and composes no route or principal.
 * Any replay-store error fails closed.
 */
export async function verifyNativeDeviceRequestProof(
  proof: string,
  request: NativeDeviceProofRequestInput,
  authority: {
    binding: (
      selectors: NativeDeviceProofAuthoritySelectors,
    ) => Promise<NativeDeviceProofBindingView>;
    peer: () => Promise<NativeDeviceProofPeerView>;
  },
  deps: NativeDeviceProofVerifierDeps,
): Promise<NativeDeviceProofVerification> {
  const clock = verificationClock(deps);

  if (
    !(request.body instanceof Uint8Array) ||
    request.body.byteLength > NATIVE_DEVICE_PROOF_BODY_MAX_BYTES
  )
    throw new NativeDeviceProofRejectedError(
      'oversized_body',
      'Native Device proof request body exceeds the 16 KiB channel pilot bound.',
    );
  const body = copyBytes(request.body);

  const { claims, signedInput, signature } = decodeProof(proof);
  const validated = validateClaims(claims, clock);

  const selectors: NativeDeviceProofAuthoritySelectors = {
    deviceId: validated.deviceId,
    bindingId: validated.bindingId,
  };
  const initialBinding = await authority.binding(selectors);
  if (
    initialBinding.status !== 'approved' ||
    !initialBinding.snapshot ||
    !initialBinding.deviceProofKey
  )
    throw new NativeDeviceProofRejectedError(
      'binding_not_approved',
      'The Device proof binding is not currently approved.',
    );
  const binding = structuredClone(initialBinding.snapshot);
  const proofKey = structuredClone(initialBinding.deviceProofKey);
  const initialPeer = await authority.peer();
  if (initialPeer.status !== 'current' || !initialPeer.snapshot)
    throw new NativeDeviceProofRejectedError(
      'peer_not_current',
      'The verified native peer is not current.',
    );

  const peer = structuredClone(initialPeer.snapshot);

  if (binding.deviceProofKeyThumbprint === binding.surface.keyThumbprint)
    throw new NativeDeviceProofRejectedError(
      'binding_mismatch',
      'The Device proof key thumbprint must be distinct from the route key thumbprint.',
    );
  if (
    validated.aud !== binding.stationAudience ||
    validated.stationId !== binding.stationId ||
    validated.deviceId !== binding.deviceId ||
    validated.bindingId !== binding.bindingId ||
    validated.peerNonce !== binding.peerNonce ||
    validated.deviceProofKeyThumbprint !== binding.deviceProofKeyThumbprint ||
    !surfacesEqual(validated.surface, binding.surface)
  )
    throw new NativeDeviceProofRejectedError(
      'binding_mismatch',
      'The proof does not match the approved Device binding.',
    );
  if (
    validated.stationId !== peer.stationId ||
    validated.aud !== peer.stationAudience ||
    !surfacesEqual(validated.surface, peer.surface) ||
    validated.peerNonce !== peer.peerNonce
  )
    throw new NativeDeviceProofRejectedError(
      'peer_mismatch',
      'The proof does not match the verified native peer fact.',
    );
  if (
    validated.htm !== request.method.toUpperCase() ||
    validated.htu !== request.path ||
    !canonicalRequestPath(request.path)
  )
    throw new NativeDeviceProofRejectedError(
      'route_mismatch',
      'The proof does not cover the exact request method and path.',
    );
  if (!constantTimeEquals(validated.bodySha256, await sha256Base64Url(body)))
    throw new NativeDeviceProofRejectedError(
      'body_mismatch',
      'The proof body digest does not match the transmitted bytes.',
    );

  let publicKey: CryptoKey;
  try {
    if (
      !isPlainObject(proofKey) ||
      !exactKeys(proofKey, ['kty', 'crv', 'x', 'y']) ||
      proofKey.kty !== 'EC' ||
      proofKey.crv !== 'P-256' ||
      typeof proofKey.x !== 'string' ||
      typeof proofKey.y !== 'string' ||
      !OPAQUE_ID.test(proofKey.x) ||
      !OPAQUE_ID.test(proofKey.y)
    )
      throw new Error('invalid_native_device_public_key');
    const encodedKey = new TextEncoder().encode(
      JSON.stringify({
        crv: proofKey.crv,
        kty: proofKey.kty,
        x: proofKey.x,
        y: proofKey.y,
      }),
    );
    const thumbprint = base64urlEncode(
      new Uint8Array(await crypto.subtle.digest('SHA-256', encodedKey)),
    );
    if (!constantTimeEquals(thumbprint, binding.deviceProofKeyThumbprint))
      throw new Error('native_device_public_key_thumbprint_mismatch');
    publicKey = await crypto.subtle.importKey(
      'jwk',
      {
        kty: proofKey.kty,
        crv: proofKey.crv,
        x: proofKey.x,
        y: proofKey.y,
        ext: true,
      },
      { name: 'ECDSA', namedCurve: 'P-256' },
      false,
      ['verify'],
    );
  } catch (cause) {
    throw new NativeDeviceProofRejectedError(
      'binding_mismatch',
      'The approved Device proof key is not a usable P-256 JWK.',
      { cause },
    );
  }

  let signatureValid = false;
  try {
    signatureValid = await crypto.subtle.verify(
      { name: 'ECDSA', hash: 'SHA-256' },
      publicKey,
      copyBytes(signature),
      copyBytes(signedInput),
    );
  } catch (cause) {
    throw new NativeDeviceProofRejectedError(
      'signature_invalid',
      'Native Device proof signature could not be verified.',
      { cause },
    );
  }
  if (!signatureValid)
    throw new NativeDeviceProofRejectedError(
      'signature_invalid',
      'Native Device proof signature verification failed.',
    );

  // Recheck the caller-supplied current state after asynchronous work.
  const recheckedBinding = await authority.binding(selectors);
  if (
    recheckedBinding.status !== 'approved' ||
    !recheckedBinding.snapshot ||
    !recheckedBinding.deviceProofKey ||
    !bindingsEqual(recheckedBinding.snapshot, binding) ||
    !publicKeysEqual(recheckedBinding.deviceProofKey, proofKey)
  )
    throw new NativeDeviceProofRejectedError(
      'binding_not_approved',
      'The Device proof binding changed or was revoked during verification.',
    );
  const recheckedPeer = await authority.peer();
  if (
    recheckedPeer.status !== 'current' ||
    !recheckedPeer.snapshot ||
    !peersEqual(recheckedPeer.snapshot, peer)
  )
    throw new NativeDeviceProofRejectedError(
      'peer_not_current',
      'The verified native peer ended during verification.',
    );

  try {
    await deps.replayStore.consume(validated.jti, validated.exp);
  } catch (cause) {
    if (cause instanceof NativeDeviceProofReplayedError) throw cause;
    throw new NativeDeviceProofRejectedError(
      'replay_store_unavailable',
      'The replay store failed; the proof is rejected closed.',
      { cause },
    );
  }

  const finalBinding = await authority.binding(selectors);
  const finalPeer = await authority.peer();
  if (
    finalBinding.status !== 'approved' ||
    !finalBinding.snapshot ||
    !finalBinding.deviceProofKey ||
    !bindingsEqual(finalBinding.snapshot, binding) ||
    !publicKeysEqual(finalBinding.deviceProofKey, proofKey)
  )
    throw new NativeDeviceProofRejectedError(
      'binding_not_approved',
      'Native Device proof authority changed before dispatch.',
    );
  if (
    finalPeer.status !== 'current' ||
    !finalPeer.snapshot ||
    !peersEqual(finalPeer.snapshot, peer)
  )
    throw new NativeDeviceProofRejectedError(
      'peer_not_current',
      'Native Device peer changed before dispatch.',
    );

  // The crypto, replay and authority reads may outlive the signed window.
  validateClaims(claims, verificationClock(deps));
  return { deviceId: binding.deviceId, bindingId: binding.bindingId };
}
