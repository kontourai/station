import type { SelfHostedBrokerScopeV1 } from '@kontourai/station-contracts/self-hosted-broker';
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
}
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
      !Number.isSafeInteger(value.expiresAt) ||
      (value.expiresAt as number) <= this.now()
    )
      throw new Error('broker_response_invalid');
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
      (value.revision as number) !== expectedRevision + 1 ||
      (value.expiresAt as number) <= this.now()
    )
      throw new Error('broker_response_invalid');
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
      const offer = exact(item, ['clientId', 'nonce', 'offerSdp', 'expiresAt']);
      if (
        typeof offer.clientId !== 'string' ||
        !ID.test(offer.clientId) ||
        typeof offer.nonce !== 'string' ||
        !ID.test(offer.nonce) ||
        typeof offer.offerSdp !== 'string' ||
        offer.offerSdp.length === 0 ||
        Buffer.byteLength(offer.offerSdp) > SDP_LIMIT ||
        !Number.isSafeInteger(offer.expiresAt) ||
        (offer.expiresAt as number) <= this.now()
      )
        throw new Error('broker_response_invalid');
      return offer as unknown as BrokerOffer;
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
  async withdraw(signal: AbortSignal) {
    const value = exact(await this.#post('/leases/withdraw', {}, signal), [
      'withdrawn',
    ]);
    if (value.withdrawn !== true) throw new Error('broker_response_invalid');
  }
}
