// Request handling for the Station push gateway, independent of the Worker
// runtime so it can be exercised directly in tests.
import { FcmSender, type SendOutcome, type ServiceAccount } from './fcm.ts';
import { parseSendRequest } from './send-request.ts';
import { bodyHash, verifyStationRequest } from './station-auth.ts';

const MAX_BODY_BYTES = 8 * 1024;

export interface RateLimiter {
  limit(options: { key: string }): Promise<{ success: boolean }>;
}

export interface GatewayConfig {
  audiences: readonly string[];
  allowedPackages: readonly string[];
  serviceAccount: ServiceAccount | null;
  /** Before any work: bounds what one client address can make the gateway do. */
  perIpLimiter: RateLimiter;
  /** Signed requests only, so unsigned junk cannot exhaust it. */
  globalLimiter: RateLimiter;
  perKeyLimiter: RateLimiter;
  /** Keyed on the push token: key rotation cannot evade it. */
  perTokenLimiter: RateLimiter;
  fetchImpl?: typeof fetch;
  nowSeconds?: () => number;
}

const json = (status: number, body: Record<string, unknown>) =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    },
  });

// Upstream status is not passed back: it would only make the gateway a better
// oracle for whether a stolen token is live.
const OUTCOME_RESPONSES: Record<SendOutcome['kind'], [number, string]> = {
  sent: [200, 'sent'],
  unregistered: [410, 'unregistered'],
  rejected: [422, 'rejected'],
  unavailable: [503, 'unavailable'],
};

// Senders are cached per isolate so the Google access token is reused.
const senders = new WeakMap<ServiceAccount, FcmSender>();

/**
 * Reads at most `limit` bytes. `content-length` is only a hint (it can be
 * absent or false with chunked uploads), so the stream itself is cut off
 * rather than buffered whole before checking.
 */
async function readBounded(
  request: Request,
  limit: number,
): Promise<Uint8Array<ArrayBuffer> | null> {
  if (!request.body) return new Uint8Array(0);
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > limit) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.length;
  }
  return body;
}

export async function handleRequest(
  request: Request,
  config: GatewayConfig,
): Promise<Response> {
  const url = new URL(request.url);
  if (url.pathname === '/health' && request.method === 'GET')
    return json(200, { ok: true });
  if (url.pathname !== '/v1/fcm/send') return json(404, { error: 'not found' });
  if (request.method !== 'POST')
    return json(405, { error: 'method not allowed' });
  if (!config.serviceAccount)
    return json(503, { error: 'push delivery is not configured' });

  const clientIp = request.headers.get('cf-connecting-ip') ?? 'unknown';
  if (!(await config.perIpLimiter.limit({ key: clientIp })).success) {
    return json(429, { error: 'rate limited' });
  }
  const body = await readBounded(request, MAX_BODY_BYTES);
  if (!body) return json(413, { error: 'body too large' });

  const auth = await verifyStationRequest({
    authorization: request.headers.get('authorization'),
    body,
    audiences: config.audiences,
    nowSeconds: (config.nowSeconds ?? (() => Math.floor(Date.now() / 1000)))(),
  });
  // Reasons are returned to the caller, who holds the key and needs them to
  // debug; they reveal nothing about other Stations.
  if (!auth.ok) return json(401, { error: auth.reason });
  if (!(await config.globalLimiter.limit({ key: 'global' })).success) {
    return json(429, { error: 'rate limited' });
  }
  if (
    !(await config.perKeyLimiter.limit({ key: auth.keyThumbprint })).success
  ) {
    return json(429, { error: 'rate limited' });
  }

  const parsed = parseSendRequest(body, config.allowedPackages);
  if (!parsed.ok) return json(400, { error: parsed.reason });
  const tokenKey = await bodyHash(
    new TextEncoder().encode(parsed.request.token),
  );
  if (!(await config.perTokenLimiter.limit({ key: tokenKey })).success) {
    return json(429, { error: 'rate limited' });
  }

  // The phone pins its own Station's key thumbprint and drops anything else,
  // so a key that verified here still cannot speak for another Station.
  const stamped = {
    ...parsed.request,
    data: { ...parsed.request.data, station_key: auth.keyThumbprint },
  };

  let sender = senders.get(config.serviceAccount);
  if (!sender) {
    sender = new FcmSender(config.serviceAccount, config.fetchImpl);
    senders.set(config.serviceAccount, sender);
  }
  const outcome = await sender.send(stamped);
  const [status, result] = OUTCOME_RESPONSES[outcome.kind];
  return json(status, { result });
}
