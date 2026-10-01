import {
  APPLICATION_SESSION_NATIVE_CHALLENGE_PATH,
  APPLICATION_SESSION_NATIVE_EXCHANGE_PATH,
  APPLICATION_SESSION_NATIVE_HEADER,
  APPLICATION_SESSION_NATIVE_PROOF_HEADER,
  APPLICATION_SESSION_NATIVE_PROOF_TYPE,
  APPLICATION_SESSION_NATIVE_REVOKE_PATH,
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
import { z } from 'zod/v3';
import type { ApplicationSessionSigner } from './application-session';

const OPAQUE = /^[A-Za-z0-9_-]{43}$/;
const LOCAL_REPLAY_WINDOW = 4096;

export interface NativeLocalAccountCredentials {
  readonly username: string;
  readonly password: string;
}
export interface NativeAccountOpaqueChallenge {
  readonly challengeId: string;
  readonly nonce: string;
  /** An untrusted expiry hint; the native owner clamps its own lifetime. */
  readonly expiresAtMs: number;
}
export interface NativeAccountOpaqueContinuation {
  readonly credential: string;
  readonly nonce: string;
  readonly expiresAtMs: number;
}
export interface NativeAccountExchangePreparation {
  readonly body: NativeApplicationSessionExchangeV1;
  readonly headers: Readonly<Record<string, string>>;
}

/** Structured native operations; no JWS input or authority claims cross this seam. */
export interface NativeApplicationSessionProofProvider {
  readonly kind: 'station-native-host-proof-provider/v1';
  /** Actual native preparation deadline; never extended by a later account exchange. */
  readonly contextExpiresAtMs?: number;
  readonly publicKey: ApplicationSessionPublicKey;
  prepareExchange(input: {
    readonly challenge: NativeAccountOpaqueChallenge;
    readonly credentials: NativeLocalAccountCredentials;
  }): Promise<NativeAccountExchangePreparation>;
  requestHeaders(input: {
    readonly continuation: NativeAccountOpaqueContinuation;
    readonly request: {
      readonly method: 'GET' | 'HEAD';
      readonly path: string;
    };
  }): Promise<Readonly<Record<string, string>>>;
  prepareRevocation?(input: {
    readonly continuation: NativeAccountOpaqueContinuation;
  }): Promise<NativeAccountRevocationPreparation>;
  prepareInvitationAcceptance?(input: {
    readonly continuation: NativeAccountOpaqueContinuation;
    readonly token: string;
  }): Promise<NativeProjectInvitationAcceptancePreparation>;
}

export interface NativeAccountRevocationPreparation {
  readonly body: Readonly<Record<string, never>>;
  readonly headers: Readonly<Record<string, string>>;
}

export interface NativeProjectInvitationAcceptancePreparation {
  readonly body: { readonly token: string };
  readonly headers: Readonly<Record<string, string>>;
}
const INVITATION_ACCEPT_PATH = '/api/account-auth/accept-invitation';

const localCredentials = z
  .object({
    username: z
      .string()
      .min(3)
      .max(32)
      .regex(/^[A-Za-z0-9_.-]+$/),
    password: z.string().min(1).max(128),
  })
  .strict();
const nativeSurface = z
  .object({
    kind: z.literal('station-native'),
    appIdentifier: z.string(),
    channel: z.enum(['dev', 'stable', 'beta', 'nightly']),
    clientInstanceId: z.string(),
    keyThumbprint: z.string(),
  })
  .strict();
const hostClaims = z
  .object({
    version: z.literal(APPLICATION_SESSION_NATIVE_VERSION),
    purpose: z.enum(['exchange', 'request']),
    aud: z.string(),
    stationId: z.string(),
    surface: nativeSurface,
    deviceId: z.string(),
    nonce: z.string().regex(OPAQUE),
    method: z.string(),
    path: z.string(),
    credentialHash: z.string().regex(OPAQUE).optional(),
    challengeIdHash: z.string().regex(OPAQUE).optional(),
    credentialsHash: z.string().regex(OPAQUE).optional(),
    jti: z.string().regex(/^[A-Za-z0-9_-]{22}$/),
    iat: z.number().int().nonnegative(),
  })
  .strict();
const hostExchange = z
  .object({
    body: z
      .object({
        version: z.literal(APPLICATION_SESSION_NATIVE_VERSION),
        challengeId: z.string().regex(OPAQUE),
        credentials: localCredentials,
        proof: z.string().max(4096),
      })
      .strict(),
    headers: z
      .object({
        [APPLICATION_SESSION_NATIVE_PROOF_HEADER]: z.string().max(4096),
      })
      .strict(),
  })
  .strict();
const hostRequestHeaders = z
  .object({
    [APPLICATION_SESSION_NATIVE_HEADER]: z.string().regex(OPAQUE),
    [APPLICATION_SESSION_NATIVE_PROOF_HEADER]: z.string().max(4096),
  })
  .strict();

function isHostProofProvider(
  key: ApplicationSessionSigner | NativeApplicationSessionProofProvider,
): key is NativeApplicationSessionProofProvider {
  return 'kind' in key && key.kind === 'station-native-host-proof-provider/v1';
}

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

function decodeHostSegment(value: string): Uint8Array<ArrayBuffer> {
  if (!/^[A-Za-z0-9_-]+$/.test(value))
    throw new Error('Native host account proof base64url data is invalid.');
  const bytes = Uint8Array.from(
    atob(value.replace(/-/g, '+').replace(/_/g, '/')),
    (character) => character.charCodeAt(0),
  );
  if (base64url(bytes) !== value)
    throw new Error('Native host account proof base64url data is invalid.');
  return bytes;
}

async function hashText(value: string) {
  return base64url(
    new Uint8Array(
      await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)),
    ),
  );
}

