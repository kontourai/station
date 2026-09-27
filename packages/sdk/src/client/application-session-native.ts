import {
  APPLICATION_SESSION_NATIVE_CHALLENGE_PATH,
  APPLICATION_SESSION_NATIVE_EXCHANGE_PATH,
  APPLICATION_SESSION_NATIVE_HEADER,
  APPLICATION_SESSION_NATIVE_PROOF_HEADER,
  APPLICATION_SESSION_NATIVE_PROOF_TYPE,
  APPLICATION_SESSION_NATIVE_VERSION,
  type ApplicationSessionPublicKey,
  type NativeApplicationSessionChallengeV1,
  type NativeApplicationSessionContinuationV1,
  type NativeApplicationSessionExchangeV1,
  type NativeApplicationSessionProofClaimsV1,
  type NativeApplicationSessionTargetV1,
} from '@kontourai/station-contracts/application-session';
import { isPrincipalRef } from '@kontourai/station-contracts/principal';
import type { SelfHostedBrokerNativeClientSurfaceV2 } from '@kontourai/station-contracts/self-hosted-broker';
import type { ApplicationSessionSigner } from './application-session';

const OPAQUE = /^[A-Za-z0-9_-]{43}$/;

export const NATIVE_APPLICATION_SESSION_CHALLENGE_PATH =
  APPLICATION_SESSION_NATIVE_CHALLENGE_PATH;
export const NATIVE_APPLICATION_SESSION_EXCHANGE_PATH =
  APPLICATION_SESSION_NATIVE_EXCHANGE_PATH;

/**
 * Caller-owned trust snapshot. Every value must come from already approved
 * native facts; the client never discovers or negotiates any of them. The
 * snapshot is re-read before each operation so a trust change fails closed.
 */
export interface NativeApplicationSessionTrustSnapshotV1 {
  readonly kind: 'station-native';
  readonly stationId: string;
  /** Canonical Station service audience (an https Origin); never a client Origin. */
  readonly audience: string;
  readonly deviceId: string;
  /** Full approved native surface; compared field-exactly, never partially. */
  readonly surface: SelfHostedBrokerNativeClientSurfaceV2;
}

/**
 * Caller-supplied encrypted application-channel transport. There is no direct
 * HTTP fallback inside this client: no fetch, no cookies, no broker bearer.
 * The transport owns message integrity and returns parsed envelope data only,
 * so cookie-style state can never reach this code path.
 */
