import {
  APPLICATION_SESSION_BASE_PATH,
  APPLICATION_SESSION_HEADER,
  APPLICATION_SESSION_PROOF_HEADER,
  APPLICATION_SESSION_PROOF_TYPE,
  APPLICATION_SESSION_VERSION,
  type ApplicationSessionChallenge,
  type ApplicationSessionContinuation,
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

export interface ApplicationSessionKey {
  readonly privateKey: CryptoKey;
  readonly publicKey: ApplicationSessionPublicKey;
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
const base64url = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/, '');
const encode = (value: unknown) =>
  base64url(new TextEncoder().encode(JSON.stringify(value)));
const hash = async (value: string) =>
  base64url(
    new Uint8Array(
      await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)),
    ),
  );

/** May be structured-cloned into a dedicated IndexedDB custody store; never export the private key. */
export async function createApplicationSessionKey(): Promise<ApplicationSessionKey> {
  const pair = await crypto.subtle.generateKey(
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['sign', 'verify'],
  );
  const jwk = await crypto.subtle.exportKey('jwk', pair.publicKey);
  return {
    privateKey: pair.privateKey,
    publicKey: keySchema.parse({
      kty: jwk.kty,
      crv: jwk.crv,
      x: jwk.x,
      y: jwk.y,
    }),
  };
}

/** Station's versioned virtual-request profile; secure transport still owns message integrity. */
export async function createApplicationSessionProof(
  key: ApplicationSessionKey,
  binding: Pick<
    ApplicationSessionChallenge,
    'nonce' | 'stationId' | 'requestOrigin'
  >,
  request: { method: string; url: string },
  purpose: 'request' | 'exchange' | 'login',
  credential?: string,
): Promise<string> {
  if (
    key.privateKey.extractable ||
    key.privateKey.algorithm.name !== 'ECDSA' ||
    !('namedCurve' in key.privateKey.algorithm) ||
    key.privateKey.algorithm.namedCurve !== 'P-256'
  )
    throw new Error(
      'Application sessions require a non-extractable P-256 key.',
    );
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
  const signature = await crypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' },
    key.privateKey,
    new TextEncoder().encode(input),
  );
  return `${input}.${base64url(new Uint8Array(signature))}`;
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
  constructor(
    private readonly apiBase: string,
    private readonly stationId: string,
    private readonly clientOrigin: string,
    private readonly options: ClientRequestOptions,
    readonly key: ApplicationSessionKey,
  ) {
    this.options = {
      ...options,
      ...(options.headers ? { headers: { ...options.headers } } : {}),
      ...(options.requestScope
        ? { requestScope: { ...options.requestScope } }
        : {}),
    };
    this.key = Object.freeze({
      privateKey: key.privateKey,
      publicKey: Object.freeze(keySchema.parse(key.publicKey)),
    });
  }
  async capabilities() {
    return z
      .object({
        version: z.literal(APPLICATION_SESSION_VERSION),
        cookieExchange: z.boolean(),
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
