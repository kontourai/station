import { createHash, randomBytes } from 'node:crypto';
import type {
  SelfHostedBrokerNativeClientGrantV2,
  SelfHostedBrokerNativeClientSurfaceV2,
  SelfHostedBrokerNativeConnectionOfferV2,
  SelfHostedBrokerNativeGrantRenewedV2,
  SelfHostedBrokerNativeRequestProofClaimsV1,
  SelfHostedBrokerScopeV1,
} from '@kontourai/station-contracts/self-hosted-broker';
import {
  SELF_HOSTED_BROKER_NATIVE_CONNECTION_ANSWER_VERSION,
  SELF_HOSTED_BROKER_NATIVE_CONNECTION_OFFER_VERSION,
  SELF_HOSTED_BROKER_NATIVE_CONNECTION_OPEN_VERSION,
  SELF_HOSTED_BROKER_NATIVE_CONNECTION_OPENED_VERSION,
  SELF_HOSTED_BROKER_NATIVE_CONNECTION_READ_VERSION,
  SELF_HOSTED_BROKER_NATIVE_GRANT_RENEW_VERSION,
  SELF_HOSTED_BROKER_NATIVE_GRANT_RENEWAL_CONFLICT_VERSION,
  SELF_HOSTED_BROKER_NATIVE_GRANT_RENEWED_VERSION,
  SELF_HOSTED_BROKER_NATIVE_GRANT_RETIRE_VERSION,
  SELF_HOSTED_BROKER_NATIVE_REQUEST_PROOF_VERSION,
} from '@kontourai/station-contracts/self-hosted-broker';
import type { BrokerCredential } from './self-hosted-broker-service.js';