async function verifyHostProof(
  proof: string,
  publicKey: ApplicationSessionPublicKey,
  trust: NativeApplicationSessionTrustSnapshotV1,
  expected: {
    purpose: 'exchange' | 'request';
    nonce: string;
    method: string;
    path: string;
    keyThumbprint: string;
    credentialHash?: string;
    challengeIdHash?: string;
    credentialsHash?: string;
  },
) {
  if (proof.length > 4096)
    throw new Error('Native host account proof exceeds its bound.');
  const segments = proof.split('.');
  if (segments.length !== 3)
    throw new Error('Native host account proof is invalid.');
  const [headerPart, payloadPart, signaturePart] = segments;
  if (!headerPart || !payloadPart || !signaturePart)
    throw new Error('Native host account proof is invalid.');
  z.object({
    alg: z.literal('ES256'),
    typ: z.literal(APPLICATION_SESSION_NATIVE_PROOF_TYPE),
  })
    .strict()
    .parse(
      JSON.parse(
        new TextDecoder('utf-8', { fatal: true }).decode(
          decodeHostSegment(headerPart),
        ),
      ),
    );
  const claims = hostClaims.parse(
    JSON.parse(
      new TextDecoder('utf-8', { fatal: true }).decode(
        decodeHostSegment(payloadPart),
      ),
    ),
  );
  const key = { ...parsePublicKey(publicKey) };
  const now = Math.floor(Date.now() / 1000);
  if (
    claims.purpose !== expected.purpose ||
    claims.aud !== trust.audience ||
    claims.stationId !== trust.stationId ||
    claims.deviceId !== trust.deviceId ||
    !sameSurface(claims.surface, trust.surface) ||
    claims.nonce !== expected.nonce ||
    claims.method !== expected.method ||
    claims.path !== expected.path ||
    claims.credentialHash !== expected.credentialHash ||
    claims.challengeIdHash !== expected.challengeIdHash ||
    claims.credentialsHash !== expected.credentialsHash ||
    claims.iat > now + 5 ||
    claims.iat < now - 65 ||
    (await applicationSessionKeyThumbprint(key)) !== expected.keyThumbprint
  )
    throw new Error(
      'Native host account proof does not match the requested operation.',
    );
  const signature = decodeHostSegment(signaturePart);
  const imported = await crypto.subtle.importKey(
    'jwk',
    key,
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['verify'],
  );
  if (
    signature.byteLength !== 64 ||
    !(await crypto.subtle.verify(
      { name: 'ECDSA', hash: 'SHA-256' },
      imported,
      signature,
      new TextEncoder().encode(`${headerPart}.${payloadPart}`),
    ))
  )
    throw new Error('Native host account proof signature is invalid.');
  return claims;
}