export interface NativeApplicationSessionTransportV1 {
  post(input: {
    readonly path: string;
    readonly headers: Readonly<Record<string, string>>;
    readonly body: unknown;
  }): Promise<unknown>;
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

/** Canonical JSON: recursively sorted object keys, no whitespace. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
    return `{${entries
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

export async function canonicalCredentialsHash(
  credentials: Readonly<Record<string, unknown>>,
): Promise<string> {
  return base64url(
    new Uint8Array(
      await crypto.subtle.digest(
        'SHA-256',
        new TextEncoder().encode(canonical(credentials)),
      ),
    ),
  );
}

function sameSurface(
  left: SelfHostedBrokerNativeClientSurfaceV2,
  right: SelfHostedBrokerNativeClientSurfaceV2,
): boolean {
  return (
    left.kind === right.kind &&
    left.appIdentifier === right.appIdentifier &&
    left.channel === right.channel &&
    left.clientInstanceId === right.clientInstanceId &&
    left.keyThumbprint === right.keyThumbprint
  );
}

function sameTarget(
  left: NativeApplicationSessionTargetV1,
  right: NativeApplicationSessionTargetV1,
): boolean {
  return (
    left.kind === right.kind &&
    left.stationId === right.stationId &&
    left.audience === right.audience &&
    sameSurface(left.surface, right.surface)
  );
}

function parsePublicKey(value: ApplicationSessionPublicKey) {
  if (
    value?.kty !== 'EC' ||
    value.crv !== 'P-256' ||
    !OPAQUE.test(value.x) ||
    !OPAQUE.test(value.y)
  )
    throw new Error('Invalid native application session public key.');
  return value;
}

export async function applicationSessionKeyThumbprint(
  publicKey: ApplicationSessionPublicKey,
): Promise<string> {
  const key = parsePublicKey(publicKey);
  return base64url(
    new Uint8Array(
      await crypto.subtle.digest(
        'SHA-256',
        new TextEncoder().encode(
          canonical({ crv: key.crv, kty: key.kty, x: key.x, y: key.y }),
        ),
      ),
    ),
  );
}

function canonicalAudience(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('Native application session audience is not a URL.');
  }
  if (
    url.origin !== value ||
    url.protocol !== 'https:' ||
    url.pathname !== '/' ||
    url.search ||
    url.hash ||
    url.username ||
    url.password
  )
    throw new Error(
      'Native application session audience must be a canonical HTTPS Origin.',
    );
  return value;
}

function requestPath(value: string): string {
  if (
    typeof value !== 'string' ||
    !value.startsWith('/') ||
    value.startsWith('//') ||
    /[\\?#\r\n\0]/.test(value) ||
    value.length > 2048
  )
    throw new Error('Native application session request path is invalid.');
  return value;
}

/**
 * Build one native account proof. The header typ is the native proof type and
 * is deliberately distinct from the browser application-session proof, even
 * though both may be signed by an independent non-extractable P-256 key from
 * the shared custody helper. Callers must never pass a broker route proof key.
 */
export async function createNativeApplicationSessionProof(
  signer: ApplicationSessionSigner,
  trust: NativeApplicationSessionTrustSnapshotV1,
  claims: {
    readonly purpose: 'exchange' | 'request';
    readonly deviceId: string;
    readonly nonce: string;
    readonly method: string;
    readonly path: string;
    readonly credentialHash?: string;
    readonly challengeIdHash?: string;
    readonly credentialsHash?: string;
    readonly expiresAtMs: number;
  },
  nowMs: number = Date.now(),
): Promise<string> {
  if (trust.kind !== 'station-native')
    throw new Error('Native application session trust must be station-native.');
  const audience = canonicalAudience(trust.audience);
  const surface = trust.surface;
  if (
    !surface ||
    typeof surface !== 'object' ||
    surface.kind !== 'station-native' ||
    typeof surface.appIdentifier !== 'string' ||
    !surface.appIdentifier ||
    !['dev', 'stable', 'beta', 'nightly'].includes(surface.channel) ||
    typeof surface.clientInstanceId !== 'string' ||
    !surface.clientInstanceId ||
    typeof surface.keyThumbprint !== 'string' ||
    !surface.keyThumbprint
  )
    throw new Error('Native application session surface is incomplete.');
  if (
    !Number.isSafeInteger(nowMs) ||
    nowMs < 0 ||
    !Number.isFinite(claims.expiresAtMs) ||
    claims.expiresAtMs <= nowMs
  )
    throw new Error('Native application session proof window has expired.');
  const iat = Math.floor(nowMs / 1000);
  const jti = base64url(crypto.getRandomValues(new Uint8Array(16)));
  const header = encode({
    alg: 'ES256',
    typ: APPLICATION_SESSION_NATIVE_PROOF_TYPE,
  });
  const payload: NativeApplicationSessionProofClaimsV1 = {
    version: APPLICATION_SESSION_NATIVE_VERSION,
    purpose: claims.purpose,
    aud: audience,
    stationId: trust.stationId,
    surface,
    deviceId: claims.deviceId,
    nonce: claims.nonce,
    method: claims.method.toUpperCase(),
    path: requestPath(claims.path),
    ...(claims.credentialHash ? { credentialHash: claims.credentialHash } : {}),
    ...(claims.challengeIdHash
      ? { challengeIdHash: claims.challengeIdHash }
      : {}),
    ...(claims.credentialsHash
      ? { credentialsHash: claims.credentialsHash }
      : {}),
    jti,
    iat,
  };
  const signingInput = `${header}.${encode(payload)}`;
  const signature = await signer.sign(new TextEncoder().encode(signingInput));
  if (signature.byteLength !== 64)
    throw new Error(
      'Native application session signer returned an incompatible signature.',
    );
  return `${signingInput}.${base64url(signature)}`;
}

function parseChallenge(
  value: unknown,
  trust: NativeApplicationSessionTrustSnapshotV1,
  expectedThumbprint: string,
): NativeApplicationSessionChallengeV1 {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Native application session challenge is invalid.');
  const challenge = value as NativeApplicationSessionChallengeV1;
  if (challenge.version !== APPLICATION_SESSION_NATIVE_VERSION)
    throw new Error('Native application session challenge version mismatch.');
  if (!OPAQUE.test(challenge.challengeId) || !OPAQUE.test(challenge.nonce))
    throw new Error('Native application session challenge is invalid.');
  if (challenge.keyThumbprint !== expectedThumbprint)
    throw new Error(
      'Native application session challenge was issued for another proof key.',
    );
  if (!challenge.target || !sameTarget(challenge.target, trust))
    throw new Error(
      'Native application session challenge belongs to another Station, audience or surface.',
    );
  if (challenge.deviceId !== trust.deviceId)
    throw new Error(
      'Native application session challenge was issued for another Device.',
    );
  const expiresAtMs = Date.parse(challenge.expiresAt);
  if (!Number.isFinite(expiresAtMs) || expiresAtMs <= Date.now())
    throw new Error('Native application session challenge has expired.');
  return challenge;
}

function parseContinuation(
  value: unknown,
  trust: NativeApplicationSessionTrustSnapshotV1,
  expectedThumbprint: string,
): NativeApplicationSessionContinuationV1 {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Native application session continuation is invalid.');
  const continuation = value as NativeApplicationSessionContinuationV1;
  if (continuation.version !== APPLICATION_SESSION_NATIVE_VERSION)
    throw new Error(
      'Native application session continuation version mismatch.',
    );
  if (
    typeof continuation.credential !== 'string' ||
    !continuation.credential ||
    typeof continuation.authorityKey !== 'string' ||
    !continuation.authorityKey ||
    !isPrincipalRef(continuation.principal)
  )
    throw new Error('Native application session continuation is invalid.');
  if (!continuation.target || !sameTarget(continuation.target, trust))
    throw new Error(
      'Native application session continuation belongs to another Station, audience or surface.',
    );
  if (continuation.deviceId !== trust.deviceId)
    throw new Error(
      'Native application session continuation was issued for another Device.',
    );
  if (continuation.keyThumbprint !== expectedThumbprint)
    throw new Error(
      'Native application session continuation was issued for another proof key.',
    );
  const expiresAtMs = Date.parse(continuation.expiresAt);
  if (!Number.isFinite(expiresAtMs) || expiresAtMs <= Date.now())
    throw new Error('Native application session continuation has expired.');
  return continuation;
}

function asCredentials(value: Readonly<Record<string, unknown>>) {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Native provider credentials must be an object.');
  if (canonical(value).length > 16 * 1024)
    throw new Error('Native provider credentials exceed the canonical bound.');
  return value;
}

/**
 * Opt-in native Station account-continuation client. The account proof key is
 * an INDEPENDENT non-extractable P-256 key from the shared custody helper —
 * never the native broker route proof key. Provider/Device/Project authority
 * stay separate: the continuation is not a bearer or Device grant, the
 * approved Device credential stays with the caller's transport, and no
 * provider/Device/Project authority is implemented here.
 */
export class NativeApplicationSessionClient {
  private readonly consumedChallenges = new Set<string>();
  private readonly issuedJti = new Set<string>();
  constructor(
    private readonly transport: NativeApplicationSessionTransportV1,
    private readonly trust: () => NativeApplicationSessionTrustSnapshotV1,
    private readonly key: ApplicationSessionSigner,
  ) {
    parsePublicKey(key.publicKey);
  }

