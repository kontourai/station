import type { SelfHostedBrokerScopeV1 } from '@kontourai/station-contracts/self-hosted-broker';
import type { BrokerCredential } from './self-hosted-broker-service.js';

const MAX_RESPONSE_BYTES = 256 * 1024;
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
export class SelfHostedBrokerClient {
  readonly #base: string;
  constructor(
    base: string,
    private readonly scope: SelfHostedBrokerScopeV1,
    private readonly credential: BrokerCredential,
    private readonly request: typeof fetch = fetch,
  ) {
    this.#base = canonicalBase(base);
  }
  async #post(
    path: string,
    body: Record<string, unknown>,
    signal: AbortSignal,
  ) {
    const response = await this.request(`${this.#base}/broker/v1${path}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.credential.secret}`,
        'X-Broker-Credential-Id': this.credential.id,
        'Content-Type': 'application/json',
        Origin: this.scope.browserOrigin,
      },
      body: JSON.stringify({ ...body, scope: this.scope }),
      redirect: 'error',
      signal,
    });
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > MAX_RESPONSE_BYTES)
      throw new Error('broker_response_too_large');
    let value: unknown;
    try {
      value = JSON.parse(
        new TextDecoder('utf-8', { fatal: true }).decode(bytes),
      );
    } catch {
      throw new Error('broker_response_invalid');
    }
    if (!response.ok)
      throw new Error(`broker_request_refused_${response.status}`);
    return record(value);
  }
  async register(signal: AbortSignal) {
    const value = exact(await this.#post('/leases/register', {}, signal), [
      'registeredAt',
    ]);
    if (!Number.isSafeInteger(value.registeredAt))
      throw new Error('broker_response_invalid');
    return { registeredAt: value.registeredAt as number };
  }
  async renew(expectedRevision: number, signal: AbortSignal) {
    const value = exact(
      await this.#post('/leases/renew', { expectedRevision }, signal),
      ['revision', 'expiresAt'],
    );
    if (
      !Number.isSafeInteger(value.revision) ||
      !Number.isSafeInteger(value.expiresAt)
    )
      throw new Error('broker_response_invalid');
    return {
      revision: value.revision as number,
      expiresAt: value.expiresAt as number,
    };
  }
  async offers(signal: AbortSignal) {
    const value = exact(await this.#post('/connections/offers', {}, signal), [
      'offers',
    ]);
    if (!Array.isArray(value.offers) || value.offers.length > 32)
      throw new Error('broker_response_invalid');
    return value.offers.map((item) => {
      const offer = exact(item, ['clientId', 'nonce', 'offerSdp', 'expiresAt']);
      if (
        typeof offer.clientId !== 'string' ||
        typeof offer.nonce !== 'string' ||
        typeof offer.offerSdp !== 'string' ||
        !Number.isSafeInteger(offer.expiresAt)
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