function localReadRequest(request: {
  readonly method: string;
  readonly path: string;
}): {
  readonly method: 'GET' | 'HEAD';
  readonly path: string;
} {
  if (request.method !== 'GET' && request.method !== 'HEAD')
    throw new Error('Native host account proof supports only Project reads.');
  const path = requestPath(request.path);
  const pathname = new URL(path, 'https://station.invalid').pathname;
  if (
    ![
      '/.well-known/station/v1',
      '/api/system/status',
      '/api/system/identity',
      '/api/auth/authority',
      '/api/projects',
    ].includes(pathname) &&
    !/^\/api\/projects\/[A-Za-z0-9_-]{1,128}(?:\/shared-work(?:\/[A-Za-z0-9_-]{1,128}\/(?:document|history|publication))?)?$/.test(
      pathname,
    )
  )
    throw new Error('Native host account proof supports only Project reads.');
  return Object.freeze({ method: request.method, path });
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

export async function serializedCredentialsHash(
  credentials: Readonly<Record<string, unknown>>,
): Promise<string> {
  // Match the Station owner's JSON.stringify(parsed credentials) exactly.
  // Sorting keys here would sign different bytes from the provider login body.
  const serialized = JSON.stringify(credentials);
  if (typeof serialized !== 'string')
    throw new Error('Native provider credentials are not JSON serializable.');
  return base64url(
    new Uint8Array(
      await crypto.subtle.digest(
        'SHA-256',
        new TextEncoder().encode(serialized),
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

function sameTrustSnapshot(
  left: NativeApplicationSessionTrustSnapshotV1,
  right: NativeApplicationSessionTrustSnapshotV1,
): boolean {
  return (
    left.kind === right.kind &&
    left.stationId === right.stationId &&
    left.audience === right.audience &&
    left.deviceId === right.deviceId &&
    sameSurface(left.surface, right.surface)
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
    !(
      url.protocol === 'https:' ||
      (url.protocol === 'http:' &&
        ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))
    ) ||
    url.pathname !== '/' ||
    url.search ||
    url.hash ||
    url.username ||
    url.password
  )
    throw new Error(
      'Native application session audience must be HTTPS or loopback HTTP.',
    );
  return value;
}

function requestPath(value: string): string {
  if (
    typeof value !== 'string' ||
    !value.startsWith('/') ||
    value.startsWith('//') ||
    /[\\#\r\n\0]/.test(value) ||
    value.length > 2048
  )
    throw new Error('Native application session request path is invalid.');
  const parsed = new URL(value, 'https://station.invalid');
  if (parsed.pathname + parsed.search !== value)
    throw new Error(
      'Native application session request path is not canonical.',
    );
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
  if (claims.deviceId !== trust.deviceId || !OPAQUE.test(claims.nonce))
    throw new Error('Native application session proof binding changed.');
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
  const serialized = JSON.stringify(value);
  if (
    typeof serialized !== 'string' ||
    new TextEncoder().encode(serialized).byteLength > 16 * 1024
  )
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
  private readonly contextExpiresAtMs: number | undefined;
  private readonly consumedChallenges = new Set<string>();
  private readonly issuedJti = new Set<string>();
  constructor(
    private readonly transport: NativeApplicationSessionTransportV1,
    private readonly trust: () => NativeApplicationSessionTrustSnapshotV1,
    private readonly key:
      | ApplicationSessionSigner
      | NativeApplicationSessionProofProvider,
  ) {
    parsePublicKey(key.publicKey);
    this.contextExpiresAtMs = isHostProofProvider(key)
      ? key.contextExpiresAtMs
      : undefined;
    this.assertContextDeadline();
  }

  private assertContextDeadline() {
    const deadline = this.contextExpiresAtMs;
    if (
      deadline !== undefined &&
      (!Number.isSafeInteger(deadline) ||
        deadline <= Date.now() ||
        !Number.isFinite(new Date(deadline).getTime()))
    )
      throw new Error('Native host account context expired.');
  }

  private current() {
    this.assertContextDeadline();
    const snapshot = this.trust();
    if (snapshot?.kind !== 'station-native')
      throw new Error('Native application session trust is unavailable.');
    canonicalAudience(snapshot.audience);
    if (!snapshot.stationId || !snapshot.deviceId || !snapshot.surface)
      throw new Error('Native application session trust is incomplete.');
    return Object.freeze({
      kind: 'station-native' as const,
      stationId: snapshot.stationId,
      audience: snapshot.audience,
      deviceId: snapshot.deviceId,
      surface: Object.freeze({ ...snapshot.surface }),
    });
  }

  private assertSameTrust(expected: NativeApplicationSessionTrustSnapshotV1) {
    if (!sameTrustSnapshot(this.current(), expected))
      throw new Error('Native application session trust changed.');
  }

  private rememberOnce(values: Set<string>, value: string, label: string) {
    if (values.has(value))
      throw new Error(`Native application session ${label} reuse detected.`);
    values.add(value);
    if (values.size > LOCAL_REPLAY_WINDOW)
      values.delete(values.values().next().value!);
  }

  /** Request the challenge and validate it against the current trust snapshot. */
  async challenge(
    nowMs: number = Date.now(),
  ): Promise<NativeApplicationSessionChallengeV1> {
    const trust = this.current();
    const thumbprint = await applicationSessionKeyThumbprint(
      this.key.publicKey,
    );
    this.assertSameTrust(trust);
    const response = await this.transport.post({
      path: NATIVE_APPLICATION_SESSION_CHALLENGE_PATH,
      headers: {},
      body: {
        version: APPLICATION_SESSION_NATIVE_VERSION,
        publicKey: this.key.publicKey,
      },
    });
    this.assertSameTrust(trust);
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
    const local = isHostProofProvider(this.key)
      ? localCredentials.parse(checked)
      : undefined;
    const challenge = await this.challenge(nowMs);
    this.assertSameTrust(trust);
    this.rememberOnce(
      this.consumedChallenges,
      challenge.challengeId,
      'challenge',
    );
    let body: NativeApplicationSessionExchangeV1;
    if (isHostProofProvider(this.key)) {
      if (!local)
        throw new Error('Native host account credentials are unavailable.');
      const prepared = await this.key.prepareExchange({
        challenge: Object.freeze({
          challengeId: challenge.challengeId,
          nonce: challenge.nonce,
          expiresAtMs: Date.parse(challenge.expiresAt),
        }),
        credentials: Object.freeze({ ...local }),
      });
      const parsed = hostExchange.parse(prepared);
      if (
        Object.keys(prepared.body.credentials).join(',') !==
          'username,password' ||
        parsed.body.challengeId !== challenge.challengeId ||
        parsed.body.credentials.username !== local.username ||
        parsed.body.credentials.password !== local.password ||
        parsed.headers[APPLICATION_SESSION_NATIVE_PROOF_HEADER] !==
          parsed.body.proof
      )
        throw new Error(
          'Native host account exchange does not match its prepared body.',
        );
      const claims = await verifyHostProof(
        parsed.body.proof,
        this.key.publicKey,
        trust,
        {
          purpose: 'exchange',
          nonce: challenge.nonce,
          method: 'POST',
          path: NATIVE_APPLICATION_SESSION_EXCHANGE_PATH,
          keyThumbprint: challenge.keyThumbprint,
          challengeIdHash: await hashText(challenge.challengeId),
          credentialsHash: await serializedCredentialsHash(
            parsed.body.credentials,
          ),
        },
      );
      this.rememberOnce(this.issuedJti, claims.jti, 'proof JTI');
      body = Object.freeze({
        ...parsed.body,
        credentials: Object.freeze({ ...parsed.body.credentials }),
      });
      if (new TextEncoder().encode(JSON.stringify(body)).byteLength > 16 * 1024)
        throw new Error(
          'Native host account exchange exceeds the channel bound.',
        );
    } else {
      const credentialsHash = await serializedCredentialsHash(checked);
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
          challengeIdHash: await hashText(challenge.challengeId),
          expiresAtMs: Date.parse(challenge.expiresAt),
        },
        nowMs,
      );
      const claims = decodeClaims(credentialProof);
      this.rememberOnce(this.issuedJti, claims.jti, 'proof JTI');
      body = {
        version: APPLICATION_SESSION_NATIVE_VERSION,
        challengeId: challenge.challengeId,
        credentials: { ...checked },
        proof: credentialProof,
      };
    }
    this.assertSameTrust(trust);
    const response = await this.transport.post({
      path: NATIVE_APPLICATION_SESSION_EXCHANGE_PATH,
      headers: {
        [APPLICATION_SESSION_NATIVE_PROOF_HEADER]: body.proof,
      },
      body,
    });
    this.assertSameTrust(trust);
    const accepted = parseContinuation(
      response,
      trust,
      await applicationSessionKeyThumbprint(this.key.publicKey),
    );
    const deadline = this.contextExpiresAtMs;
    if (deadline === undefined) return accepted;
    if (
      !Number.isSafeInteger(deadline) ||
      deadline <= Date.now() ||
      !Number.isFinite(new Date(deadline).getTime())
    )
      throw new Error('Native host account context expired.');
    this.assertSameTrust(trust);
    return Object.freeze({
      ...accepted,
      expiresAt: new Date(
        Math.min(Date.parse(accepted.expiresAt), deadline),
      ).toISOString(),
    });
  }

  /**
   * Signed headers for one protected request over the caller's encrypted
   * transport. Each call mints a fresh one-use JTI and rechecks the trust
   * snapshot and continuation before signing.
   */
  async prepareInvitationAcceptance(
    continuation: NativeApplicationSessionContinuationV1,
    token: string,
  ): Promise<NativeProjectInvitationAcceptancePreparation> {
    const trust = this.current();
    const thumbprint = await applicationSessionKeyThumbprint(
      this.key.publicKey,
    );
    const current = parseContinuation(continuation, trust, thumbprint);
    if (
      !OPAQUE.test(token) ||
      !isHostProofProvider(this.key) ||
      !this.key.prepareInvitationAcceptance
    )
      throw new Error('Native host invitation acceptance is unavailable.');
    const prepared = await this.key.prepareInvitationAcceptance({
      continuation: Object.freeze({
        credential: current.credential,
        nonce: current.nonce,
        expiresAtMs: Date.parse(current.expiresAt),
      }),
      token,
    });
    const body = z
      .object({ token: z.literal(token) })
      .strict()
      .parse(prepared.body);
    const headers = hostRequestHeaders.parse(prepared.headers);
    if (headers[APPLICATION_SESSION_NATIVE_HEADER] !== current.credential)
      throw new Error('Native host account continuation changed.');
    const claims = await verifyHostProof(
      headers[APPLICATION_SESSION_NATIVE_PROOF_HEADER],
      this.key.publicKey,
      trust,
      {
        purpose: 'request',
        nonce: current.nonce,
        method: 'POST',
        path: INVITATION_ACCEPT_PATH,
        keyThumbprint: current.keyThumbprint,
        credentialHash: await hashText(current.credential),
      },
    );
    this.rememberOnce(this.issuedJti, claims.jti, 'proof JTI');
    this.assertSameTrust(trust);
    return Object.freeze({
      body: Object.freeze({ ...body }),
      headers: Object.freeze({ ...headers }),
    });
  }

  async prepareRevocation(
    continuation: NativeApplicationSessionContinuationV1,
  ): Promise<NativeAccountRevocationPreparation> {
    const trust = this.current();
    const thumbprint = await applicationSessionKeyThumbprint(
      this.key.publicKey,
    );
    const current = parseContinuation(continuation, trust, thumbprint);
    if (!isHostProofProvider(this.key) || !this.key.prepareRevocation)
      throw new Error('Native host account revocation is unavailable.');
    const prepared = await this.key.prepareRevocation({
      continuation: Object.freeze({
        credential: current.credential,
        nonce: current.nonce,
        expiresAtMs: Date.parse(current.expiresAt),
      }),
    });
    const body = z.object({}).strict().parse(prepared.body);
    const headers = hostRequestHeaders.parse(prepared.headers);
    if (headers[APPLICATION_SESSION_NATIVE_HEADER] !== current.credential)
      throw new Error('Native host account continuation changed.');
    const claims = await verifyHostProof(
      headers[APPLICATION_SESSION_NATIVE_PROOF_HEADER],
      this.key.publicKey,
      trust,
      {
        purpose: 'request',
        nonce: current.nonce,
        method: 'POST',
        path: APPLICATION_SESSION_NATIVE_REVOKE_PATH,
        keyThumbprint: current.keyThumbprint,
        credentialHash: await hashText(current.credential),
      },
    );
    this.rememberOnce(this.issuedJti, claims.jti, 'proof JTI');
    this.assertSameTrust(trust);
    return Object.freeze({
      body: Object.freeze({ ...body }),
      headers: Object.freeze({ ...headers }),
    });
  }

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
    if (isHostProofProvider(this.key)) {
      const headers = hostRequestHeaders.parse(
        await this.key.requestHeaders({
          continuation: Object.freeze({
            credential: current.credential,
            nonce: current.nonce,
            expiresAtMs: Date.parse(current.expiresAt),
          }),
          request: localReadRequest(request),
        }),
      );
      if (headers[APPLICATION_SESSION_NATIVE_HEADER] !== current.credential)
        throw new Error('Native host account continuation changed.');
      const claims = await verifyHostProof(
        headers[APPLICATION_SESSION_NATIVE_PROOF_HEADER],
        this.key.publicKey,
        trust,
        {
          purpose: 'request',
          nonce: current.nonce,
          method: request.method,
          path,
          keyThumbprint: current.keyThumbprint,
          credentialHash: await hashText(current.credential),
        },
      );
      this.rememberOnce(this.issuedJti, claims.jti, 'proof JTI');
      this.assertSameTrust(trust);
      return headers;
    }
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
    this.rememberOnce(this.issuedJti, claims.jti, 'proof JTI');
    this.assertSameTrust(trust);
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
