// Request handling for the Station push gateway, independent of the Worker
// runtime so it can be exercised directly in tests.
import { FcmSender, type SendOutcome, type ServiceAccount } from './fcm.ts';
import { parseSendRequest } from './send-request.ts';
import { verifyStationRequest } from './station-auth.ts';

const MAX_BODY_BYTES = 8 * 1024;

export interface RateLimiter {
  limit(options: { key: string }): Promise<{ success: boolean }>;
}

export interface GatewayConfig {
  audiences: readonly string[];
  allowedPackages: readonly string[];
  serviceAccount: ServiceAccount | null;
  perKeyLimiter: RateLimiter;
  globalLimiter: RateLimiter;
  fetchImpl?: typeof fetch;
  nowSeconds?: () => number;
}

const json = (status: number, body: Record<string, unknown>) =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json',
      'cache-control': 'no-store',
    },
  });

const OUTCOME_RESPONSES: Record<SendOutcome['kind'], [number, string]> = {
  sent: [200, 'sent'],
  unregistered: [410, 'unregistered'],
  rejected: [422, 'rejected'],
  unavailable: [503, 'unavailable'],
};

// Senders are cached per isolate so the Google access token is reused.
const senders = new WeakMap<ServiceAccount, FcmSender>();

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

  const declaredLength = Number(request.headers.get('content-length') ?? '0');
  if (declaredLength > MAX_BODY_BYTES)
    return json(413, { error: 'body too large' });
  const body = new Uint8Array(await request.arrayBuffer());
  if (body.length > MAX_BODY_BYTES)
    return json(413, { error: 'body too large' });

  // Cheap global cap first, so a flood of junk cannot spend signature checks.
  if (!(await config.globalLimiter.limit({ key: 'global' })).success) {
    return json(429, { error: 'rate limited' });
  }
  const auth = await verifyStationRequest({
    authorization: request.headers.get('authorization'),
    body,
    audiences: config.audiences,
    nowSeconds: (config.nowSeconds ?? (() => Math.floor(Date.now() / 1000)))(),
  });
  // Reasons are returned to the caller, who holds the key and needs them to
  // debug; they reveal nothing about other Stations.
  if (!auth.ok) return json(401, { error: auth.reason });
  if (
    !(await config.perKeyLimiter.limit({ key: auth.keyThumbprint })).success
  ) {
    return json(429, { error: 'rate limited' });
  }

  const parsed = parseSendRequest(body, config.allowedPackages);
  if (!parsed.ok) return json(400, { error: parsed.reason });

  let sender = senders.get(config.serviceAccount);
  if (!sender) {
    sender = new FcmSender(config.serviceAccount, config.fetchImpl ?? fetch);
    senders.set(config.serviceAccount, sender);
  }
  const outcome = await sender.send(parsed.request);
  const [status, result] = OUTCOME_RESPONSES[outcome.kind];
  return json(status, {
    result,
    ...('status' in outcome ? { upstreamStatus: outcome.status } : {}),
  });
}
