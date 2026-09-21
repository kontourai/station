import type { SelfHostedBrokerScopeV1 } from '@kontourai/station-contracts/self-hosted-broker';
import { raceOwnedLifetime } from './browserTransportWait.js';

const MAX_RESPONSE_BYTES = 1024 * 1024;
const MAX_RESPONSE_CHUNKS = 1024;
const MAX_SDP_BYTES = 128 * 1024;
const MAX_PROOF_BYTES = 4096;
const SAFE_ID = /^[A-Za-z0-9_-]{8,128}$/;
const OPAQUE = /^[A-Za-z0-9_-]{43}$/;

export interface BrowserRoutingCredentialSnapshot {
  readonly id: string;
  readonly secret: string;
  isCurrent(): boolean;
}
export interface BrowserRoutingCredentialProvider {
  capture(): BrowserRoutingCredentialSnapshot;
}
export interface BrokerBrowserConnection {
  readonly clientId: string;
  readonly nonce: string;
}
export type BrokerBrowserAnswer =
  | { readonly kind: 'pending'; readonly expiresAt: number }
  | {
      readonly kind: 'answered';
      readonly answerSdp: string;
      readonly stationProof: string;
      readonly expiresAt: number;
    };

function canonicalOrigin(value: string, label: string) {
  const url = new URL(value);
  if (
    url.origin !== value ||
    url.pathname !== '/' ||
    url.search ||
    url.hash ||
    url.username ||
    url.password
  )
    throw new Error(`${label}_invalid`);
  if (url.protocol === 'https:') return url.origin;
  // Approved self-hosted contract: plain HTTP only for loopback (local free profile).
  if (url.protocol === 'http:') {
    const host = url.hostname.toLowerCase();
    if (
      host === '127.0.0.1' ||
      host === 'localhost' ||
      host === '[::1]' ||
      host === '::1'
    )
      return url.origin;
  }
  throw new Error(`${label}_invalid`);
}
function exact(value: unknown, keys: readonly string[]) {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('broker_response_invalid');
  const record = value as Record<string, unknown>;
  if (Object.keys(record).sort().join(',') !== [...keys].sort().join(','))
    throw new Error('broker_response_invalid');
  return record;
}
function byteLength(value: string) {
  return new TextEncoder().encode(value).byteLength;
}
function validScope(value: SelfHostedBrokerScopeV1, browserOrigin: string) {
  const copy = structuredClone(value);
  if (
    typeof copy.stationId !== 'string' ||
    !copy.stationId ||
    typeof copy.enrollmentId !== 'string' ||
    !copy.enrollmentId ||
    !Number.isSafeInteger(copy.routingGeneration) ||
    copy.routingGeneration < 1 ||
    canonicalOrigin(copy.browserOrigin, 'broker_browser_origin') !==
      browserOrigin
  )
    throw new Error('broker_scope_invalid');
  return Object.freeze(copy);
}
async function boundedJson(
  response: Response,
  signal: AbortSignal,
  onCancelResponse: () => void,
) {
  if (response.redirected || !response.body)
    throw new Error('broker_response_invalid');
  const reader = response.body.getReader();
  const output = new Uint8Array(MAX_RESPONSE_BYTES);
  let total = 0;
  let chunks = 0;
  let complete = false;
  try {
    while (true) {
      signal.throwIfAborted();
      const item = await raceOwnedLifetime(reader.read(), signal);
      if (item.done) {
        complete = true;
        break;
      }
      if (++chunks > MAX_RESPONSE_CHUNKS)
        throw new Error('broker_response_too_large');
      total += item.value.byteLength;
      if (total > output.byteLength)
        throw new Error('broker_response_too_large');
      output.set(item.value, total - item.value.byteLength);
    }
  } finally {
    // Stalled-reader safety: a caller abort or oversize body must cancel the
    // underlying reader so no stream stays pinned open.
    if (!complete) {
      onCancelResponse();
      void reader.cancel().catch(() => {});
    }
    reader.releaseLock();
  }
  signal.throwIfAborted();
  try {
    return JSON.parse(
      new TextDecoder('utf-8', { fatal: true }).decode(
        output.subarray(0, total),
      ),
    ) as unknown;
  } catch {
    throw new Error('broker_response_invalid');
  }
}

export class SelfHostedBrokerBrowserClient {
  readonly #brokerOrigin: string;
  readonly #browserOrigin: string;
  readonly #scope: Readonly<SelfHostedBrokerScopeV1>;
  readonly #credentials: BrowserRoutingCredentialProvider;
  readonly #request: typeof fetch;
  readonly #now: () => number;
  readonly #onCancelResponse: () => void;

  constructor(input: {
    brokerOrigin: string;
    browserOrigin: string;
    scope: SelfHostedBrokerScopeV1;
    credentials: BrowserRoutingCredentialProvider;
    request?: typeof fetch;
    now?: () => number;
    onCancelResponse?: () => void;
  }) {
    this.#brokerOrigin = canonicalOrigin(input.brokerOrigin, 'broker_origin');
    this.#browserOrigin = canonicalOrigin(
      input.browserOrigin,
      'broker_browser_origin',
    );
    // Bind to the actual browser origin via location: never trust a caller
    // supplied string when a real location is available. Missing location is
    // not a fabricated browser identity — construction without location uses
    // the caller value, but any present location.origin must match exactly.
    const actual = (globalThis as { location?: { origin?: unknown } }).location
      ?.origin;
    if (typeof actual === 'string' && actual !== this.#browserOrigin)
      throw new Error('broker_browser_origin_invalid');
    this.#scope = validScope(input.scope, this.#browserOrigin);
    // Freeze scalar/provider references at construction: later mutation of
    // the input object cannot re-point this client.
    this.#credentials = input.credentials;
    this.#request = input.request ?? fetch;
    this.#now = input.now ?? Date.now;
    this.#onCancelResponse = input.onCancelResponse ?? (() => {});
  }

