// The public Lite telemetry receiver on Cloudflare: routes, edge rate limits,
// body caps and operator authentication. All state and every decision about
// a ping live in the LiteReceiver Durable Object (receiver.ts), which shares
// its rules with the Node receiver through lite-core.ts.
import { createHash, timingSafeEqual } from 'node:crypto';
import {
  ipFamily,
  LITE_BODY_LIMIT_BYTES,
  networkKey,
  utcDay,
} from '../../../packages/telemetry-broker/src/lite-core.ts';
import {
  DASHBOARD_HTML,
  DASHBOARD_JS,
} from '../../../packages/telemetry-broker/src/public-dashboard.ts';
import { INSIGHTS_HTML, INSIGHTS_JS } from './insights-page.ts';
import { callReceiver, type ReceiverNamespace } from './receiver.ts';

// The Durable Object class must be exported from the Worker's main module;
// Cloudflare's runtime, named by wrangler.jsonc, is its only importer.
// fallow-ignore-next-line unused-export
export { LiteReceiver } from './receiver.ts';

/** A Workers rate-limit binding. */
export interface RateLimiter {
  limit(options: { key: string }): Promise<{ success: boolean }>;
}

/** The subset of the Cache API the public aggregates route uses. */
export interface ResponseCache {
  match(request: Request): Promise<Response | undefined>;
  put(request: Request, response: Response): Promise<void>;
}

export interface Env {
  /** The LiteReceiver Durable Object namespace (SQLite-backed). */
  LITE_RECEIVER: ReceiverNamespace;
  /** The private operator key, `sto_` + 43 base64url characters (a Worker secret). */
  OPERATOR_KEY?: string;
  /** `POST /v1/lite/*` per client network (IPv4 address or IPv6 /64). */
  LITE_PER_IP_LIMITER: RateLimiter;
  /** `POST /v1/lite/*` across all clients: bounds Durable Object requests. */
  LITE_GLOBAL_LIMITER: RateLimiter;
  /** Public aggregate reads and every operator request, per client network. */
  READ_PER_IP_LIMITER: RateLimiter;
  LITE_MAX_ROWS?: string;
  LITE_MAX_BYTES?: string;
  LITE_RETENTION_DAYS?: string;
}

const OPERATOR_BODY_LIMIT_BYTES = 131_072;
const OPERATOR_KEY = /^sto_[A-Za-z0-9_-]{43}$/;

const PAGE_HEADERS = {
  'Content-Security-Policy':
    "default-src 'none'; script-src 'self'; connect-src 'self'; style-src 'unsafe-inline'; img-src 'self' data:; base-uri 'none'; frame-ancestors 'none'; form-action 'none'",
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
};

const json = (
  body: unknown,
  status = 200,
  headers: Record<string, string> = {},
) =>
  Response.json(body, {
    status,
    headers: { 'Cache-Control': 'no-store', ...headers },
  });

/** Copies a receiver response, adding headers the Worker owns. */
async function relay(
  response: Response,
  headers: Record<string, string> = { 'Cache-Control': 'no-store' },
): Promise<Response> {
  const out = new Response(await response.arrayBuffer(), response);
  for (const [name, value] of Object.entries(headers))
    out.headers.set(name, value);
  out.headers.set('X-Content-Type-Options', 'nosniff');
  return out;
}

/**
 * Reads at most `limit` bytes, refusing (null) as soon as the declared or
 * streamed size passes it rather than truncating.
 */