const MAX_RESPONSE_BYTES = 1024 * 1024;
const ID = /^[A-Za-z0-9_-]{8,128}$/;
const SDP_LIMIT = 128 * 1024;
/** A request whose outcome may be unknown, but whose broker operation can be reconciled. */
export class BrokerTransientRequestError extends Error {
  constructor(cause: unknown) {
    super('broker_request_transient', { cause });
  }
}
export interface BrokerOffer {
  clientId: string;
  nonce: string;
  offerSdp: string;
  expiresAt: number;
  browserOrigin: string;
}
export type BrokerNativeOffer = SelfHostedBrokerNativeConnectionOfferV2;
function canonicalBase(input: string) {
  const url = new URL(input);
  const loopback = ['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname);
  if (
    url.origin !== input ||
    url.pathname !== '/' ||
    url.search ||
    url.hash ||
    !(url.protocol === 'https:' || (url.protocol === 'http:' && loopback))
  )
    throw new Error('broker_endpoint_invalid');
  return url.origin;
}
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('broker_response_invalid');
  return value as Record<string, unknown>;
}
function exact(value: unknown, keys: string[]) {
  const candidate = record(value);
  if (Object.keys(candidate).sort().join(',') !== [...keys].sort().join(','))
    throw new Error('broker_response_invalid');
  return candidate;
}
async function readBounded(response: Response, signal: AbortSignal) {
  if (!response.body) throw new Error('broker_response_invalid');
  const reader = response.body.getReader();
  const bytes = new Uint8Array(MAX_RESPONSE_BYTES);
  let chunks = 0;
  let total = 0;
  let complete = false;
  try {
    while (true) {
      signal.throwIfAborted();
      const item = await new Promise<Awaited<ReturnType<typeof reader.read>>>(
        (resolve, reject) => {
          const aborted = () => reject(signal.reason);
          signal.addEventListener('abort', aborted, { once: true });
          reader.read().then(
            (value) => {
              signal.removeEventListener('abort', aborted);
              resolve(value);
            },
            (error) => {
              signal.removeEventListener('abort', aborted);
              reject(error);
            },
          );
        },
      );
      if (item.done) {
        complete = true;
        break;
      }
      if (++chunks > 1024) throw new Error('broker_response_too_large');
      total += item.value.byteLength;
      if (total > MAX_RESPONSE_BYTES)
        throw new Error('broker_response_too_large');
      bytes.set(item.value, total - item.value.byteLength);
    }
  } finally {
    if (!complete) void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  signal.throwIfAborted();
  return bytes.subarray(0, total);
}
export class SelfHostedBrokerClient {
  readonly #base: string;
  readonly #scope: Readonly<SelfHostedBrokerScopeV1>;
  readonly #credential: Readonly<BrokerCredential>;
  constructor(
    base: string,
    scope: SelfHostedBrokerScopeV1,
    credential: BrokerCredential,
    private readonly request: typeof fetch = fetch,
    private readonly now: () => number = Date.now,
  ) {
    this.#base = canonicalBase(base);
    this.#scope = Object.freeze(structuredClone(scope));
    this.#credential = Object.freeze(structuredClone(credential));
  }
  async #post(
    path: string,
    body: Record<string, unknown>,
    signal: AbortSignal,
  ) {
    signal.throwIfAborted();
    const boundedSignal = AbortSignal.any([
      signal,
      AbortSignal.timeout(15_000),
    ]);
    let response: Response;
    try {
      response = await this.request(`${this.#base}/broker/v1${path}`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.#credential.secret}`,
          'X-Broker-Credential-Id': this.#credential.id,
          'Content-Type': 'application/json',
          Origin: this.#scope.browserOrigin,
        },
        body: JSON.stringify({ ...body, scope: this.#scope }),
        redirect: 'error',
        signal: boundedSignal,
      });
    } catch (error) {
      if (signal.aborted) throw error;
      if (boundedSignal.aborted || error instanceof TypeError)
        throw new BrokerTransientRequestError(error);
      throw error;
    }
    if (response.status === 429 || response.status >= 500) {
      void response.body?.cancel().catch(() => undefined);
      throw new BrokerTransientRequestError(
        new Error(`broker_request_refused_${response.status}`),
      );
    }
    if (!response.ok) {
      void response.body?.cancel().catch(() => undefined);
      throw new Error(`broker_request_refused_${response.status}`);
    }
    let bytes: Uint8Array;
    try {
      bytes = await readBounded(response, boundedSignal);
    } catch (error) {
      if (
        !signal.aborted &&
        (boundedSignal.aborted || error instanceof TypeError)
      )
        throw new BrokerTransientRequestError(error);
      throw error;
    }
    boundedSignal.throwIfAborted();
    let value: unknown;
    try {
      value = JSON.parse(
        new TextDecoder('utf-8', { fatal: true }).decode(bytes),
      );
    } catch {
      throw new Error('broker_response_invalid');
    }
    return record(value);
  }

  async register(signal: AbortSignal) {
    const value = exact(await this.#post('/leases/register', {}, signal), [
      'registeredAt',
      'revision',
      'expiresAt',
    ]);
    if (
      !Number.isSafeInteger(value.registeredAt) ||
      !Number.isSafeInteger(value.revision) ||
      !Number.isSafeInteger(value.expiresAt)
    )
      throw new Error('broker_response_invalid');
    // A structurally valid broker lease can appear expired while this
    // Station's clock is ahead. Never admit it, but allow startup to recover
    // after clock correction without a process restart.
    if ((value.expiresAt as number) <= this.now())
      throw new BrokerTransientRequestError(
        new Error('broker_lease_not_current'),
      );
    return {
      registeredAt: value.registeredAt as number,
      revision: value.revision as number,
      expiresAt: value.expiresAt as number,
    };
  }
  async renew(expectedRevision: number, signal: AbortSignal) {
    const value = exact(
      await this.#post('/leases/renew', { expectedRevision }, signal),
      ['revision', 'expiresAt'],
    );
    if (
      !Number.isSafeInteger(value.revision) ||
      !Number.isSafeInteger(value.expiresAt) ||
      (value.revision as number) !== expectedRevision + 1
    )
      throw new Error('broker_response_invalid');
    if ((value.expiresAt as number) <= this.now())
      throw new BrokerTransientRequestError(
        new Error('broker_lease_not_current'),
      );
    return {
      revision: value.revision as number,
      expiresAt: value.expiresAt as number,
    };
  }
  async offers(signal: AbortSignal) {
    const value = exact(
      await this.#post('/connections/offers', { limit: 1 }, signal),
      ['offers'],
    );
    if (!Array.isArray(value.offers) || value.offers.length > 1)
      throw new Error('broker_response_invalid');
    return value.offers.map((item) => {
      const offer = exact(item, [
        'clientId',
        'nonce',
        'offerSdp',
        'expiresAt',
        'browserOrigin',
      ]);
      let browserOrigin: string;
      try {
        browserOrigin = canonicalBase(String(offer.browserOrigin));
      } catch {
        throw new Error('broker_response_invalid');
      }
      if (
        typeof offer.clientId !== 'string' ||
        !ID.test(offer.clientId) ||
        typeof offer.nonce !== 'string' ||
        !ID.test(offer.nonce) ||
        typeof offer.offerSdp !== 'string' ||
        offer.offerSdp.length === 0 ||
        Buffer.byteLength(offer.offerSdp) > SDP_LIMIT ||
        !Number.isSafeInteger(offer.expiresAt) ||
        (offer.expiresAt as number) <= this.now() ||
        browserOrigin !== offer.browserOrigin
      )
        throw new Error('broker_response_invalid');
      return offer as unknown as BrokerOffer;
    });
  }
  /** Versioned native offers stay separate from the legacy browser-v1 queue. */
  async nativeOffers(
    surface: SelfHostedBrokerNativeClientSurfaceV2,
    signal: AbortSignal,
  ): Promise<BrokerNativeOffer[]> {
    const value = exact(
      await this.#post(
        '/native/connections/offers',
        {
          limit: 1,
          surface,
          version: SELF_HOSTED_BROKER_NATIVE_CONNECTION_OFFER_VERSION,
        },
        signal,
      ),
      ['offers'],
    );
    if (!Array.isArray(value.offers) || value.offers.length > 1)
      throw new Error('broker_response_invalid');
    return value.offers.map((item) => {
      const offer = exact(item, [
        'version',
        'scope',
        'surface',
        'stationSigningKeyId',
        'stationSigningGeneration',
        'clientId',
        'nonce',
        'offerSdp',
        'expiresAt',
      ]);
      const nativeScope = exact(offer.scope, [
        'stationId',
        'enrollmentId',
        'routingGeneration',
      ]);
      const nativeSurface = exact(offer.surface, [
        'kind',
        'appIdentifier',
        'channel',
        'clientInstanceId',
        'keyThumbprint',
      ]);
      if (
        offer.version !== 'station-broker-native-connection-offer/v2' ||
        nativeScope.stationId !== this.#scope.stationId ||
        nativeScope.enrollmentId !== this.#scope.enrollmentId ||
        nativeScope.routingGeneration !== this.#scope.routingGeneration ||
        nativeSurface.kind !== 'station-native' ||
        nativeSurface.appIdentifier !== surface.appIdentifier ||
        nativeSurface.channel !== surface.channel ||
        nativeSurface.clientInstanceId !== surface.clientInstanceId ||
        nativeSurface.keyThumbprint !== surface.keyThumbprint ||
        typeof offer.stationSigningKeyId !== 'string' ||
        !/^[A-Za-z0-9_-]{43}$/.test(offer.stationSigningKeyId) ||
        !Number.isSafeInteger(offer.stationSigningGeneration) ||
        (offer.stationSigningGeneration as number) < 1 ||
        offer.clientId !== surface.clientInstanceId ||
        typeof offer.nonce !== 'string' ||
        !ID.test(offer.nonce) ||
        typeof offer.offerSdp !== 'string' ||
        offer.offerSdp.length === 0 ||
        Buffer.byteLength(offer.offerSdp) > SDP_LIMIT ||
        !Number.isSafeInteger(offer.expiresAt) ||
        (offer.expiresAt as number) <= this.now()
      )
        throw new Error('broker_response_invalid');
      return offer as unknown as BrokerNativeOffer;
    });
  }
  async answer(
    input: {
      clientId: string;
      nonce: string;
      answerSdp: string;
      stationProof: string;
    },
    signal: AbortSignal,
  ) {
    const value = exact(
      await this.#post('/connections/answer', { connection: input }, signal),
      ['accepted'],
    );
    if (value.accepted !== true) throw new Error('broker_response_invalid');
  }
  async answerNative(
    input: {
      surface: SelfHostedBrokerNativeClientSurfaceV2;
      clientId: string;
      nonce: string;
      stationSigningKeyId: string;
      stationSigningGeneration: number;
      answerSdp: string;
      stationProof: string;
    },
    signal: AbortSignal,
  ) {
    const value = exact(
      await this.#post(
        '/native/connections/answer',
        {
          version: SELF_HOSTED_BROKER_NATIVE_CONNECTION_ANSWER_VERSION,
          surface: input.surface,
          connection: {
            clientId: input.clientId,
            nonce: input.nonce,
            stationSigningKeyId: input.stationSigningKeyId,
            stationSigningGeneration: input.stationSigningGeneration,
            answerSdp: input.answerSdp,
            stationProof: input.stationProof,
          },
        },
        signal,
      ),
      ['accepted'],
    );
    if (value.accepted !== true) throw new Error('broker_response_invalid');
  }
  async withdraw(signal: AbortSignal) {
    const value = exact(await this.#post('/leases/withdraw', {}, signal), [
      'withdrawn',
    ]);
    if (value.withdrawn !== true) throw new Error('broker_response_invalid');
  }
}