  get scope(): Readonly<SelfHostedBrokerScopeV1> {
    return this.#scope;
  }

  async #post(
    path: '/stations/status' | '/connections' | '/connections/read',
    body: Record<string, unknown>,
    signal: AbortSignal,
  ) {
    signal.throwIfAborted();
    // Freeze the credential snapshot used for this attempt; lifetime is tied
    // to exactly this snapshot and rechecked before AND after every await.
    const credential = this.#credentials.capture();
    const credentialId = credential.id;
    const credentialSecret = credential.secret;
    const credentialIsCurrent = credential.isCurrent.bind(credential);
    if (
      !SAFE_ID.test(credentialId) ||
      !OPAQUE.test(credentialSecret) ||
      credentialIsCurrent() !== true
    )
      throw new Error('broker_credential_unavailable');
    // Owned bounded composition: manual deadline, no AbortSignal.any fallback
    // that could silently drop the protocol bound on old runtimes.
    const owned = new AbortController();
    if (signal.aborted) owned.abort(signal.reason ?? new Error('cancelled'));
    const onParent = () => owned.abort(signal.reason ?? new Error('cancelled'));
    signal.addEventListener('abort', onParent, { once: true });
    const timer = setTimeout(
      () => owned.abort(new Error('browser_transport_timeout')),
      15_000,
    );
    const bounded = owned.signal;
    try {
      const response = await this.#request(
        `${this.#brokerOrigin}/broker/v1${path}`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${credentialSecret}`,
            'Content-Type': 'application/json',
            'X-Broker-Credential-Id': credentialId,
          },
          body: JSON.stringify({ ...body, scope: this.#scope }),
          redirect: 'error',
          credentials: 'omit',
          signal: bounded,
        },
      );
      if (credentialIsCurrent() !== true)
        throw new Error('broker_credential_unavailable');
      const value = await boundedJson(
        response,
        bounded,
        this.#onCancelResponse,
      );
      if (credentialIsCurrent() !== true)
        throw new Error('broker_credential_unavailable');
      if (!response.ok)
        throw new Error(`broker_request_refused_${response.status}`);
      return value;
    } finally {
      clearTimeout(timer);
      signal.removeEventListener('abort', onParent);
    }
  }

  async status(signal: AbortSignal) {
    const value = exact(await this.#post('/stations/status', {}, signal), [
      'state',
      'routingGeneration',
      'expiresAt',
    ]);
    if (
      (value.state !== 'online' && value.state !== 'offline') ||
      value.routingGeneration !== this.#scope.routingGeneration ||
      !Number.isSafeInteger(value.expiresAt)
    )
      throw new Error('broker_response_invalid');
    return {
      state: value.state,
      routingGeneration: value.routingGeneration as number,
      expiresAt: value.expiresAt as number,
    };
  }

  async open(
    connection: BrokerBrowserConnection & { readonly offerSdp: string },
    signal: AbortSignal,
  ) {
    if (
      !SAFE_ID.test(connection.clientId) ||
      !OPAQUE.test(connection.nonce) ||
      typeof connection.offerSdp !== 'string' ||
      !connection.offerSdp ||
      byteLength(connection.offerSdp) > MAX_SDP_BYTES
    )
      throw new Error('broker_connection_invalid');
    const value = exact(
      await this.#post('/connections', { connection }, signal),
      ['expiresAt'],
    );
    if (
      !Number.isSafeInteger(value.expiresAt) ||
      (value.expiresAt as number) <= this.#now()
    )
      throw new Error('broker_response_invalid');
    return { expiresAt: value.expiresAt as number };
  }

  async read(connection: BrokerBrowserConnection, signal: AbortSignal) {
    if (!SAFE_ID.test(connection.clientId) || !OPAQUE.test(connection.nonce))
      throw new Error('broker_connection_invalid');
    const value = exact(
      await this.#post(
        '/connections/read',
        { clientId: connection.clientId, nonce: connection.nonce },
        signal,
      ),
      ['answerSdp', 'stationProof', 'expiresAt'],
    );
    if (
      !Number.isSafeInteger(value.expiresAt) ||
      (value.expiresAt as number) <= this.#now()
    )
      throw new Error('broker_response_invalid');
    if (value.answerSdp === null && value.stationProof === null)
      return {
        kind: 'pending',
        expiresAt: value.expiresAt as number,
      } as const;
    if (
      typeof value.answerSdp !== 'string' ||
      !value.answerSdp ||
      byteLength(value.answerSdp) > MAX_SDP_BYTES ||
      typeof value.stationProof !== 'string' ||
      !value.stationProof ||
      byteLength(value.stationProof) > MAX_PROOF_BYTES
    )
      throw new Error('broker_response_invalid');
    return {
      kind: 'answered',
      answerSdp: value.answerSdp,
      stationProof: value.stationProof,
      expiresAt: value.expiresAt as number,
    } as const;
  }
}