  private current() {
    const snapshot = this.trust();
    if (snapshot?.kind !== 'station-native')
      throw new Error('Native application session trust is unavailable.');
    canonicalAudience(snapshot.audience);
    return snapshot;
  }

  private async assertFreshJti(jti: string) {
    if (this.issuedJti.has(jti))
      throw new Error('Native application session proof JTI reuse detected.');
    this.issuedJti.add(jti);
  }

  /** Request the challenge and validate it against the current trust snapshot. */
  async challenge(
    nowMs: number = Date.now(),
  ): Promise<NativeApplicationSessionChallengeV1> {
    const trust = this.current();
    const thumbprint = await applicationSessionKeyThumbprint(
      this.key.publicKey,
    );
    const response = await this.transport.post({
      path: NATIVE_APPLICATION_SESSION_CHALLENGE_PATH,
      headers: {},
      body: {
        version: APPLICATION_SESSION_NATIVE_VERSION,
        publicKey: this.key.publicKey,
      },
    });
    const challenge = parseChallenge(response, trust, thumbprint);
    if (this.consumedChallenges.has(challenge.challengeId))
      throw new Error('Native application session challenge reuse detected.');
    const expiresAtMs = Date.parse(challenge.expiresAt);
    if (expiresAtMs <= nowMs)
      throw new Error('Native application session challenge has expired.');
    return challenge;
  }