async function postNativeJson(
  request: typeof fetch,
  base: string,
  path: string,
  credential: BrokerCredential,
  body: Record<string, unknown>,
  signal: AbortSignal,
  claims: Omit<SelfHostedBrokerNativeRequestProofClaimsV1, 'bodySha256'>,
  sign: (claims: SelfHostedBrokerNativeRequestProofClaimsV1) => Promise<string>,
  allowConflict = false,
) {
  signal.throwIfAborted();
  const boundedSignal = AbortSignal.any([signal, AbortSignal.timeout(15_000)]);
  const exactBody = Buffer.from(JSON.stringify(body), 'utf8');
  const compactProof = await sign({
    ...claims,
    bodySha256: createHash('sha256').update(exactBody).digest('base64url'),
  });
  let response: Response;
  try {
    response = await request(`${base}/broker/v1${path}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${credential.secret}`,
        'X-Broker-Credential-Id': credential.id,
        'X-Station-Native-Proof': compactProof,
        'Content-Type': 'application/json',
      },
      body: exactBody,
      redirect: 'error',
      signal: boundedSignal,
    });
  } catch (error) {
    if (signal.aborted) throw error;
    if (boundedSignal.aborted || error instanceof TypeError)
      throw new BrokerTransientRequestError(error);
    throw error;
  }
  if (response.status === 429 || response.status >= 500) {
    void response.body?.cancel().catch(() => undefined);
    throw new BrokerTransientRequestError(
      new Error(`broker_request_refused_${response.status}`),
    );
  }
  if (response.status === 409 && allowConflict) {
    const bytes = await readBounded(response, boundedSignal);
    boundedSignal.throwIfAborted();
    try {
      return record(
        JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)),
      );
    } catch {
      throw new Error('broker_response_invalid');
    }
  }
  if (!response.ok) {
    void response.body?.cancel().catch(() => undefined);
    throw new Error(`broker_request_refused_${response.status}`);
  }
  const bytes = await readBounded(response, boundedSignal);
  boundedSignal.throwIfAborted();
  try {
    return record(
      JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)),
    );
  } catch {
    throw new Error('broker_response_invalid');
  }
}

