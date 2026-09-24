import {
  APPLICATION_SESSION_BASE_PATH,
  APPLICATION_SESSION_HEADER,
  APPLICATION_SESSION_PROOF_HEADER,
  APPLICATION_SESSION_PROOF_TYPE,
  APPLICATION_SESSION_VERSION,
  type ApplicationSessionChallenge,
  type ApplicationSessionContinuation,
  type ApplicationSessionCookieAdoption,
  type ApplicationSessionPublicKey,
} from '@kontourai/station-contracts/application-session';
import {
  isPrincipalRef,
  type PrincipalRef,
} from '@kontourai/station-contracts/principal';
import { isStationNativeShellOrigin } from '@kontourai/station-shared/native-shell-origin';
import { z } from 'zod/v3';
import {
  type ClientRequestOptions,
  envelopeErrorMessage,
  getJson,
  mutateJson,
  readJsonBody,
  StationHttpError,
} from './http';

/** Native implementations can delegate signing to protected platform custody. */
export interface ApplicationSessionSigner {
  readonly publicKey: ApplicationSessionPublicKey;
  /** ES256, IEEE-P1363 signature bytes. Private key material must remain in custody. */
  sign(input: Uint8Array): Promise<Uint8Array>;
}
export interface ApplicationSessionKey extends ApplicationSessionSigner {
  readonly privateKey: CryptoKey;
}
const opaque = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
const origin = z
  .string()
  .url()
  .refine((value) => new URL(value).origin === value);
const keySchema = z
  .object({
    kty: z.literal('EC'),
    crv: z.literal('P-256'),
    x: opaque,
    y: opaque,
  })
  .strict();
const challengeSchema = z
  .object({
    version: z.literal(APPLICATION_SESSION_VERSION),
    challengeId: opaque,
    nonce: opaque,
    expiresAt: z.string().datetime(),
    stationId: z.string().min(1),
    requestOrigin: origin,
  })
  .strict();
const continuationSchema = z
  .object({
    version: z.literal(APPLICATION_SESSION_VERSION),
    credential: opaque,
    authorityKey: z.string().min(1),
    stationId: z.string().min(1),
    deviceId: z.string().min(1),
    principal: z.custom<PrincipalRef>(isPrincipalRef),
    requestOrigin: origin,
    clientOrigin: z
      .string()
      .refine(
        (value) =>
          isStationNativeShellOrigin(value) || origin.safeParse(value).success,
      ),
    keyThumbprint: opaque,
    nonce: opaque,
    expiresAt: z.string().datetime(),
  })
  .strict();
const cookieAdoptionSchema = z
  .object({
    version: z.literal(APPLICATION_SESSION_VERSION),
    aliasCredential: opaque,
    aliasId: z.string().uuid(),
    aliasExpiresAt: z.string().datetime(),
    continuation: continuationSchema,
  })
  .strict();
const base64url = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
const encode = (value: unknown) =>
  base64url(new TextEncoder().encode(JSON.stringify(value)));
const hash = async (value: string) =>
  base64url(
    new Uint8Array(
      await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)),
    ),
  );

/** Persist only the CryptoKey/public JWK in dedicated custody; restore the signing facade separately. */
export async function createApplicationSessionKey(): Promise<ApplicationSessionKey> {
  const pair = await crypto.subtle.generateKey(
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['sign', 'verify'],
  );
  const jwk = await crypto.subtle.exportKey('jwk', pair.publicKey);
  return restoreApplicationSessionKey(
    pair.privateKey,
    keySchema.parse({
      kty: jwk.kty,
      crv: jwk.crv,
      x: jwk.x,
      y: jwk.y,
    }),
  );
}