  /**
   * Exchange the challenge plus provider-native credentials for a continuation.
   * Credentials go only into the signed canonical hash and the encrypted
   * transport body; they are never stored, logged, or reused here.
   */
  async exchange(
    credentials: Readonly<Record<string, unknown>>,
    nowMs: number = Date.now(),
  ): Promise<NativeApplicationSessionContinuationV1> {
    const trust = this.current();
    const checked = asCredentials(credentials);
    const challenge = await this.challenge(nowMs);
    this.consumedChallenges.add(challenge.challengeId);
    const credentialsHash = await canonicalCredentialsHash(checked);
    const credentialProof = await createNativeApplicationSessionProof(
      this.key,
      trust,
      {
        purpose: 'exchange',
        deviceId: trust.deviceId,
        nonce: challenge.nonce,
        method: 'POST',
        path: NATIVE_APPLICATION_SESSION_EXCHANGE_PATH,
        credentialsHash,
        challengeIdHash: base64url(
          new Uint8Array(
            await crypto.subtle.digest(
              'SHA-256',
              new TextEncoder().encode(challenge.challengeId),
            ),
          ),
        ),
        expiresAtMs: Date.parse(challenge.expiresAt),
      },
      nowMs,
    );
    const claims = decodeClaims(credentialProof);
    await this.assertFreshJti(claims.jti);
    const body: NativeApplicationSessionExchangeV1 = {
      version: APPLICATION_SESSION_NATIVE_VERSION,
      challengeId: challenge.challengeId,
      credentials: { ...checked },
      proof: credentialProof,
    };
    const response = await this.transport.post({
      path: NATIVE_APPLICATION_SESSION_EXCHANGE_PATH,
      headers: {
        [APPLICATION_SESSION_NATIVE_PROOF_HEADER]: credentialProof,
      },
      body,
    });
    return parseContinuation(
      response,
      trust,
      await applicationSessionKeyThumbprint(this.key.publicKey),
    );
  }

  /**
   * Signed headers for one protected request over the caller's encrypted
   * transport. Each call mints a fresh one-use JTI and rechecks the trust
   * snapshot and continuation before signing.
   */
  async headers(
    continuation: NativeApplicationSessionContinuationV1,
    request: { readonly method: string; readonly path: string },
    nowMs: number = Date.now(),
  ): Promise<Record<string, string>> {
    const trust = this.current();
    const thumbprint = await applicationSessionKeyThumbprint(
      this.key.publicKey,
    );
    const current = parseContinuation(continuation, trust, thumbprint);
    if (!/^[A-Z]{1,16}$/.test(request.method))
      throw new Error('Native application session request method is invalid.');
    const path = requestPath(request.path);
    if (
      current.target.audience !== trust.audience ||
      !sameTarget(current.target, {
        kind: 'station-native',
        stationId: trust.stationId,
        audience: trust.audience,
        surface: trust.surface,
      })
    )
      throw new Error('Native application session target changed.');
    const proof = await createNativeApplicationSessionProof(
      this.key,
      trust,
      {
        purpose: 'request',
        deviceId: current.deviceId,
        nonce: current.nonce,
        method: request.method,
        path,
        credentialHash: base64url(
          new Uint8Array(
            await crypto.subtle.digest(
              'SHA-256',
              new TextEncoder().encode(current.credential),
            ),
          ),
        ),
        expiresAtMs: Date.parse(current.expiresAt),
      },
      nowMs,
    );
    const claims = decodeClaims(proof);
    await this.assertFreshJti(claims.jti);
    return {
      [APPLICATION_SESSION_NATIVE_HEADER]: current.credential,
      [APPLICATION_SESSION_NATIVE_PROOF_HEADER]: proof,
    };
  }
}

function decodeClaims(proof: string): NativeApplicationSessionProofClaimsV1 {
  const [, payload] = proof.split('.');
  return JSON.parse(
    new TextDecoder().decode(
      Uint8Array.from(
        atob(payload!.replace(/-/g, '+').replace(/_/g, '/')),
        (character) => character.charCodeAt(0),
      ),
    ),
  ) as NativeApplicationSessionProofClaimsV1;
}