export class BrokerNativeGrantRenewalConflictError extends Error {
  constructor(readonly currentExpiresAt: number) {
    super('broker_native_grant_renewal_conflict');
  }
}

/** Fixed native signaling client. It has no Origin, cookie or proxy operation. */
export class SelfHostedBrokerNativeClient {
  readonly #base: string;
  readonly #grant: Readonly<SelfHostedBrokerNativeClientGrantV2>;
  #expiresAt: number;
  #state: 'active' | 'retiring' | 'retired' = 'active';
  constructor(
    grant: SelfHostedBrokerNativeClientGrantV2,
    private readonly sign: (
      claims: SelfHostedBrokerNativeRequestProofClaimsV1,
    ) => Promise<string>,
    private readonly request: typeof fetch = fetch,
    private readonly now: () => number = Date.now,
  ) {
    if (
      grant.version !== 'station-broker-native-client-grant/v2' ||
      !grant.credential ||
      !ID.test(grant.credential.id) ||
      !/^[A-Za-z0-9_-]{43}$/.test(grant.credential.secret) ||
      !Number.isSafeInteger(grant.expiresAt)
    )
      throw new Error('broker_native_grant_invalid');
    this.#base = canonicalBase(grant.brokerOrigin);
    this.#grant = Object.freeze(structuredClone(grant));
    this.#expiresAt = grant.expiresAt;
  }
  #assertActive() {
    if (this.#state !== 'active')
      throw new Error('broker_native_client_retired');
    if (this.#expiresAt <= this.now())
      throw new Error('broker_native_grant_expired');
  }
  #requestClaims(
    path: SelfHostedBrokerNativeRequestProofClaimsV1['path'],
    purpose: SelfHostedBrokerNativeRequestProofClaimsV1['purpose'],
  ): Omit<SelfHostedBrokerNativeRequestProofClaimsV1, 'bodySha256'> {
    const now = Math.floor(this.now() / 1000);
    return {
      version: SELF_HOSTED_BROKER_NATIVE_REQUEST_PROOF_VERSION,
      aud: this.#grant.brokerOrigin,
      purpose,
      brokerOrigin: this.#grant.brokerOrigin,
      method: 'POST',
      path,
      grantId: this.#grant.credential.id,
      scope: this.#grant.scope,
      surface: this.#grant.surface,
      stationSigningKeyId: this.#grant.stationSigningKeyId,
      stationSigningGeneration: this.#grant.stationSigningGeneration,
      ath: createHash('sha256')
        .update(this.#grant.credential.secret)
        .digest('base64url'),
      jti: randomBytes(32).toString('base64url'),
      iat: now,
      exp: now + 30,
    };
  }
  async open(input: { nonce: string; offerSdp: string }, signal: AbortSignal) {
    this.#assertActive();
    if (
      !ID.test(input.nonce) ||
      typeof input.offerSdp !== 'string' ||
      input.offerSdp.length === 0 ||
      Buffer.byteLength(input.offerSdp) > SDP_LIMIT
    )
      throw new Error('broker_request_invalid');
    const value = exact(
      await postNativeJson(
        this.request,
        this.#base,
        '/native/connections/open',
        this.#grant.credential,
        {
          scope: this.#grant.scope,
          surface: this.#grant.surface,
          connection: {
            version: SELF_HOSTED_BROKER_NATIVE_CONNECTION_OPEN_VERSION,
            nonce: input.nonce,
            offerSdp: input.offerSdp,
          },
        },
        signal,
        this.#requestClaims(
          '/broker/v1/native/connections/open',
          'station-native-connection-open-v2',
        ),
        this.sign,
      ),
      ['version', 'expiresAt'],
    );
    if (
      value.version !== SELF_HOSTED_BROKER_NATIVE_CONNECTION_OPENED_VERSION ||
      !Number.isSafeInteger(value.expiresAt) ||
      (value.expiresAt as number) <= this.now()
    )
      throw new Error('broker_response_invalid');
    return {
      version: SELF_HOSTED_BROKER_NATIVE_CONNECTION_OPENED_VERSION,
      expiresAt: value.expiresAt as number,
    };
  }
  async read(nonce: string, signal: AbortSignal) {
    this.#assertActive();
    if (!ID.test(nonce)) throw new Error('broker_request_invalid');
    const value = exact(
      await postNativeJson(
        this.request,
        this.#base,
        '/native/connections/read',
        this.#grant.credential,
        {
          version: SELF_HOSTED_BROKER_NATIVE_CONNECTION_READ_VERSION,
          scope: this.#grant.scope,
          surface: this.#grant.surface,
          nonce,
        },
        signal,
        this.#requestClaims(
          '/broker/v1/native/connections/read',
          'station-native-connection-read-v2',
        ),
        this.sign,
      ),
      ['version', 'answerSdp', 'stationProof', 'expiresAt'],
    );
    if (
      value.version !== SELF_HOSTED_BROKER_NATIVE_CONNECTION_ANSWER_VERSION ||
      (value.answerSdp !== null && typeof value.answerSdp !== 'string') ||
      (value.stationProof !== null && typeof value.stationProof !== 'string') ||
      (value.answerSdp === null) !== (value.stationProof === null) ||
      (typeof value.answerSdp === 'string' &&
        (value.answerSdp.length === 0 ||
          Buffer.byteLength(value.answerSdp) > SDP_LIMIT)) ||
      (typeof value.stationProof === 'string' &&
        (value.stationProof.length === 0 ||
          Buffer.byteLength(value.stationProof) > 4096)) ||
      !Number.isSafeInteger(value.expiresAt) ||
      (value.expiresAt as number) <= this.now()
    )
      throw new Error('broker_response_invalid');
    return {
      version: SELF_HOSTED_BROKER_NATIVE_CONNECTION_ANSWER_VERSION,
      answerSdp: value.answerSdp as string | null,
      stationProof: value.stationProof as string | null,
      expiresAt: value.expiresAt as number,
    };
  }
  /** Proof-bound renewal is allowed from half-life and through the 7-day grace. */
  async renew(
    renewalId: string,
    signal: AbortSignal,
  ): Promise<SelfHostedBrokerNativeGrantRenewedV2> {
    if (this.#state !== 'active')
      throw new Error('broker_native_client_retired');
    if (!/^[A-Za-z0-9_-]{8,128}$/.test(renewalId))
      throw new Error('broker_request_invalid');
    const body = {
      version: SELF_HOSTED_BROKER_NATIVE_GRANT_RENEW_VERSION,
      scope: this.#grant.scope,
      surface: this.#grant.surface,
      renewalId,
      expectedExpiresAt: this.#expiresAt,
    };
    const response = await postNativeJson(
      this.request,
      this.#base,
      '/native/grants/renew',
      this.#grant.credential,
      body,
      signal,
      this.#requestClaims(
        '/broker/v1/native/grants/renew',
        'station-native-grant-renew-v2',
      ),
      this.sign,
      true,
    );
    if (
      response.version ===
      SELF_HOSTED_BROKER_NATIVE_GRANT_RENEWAL_CONFLICT_VERSION
    ) {
      const conflict = exact(response, [
        'version',
        'renewalId',
        'currentExpiresAt',
      ]);
      if (
        conflict.renewalId !== renewalId ||
        !Number.isSafeInteger(conflict.currentExpiresAt) ||
        (conflict.currentExpiresAt as number) < 1
      )
        throw new Error('broker_response_invalid');
      this.#expiresAt = conflict.currentExpiresAt as number;
      throw new BrokerNativeGrantRenewalConflictError(this.#expiresAt);
    }
    const value = exact(response, ['version', 'renewalId', 'expiresAt']);
    if (
      value.version !== SELF_HOSTED_BROKER_NATIVE_GRANT_RENEWED_VERSION ||
      value.renewalId !== renewalId ||
      !Number.isSafeInteger(value.expiresAt) ||
      (value.expiresAt as number) <= body.expectedExpiresAt ||
      (value.expiresAt as number) > this.now() + 24 * 60 * 60_000 + 5_000
    )
      throw new Error('broker_response_invalid');
    this.#expiresAt = value.expiresAt as number;
    return {
      version: SELF_HOSTED_BROKER_NATIVE_GRANT_RENEWED_VERSION,
      renewalId,
      expiresAt: this.#expiresAt,
    };
  }
  async retire(signal: AbortSignal) {
    if (this.#state === 'retired')
      return {
        version: SELF_HOSTED_BROKER_NATIVE_GRANT_RETIRE_VERSION,
        retired: true as const,
      };
    this.#state = 'retiring';
    const value = exact(
      await postNativeJson(
        this.request,
        this.#base,
        '/native/grants/retire',
        this.#grant.credential,
        {
          version: SELF_HOSTED_BROKER_NATIVE_GRANT_RETIRE_VERSION,
          scope: this.#grant.scope,
          surface: this.#grant.surface,
        },
        signal,
        this.#requestClaims(
          '/broker/v1/native/grants/retire',
          'station-native-grant-retire-v2',
        ),
        this.sign,
      ),
      ['version', 'retired'],
    );
    if (
      value.version !== SELF_HOSTED_BROKER_NATIVE_GRANT_RETIRE_VERSION ||
      value.retired !== true
    )
      throw new Error('broker_response_invalid');
    this.#state = 'retired';
    return {
      version: SELF_HOSTED_BROKER_NATIVE_GRANT_RETIRE_VERSION,
      retired: true as const,
    };
  }
}