export function restoreApplicationSessionKey(
  privateKey: CryptoKey,
  publicKey: ApplicationSessionPublicKey,
): ApplicationSessionKey {
  if (
    privateKey.extractable ||
    privateKey.algorithm.name !== 'ECDSA' ||
    !('namedCurve' in privateKey.algorithm) ||
    privateKey.algorithm.namedCurve !== 'P-256' ||
    !privateKey.usages.includes('sign')
  )
    throw new Error(
      'Application sessions require a non-extractable P-256 signing key.',
    );
  return Object.freeze({
    privateKey,
    publicKey: Object.freeze(keySchema.parse(publicKey)),
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

/** Station's versioned virtual-request profile; secure transport still owns message integrity. */
export async function createApplicationSessionProof(
  key: ApplicationSessionSigner,
  binding: Pick<
    ApplicationSessionChallenge,
    'nonce' | 'stationId' | 'requestOrigin'
  >,
  request: { method: string; url: string },
  purpose: 'request' | 'exchange' | 'login' | 'adopt-cookie',
  credential?: string,
): Promise<string> {
  const target = new URL(request.url);
  const protectedHeader = encode({
    alg: 'ES256',
    typ: APPLICATION_SESSION_PROOF_TYPE,
  });
  const payload = encode({
    v: APPLICATION_SESSION_VERSION,
    stationId: binding.stationId,
    purpose,
    nonce: binding.nonce,
    htm: request.method.toUpperCase(),
    htu: binding.requestOrigin + target.pathname + target.search,
    ...(credential ? { ath: await hash(credential) } : {}),
    jti: base64url(crypto.getRandomValues(new Uint8Array(16))),
    iat: Math.floor(Date.now() / 1000),
  });
  const input = `${protectedHeader}.${payload}`;
  const signature = await key.sign(new TextEncoder().encode(input));
  if (signature.byteLength !== 64)
    throw new Error(
      'Application session signer returned an incompatible signature.',
    );
  return `${input}.${base64url(signature)}`;
}

async function read(response: Response): Promise<unknown> {
  const body = (await readJsonBody(response)) as
    | { data?: unknown; error?: unknown }
    | undefined;
  if (!response.ok)
    throw new StationHttpError(
      response.status,
      envelopeErrorMessage(body, 'Application session request failed.'),
    );
  return body?.data;
}
/** The caller supplies the actual client Origin and the existing scoped Device transport. */
export class ApplicationSessionClient {
  private readonly browserKeyNonExtractable: boolean;
  constructor(
    private readonly apiBase: string,
    private readonly stationId: string,
    private readonly clientOrigin: string,
    private readonly options: ClientRequestOptions,
    readonly key: ApplicationSessionSigner,
  ) {
    const privateKey = (key as Partial<ApplicationSessionKey>).privateKey;
    this.browserKeyNonExtractable = Boolean(
      privateKey &&
        privateKey.extractable === false &&
        privateKey.algorithm.name === 'ECDSA' &&
        'namedCurve' in privateKey.algorithm &&
        privateKey.algorithm.namedCurve === 'P-256' &&
        privateKey.usages.includes('sign'),
    );
    this.options = {
      ...options,
      ...(options.headers ? { headers: { ...options.headers } } : {}),
      ...(options.requestScope
        ? { requestScope: { ...options.requestScope } }
        : {}),
    };
    this.key = Object.freeze({
      publicKey: Object.freeze(keySchema.parse(key.publicKey)),
      sign: key.sign.bind(key),
    });
  }
  async capabilities() {
    return z
      .object({
        version: z.literal(APPLICATION_SESSION_VERSION),
        cookieExchange: z.boolean(),
        cookieAdoption: z.boolean(),
        virtualLogin: z.boolean(),
        proofAlgorithm: z.literal('ES256'),
        stationId: z.literal(this.stationId),
        requestOrigin: origin,
      })
      .strict()
      .parse(
        await read(
          await getJson(`${this.apiBase}${APPLICATION_SESSION_BASE_PATH}`, {
            ...this.options,
            headers: { ...this.options.headers, Origin: this.clientOrigin },
            timeoutMs: 15_000,
            maxResponseBytes: 32768,
          }),
        ),
      );
  }
  private async post(
    path: string,
    body: unknown,
    headers?: Record<string, string>,
  ) {
    return read(
      await mutateJson(
        `${this.apiBase}${APPLICATION_SESSION_BASE_PATH}${path}`,
        'POST',
        {
          ...this.options,
          headers: {
            ...this.options.headers,
            Origin: this.clientOrigin,
            ...headers,
          },
          readOnly: false,
          timeoutMs: 15_000,
          maxResponseBytes: 32768,
        },
        body,
      ),
    );
  }
  async establish(
    credentials?: Record<string, unknown>,
  ): Promise<ApplicationSessionContinuation> {
    const input = credentials ? structuredClone(credentials) : undefined;
    const challenge = challengeSchema.parse(
      await this.post('/challenge', { publicKey: this.key.publicKey }),
    );
    if (challenge.stationId !== this.stationId)
      throw new Error(
        'Application session challenge belongs to another Station.',
      );
    const path = input ? '/login' : '/exchange';
    const proof = await createApplicationSessionProof(
      this.key,
      challenge,
      {
        method: 'POST',
        url: `${this.apiBase}${APPLICATION_SESSION_BASE_PATH}${path}`,
      },
      input ? 'login' : 'exchange',
    );
    return this.continuation(
      await this.post(path, {
        challengeId: challenge.challengeId,
        proof,
        ...(input ? { credentials: input } : {}),
      }),
    );
  }
  /** Adopt same-origin HttpOnly Station and provider cookies without reading or forwarding either cookie value. */
  async adoptCookies(): Promise<ApplicationSessionCookieAdoption> {
    const target = new URL(this.apiBase);
    if (
      !this.browserKeyNonExtractable ||
      target.protocol !== 'https:' ||
      target.username ||
      target.password ||
      target.search ||
      target.hash ||
      target.origin !== this.clientOrigin ||
      new URL(this.clientOrigin).origin !== this.clientOrigin
    )
      throw new Error(
        'Cookie adoption requires a same-origin HTTPS Station and a non-extractable P-256 browser key.',
      );
    const challenge = challengeSchema.parse(
      await this.cookiePost('/adopt-cookie/challenge', {
        publicKey: this.key.publicKey,
      }),
    );
    if (
      challenge.stationId !== this.stationId ||
      challenge.requestOrigin !== target.origin
    )
      throw new Error('Cookie adoption challenge belongs to another Station.');
    const path = '/adopt-cookie/complete';
    const proof = await createApplicationSessionProof(
      this.key,
      challenge,
      {
        method: 'POST',
        url: `${this.apiBase}${APPLICATION_SESSION_BASE_PATH}${path}`,
      },
      'adopt-cookie',
    );
    const result = cookieAdoptionSchema.parse(
      await this.cookiePost(path, {
        challengeId: challenge.challengeId,
        proof,
      }),
    );
    this.continuation(result.continuation);
    if (result.version !== APPLICATION_SESSION_VERSION)
      throw new Error('Cookie adoption result belongs to another Station.');
    return result;
  }
  /** Revoke this relay alias while retaining the provider's account session. */
  async revokeAlias(
    aliasCredential: string,
    continuation: ApplicationSessionContinuation,
  ): Promise<void> {
    const target = new URL(this.apiBase);
    if (
      target.protocol !== 'https:' ||
      target.username ||
      target.password ||
      target.hash ||
      target.origin !== this.clientOrigin
    )
      throw new Error('Relay alias revocation requires same-origin HTTPS.');
    const path = '/adopt-cookie/revoke-alias';
    const headers = await this.headers(continuation, {
      method: 'POST',
      url: `${this.apiBase}${APPLICATION_SESSION_BASE_PATH}${path}`,
    });
    const body = await this.cookiePost(
      path,
      {},
      {
        ...headers,
        Authorization: `Bearer ${opaque.parse(aliasCredential)}`,
      },
      'omit',
    );
    z.object({ revoked: z.literal(true) })
      .strict()
      .parse(body);
  }
  private async cookiePost(
    path: string,
    body: unknown,
    headers: Record<string, string> = {},
    credentials: 'same-origin' | 'omit' = 'same-origin',
  ): Promise<unknown> {
    const configuredTimeout = this.options.timeoutMs;
    const timeoutMs =
      configuredTimeout === null || configuredTimeout === 0
        ? undefined
        : typeof configuredTimeout === 'number' &&
            Number.isFinite(configuredTimeout) &&
            configuredTimeout > 0
          ? configuredTimeout
          : 15_000;
    const deadline = timeoutMs ? AbortSignal.timeout(timeoutMs) : undefined;
    const signal =
      deadline && this.options.signal
        ? AbortSignal.any([deadline, this.options.signal])
        : (deadline ?? this.options.signal);
    const response = await fetch(
      `${this.apiBase}${APPLICATION_SESSION_BASE_PATH}${path}`,
      {
        method: 'POST',
        credentials,
        mode: 'same-origin',
        redirect: 'error',
        ...(signal ? { signal } : {}),
        headers: { 'Content-Type': 'application/json', ...headers },
        body: JSON.stringify(body),
      },
    );
    return read(response);
  }
  async headers(
    continuation: ApplicationSessionContinuation,
    request: { method: string; url: string },
  ): Promise<Record<string, string>> {
    if (new URL(request.url).origin !== new URL(this.apiBase).origin)
      throw new Error(
        'Application session cannot move to another transport origin.',
      );
    this.continuation(continuation);
    return {
      Origin: this.clientOrigin,
      [APPLICATION_SESSION_HEADER]: continuation.credential,
      [APPLICATION_SESSION_PROOF_HEADER]: await createApplicationSessionProof(
        this.key,
        continuation,
        request,
        'request',
        continuation.credential,
      ),
    };
  }
  async renew(
    continuation: ApplicationSessionContinuation,
  ): Promise<ApplicationSessionContinuation> {
    const headers = await this.headers(continuation, {
      method: 'POST',
      url: `${this.apiBase}${APPLICATION_SESSION_BASE_PATH}/renew`,
    });
    const result = this.continuation(await this.post('/renew', {}, headers));
    if (
      result.authorityKey !== continuation.authorityKey ||
      result.principal.id !== continuation.principal.id ||
      result.deviceId !== continuation.deviceId ||
      result.keyThumbprint !== continuation.keyThumbprint
    )
      throw new Error('Application session renewal changed authority.');
    return result;
  }
  async revoke(continuation: ApplicationSessionContinuation): Promise<void> {
    const headers = await this.headers(continuation, {
      method: 'POST',
      url: `${this.apiBase}${APPLICATION_SESSION_BASE_PATH}/revoke`,
    });
    z.object({ revoked: z.literal(true) })
      .strict()
      .parse(await this.post('/revoke', {}, headers));
  }
  private continuation(value: unknown): ApplicationSessionContinuation {
    const result = continuationSchema.parse(value);
    if (
      result.stationId !== this.stationId ||
      result.clientOrigin !== this.clientOrigin
    )
      throw new Error(
        'Application session belongs to another Station or client origin.',
      );
    return result;
  }
}