async function readCapped(
  request: Request,
  limit: number,
): Promise<string | null> {
  const declared = request.headers.get('content-length');
  if (declared !== null && !(Number(declared) <= limit)) return null;
  if (!request.body) return '';
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

const parseJson = (body: string): unknown => {
  try {
    return JSON.parse(body);
  } catch {
    return null;
  }
};

/**
 * Cloudflare sets `CF-Connecting-IP` to the visitor's address. Anything that
 * is not one bare address keys as `unavailable` and is counted in the
 * operator diagnostics; the value itself is never stored or echoed.
 */
function clientAddress(request: Request): { address: string; valid: boolean } {
  const header = request.headers.get('cf-connecting-ip') ?? '';
  // Cloudflare never sends a zone ID; one here is not a visitor address.
  return ipFamily(header) && !header.includes('%')
    ? { address: header, valid: true }
    : { address: 'unavailable', valid: false };
}

const sha256 = (value: string) => createHash('sha256').update(value).digest();

function operatorAccess(
  request: Request,
  configured: string | undefined,
): 'ok' | 'unauthorized' | 'unconfigured' {
  if (!configured || !OPERATOR_KEY.test(configured)) return 'unconfigured';
  const key =
    /^Bearer (sto_[A-Za-z0-9_-]{43})$/.exec(
      request.headers.get('authorization') ?? '',
    )?.[1] ?? '';
  // Digests have equal length, so the comparison time never depends on
  // where a guessed key first differs.
  return key && timingSafeEqual(sha256(key), sha256(configured))
    ? 'ok'
    : 'unauthorized';
}

const rateLimited = () =>
  json({ error: 'receiver_rate_limit' }, 429, { 'Retry-After': '60' });

/** Seconds a public page may be cached: at most 60, never past UTC midnight. */
function publicMaxAge(now: number): number {
  const midnight = Date.parse(`${utcDay(now)}T00:00:00Z`) + 86_400_000;
  return Math.max(0, Math.min(60, Math.floor((midnight - now) / 1000)));
}

export async function handleRequest(
  request: Request,
  env: Env,
  cache?: ResponseCache,
): Promise<Response> {
  const url = new URL(request.url);
  const { pathname } = url;
  const method = request.method;

  if (method === 'GET' && pathname === '/health/live')
    return json({ state: 'alive', scope: 'worker' });

  const lite = /^\/v1\/lite\/([^/]+)$/.exec(pathname);
  if (lite && method === 'POST') {
    const client = clientAddress(request);
    const network = networkKey(client.address, 64);
    // Narrowest first, so a refused client never spends the shared budget.
    if (!(await env.LITE_PER_IP_LIMITER.limit({ key: network })).success)
      return rateLimited();
    if (!(await env.LITE_GLOBAL_LIMITER.limit({ key: 'lite' })).success)
      return rateLimited();
    const body = await readCapped(request, LITE_BODY_LIMIT_BYTES);
    if (body === null) return json({ error: 'body_too_large' }, 413);
    let source = lite[1];
    try {
      source = decodeURIComponent(source);
    } catch {
      // An undecodable slug is simply an unknown source.
    }
    return relay(
      await callReceiver(env.LITE_RECEIVER, {
        op: 'ingest',
        source,
        body: parseJson(body),
        address: client.address,
        addressValid: client.valid,
      }),
    );
  }

  if (method === 'GET' && pathname === '/v1/public/aggregates') {
    const params = [...url.searchParams.keys()];
    if (
      params.some((key) => key !== 'cursor') ||
      url.searchParams.getAll('cursor').length > 1
    )
      return json({ error: 'invalid_cursor' }, 400, {
        'X-Content-Type-Options': 'nosniff',
      });
    const key = new Request(url.toString());
    const hit = await cache?.match(key);
    if (hit) return hit;
    const network = networkKey(clientAddress(request).address, 64);
    if (!(await env.READ_PER_IP_LIMITER.limit({ key: network })).success)
      return rateLimited();
    const response = await callReceiver(env.LITE_RECEIVER, {
      op: 'publicAggregates',
      cursor: url.searchParams.get('cursor') ?? undefined,
    });
    if (!response.ok) return relay(response);
    const maxAge = publicMaxAge(Date.now());
    const out = await relay(response, {
      'Cache-Control': `public, max-age=${maxAge}`,
    });
    if (cache && maxAge > 0) await cache.put(key, out.clone());
    return out;
  }

  if (pathname.startsWith('/v1/operator/')) {
    const network = networkKey(clientAddress(request).address, 64);
    if (!(await env.READ_PER_IP_LIMITER.limit({ key: network })).success)
      return rateLimited();
    const access = operatorAccess(request, env.OPERATOR_KEY);
    if (access === 'unconfigured')
      return json({ error: 'operator_unconfigured' }, 503);
    if (access === 'unauthorized')
      return json({ error: 'operator_unauthorized' }, 401);
    return relay(await operatorRoute(request, url, env));
  }

  if (method === 'GET') {
    if (pathname === '/public/') return page(DASHBOARD_HTML, 'text/html');
    if (pathname === '/public/dashboard.js')
      return page(DASHBOARD_JS, 'text/javascript');
    if (pathname === '/insights' || pathname === '/insights/')
      return page(INSIGHTS_HTML, 'text/html');
    if (pathname === '/insights/insights.js')
      return page(INSIGHTS_JS, 'text/javascript');
  }
  return json({ error: 'not_found' }, 404);
}

async function operatorRoute(
  request: Request,
  url: URL,
  env: Env,
): Promise<Response> {
  const { pathname } = url;
  const method = request.method;
  const namespace = env.LITE_RECEIVER;
  if (method === 'POST' && pathname === '/v1/operator/lite/sources') {
    const body = await readCapped(request, OPERATOR_BODY_LIMIT_BYTES);
    if (body === null) return json({ error: 'body_too_large' }, 413);
    return callReceiver(namespace, {
      op: 'createSource',
      source: parseJson(body),
    });
  }
  const source = /^\/v1\/operator\/lite\/sources\/([^/]+)$/.exec(pathname);
  if (method === 'DELETE' && source) {
    let id = source[1];
    try {
      id = decodeURIComponent(id);
    } catch {
      return json({ revoked: false });
    }
    return callReceiver(namespace, { op: 'revokeSource', id });
  }
  if (method !== 'GET') return json({ error: 'not_found' }, 404);
  const period = /^\/v1\/operator\/lite\/(daily|weekly)$/.exec(pathname)?.[1];
  if (period) {
    if (url.search) return json({ error: 'filters_unsupported' }, 400);
    return callReceiver(namespace, {
      op: 'exact',
      period: period as 'daily' | 'weekly',
    });
  }
  if (pathname === '/v1/operator/lite/insights') {
    if (url.search) return json({ error: 'filters_unsupported' }, 400);
    return callReceiver(namespace, { op: 'insights' });
  }
  if (pathname === '/v1/operator/storage')
    return callReceiver(namespace, { op: 'storage' });
  if (pathname === '/v1/operator/diagnostics')
    return callReceiver(namespace, { op: 'diagnostics' });
  return json({ error: 'not_found' }, 404);
}

function page(body: string, type: 'text/html' | 'text/javascript'): Response {
  return new Response(body, {
    headers: {
      ...PAGE_HEADERS,
      'Content-Type': `${type}; charset=utf-8`,
      'Cache-Control': 'no-cache',
    },
  });
}

/** The Workers runtime's default cache, when present (absent under Node). */
const defaultCache = (): ResponseCache | undefined =>
  (globalThis as { caches?: { default?: ResponseCache } }).caches?.default;

export default {
  fetch(request: Request, env: Env): Promise<Response> {
    return handleRequest(request, env, defaultCache()).catch(() =>
      json({ error: 'storage_unavailable' }, 503),
    );
  },
};
