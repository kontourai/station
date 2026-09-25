// Request handling for the Station push gateway, independent of the Worker
// runtime so it can be exercised directly in tests.
import { type ApnsOutcome, ApnsSender } from './apns.ts';
import {
  type ChannelAuthSecrets,
  signChannelAuth,
  verifyChannelAuth,
} from './apns-channel-auth.ts';
import {
  buildAlertPayload,
  buildLiveActivityPayload,
  parseAlertRequest,
  parseChannelRequest,
  parseLiveActivityRequest,
  payloadBytes,
} from './apns-request.ts';
import type { ApnsCredentials } from './apns-token.ts';
import { DAILY_STARTS_PER_DEVICE, type Ledger } from './channel-ledger.ts';
import { FcmSender, type SendOutcome, type ServiceAccount } from './fcm.ts';
import { parseSendRequest } from './send-request.ts';
import { bodyHash, verifyStationRequest } from './station-auth.ts';

const MAX_BODY_BYTES = 8 * 1024;

export interface RateLimiter {
  limit(options: { key: string }): Promise<{ success: boolean }>;
}

/** APNs delivery; absent until the key is configured, and the routes answer 503. */
export interface ApnsGatewayConfig {
  credentials: ApnsCredentials;
  allowedBundles: readonly string[];
  channelAuth: ChannelAuthSecrets;
  /**
   * Every channel the gateway created (the sweep deletes the rest), and each
   * device's channel-creating starts per UTC day.
   */
  ledger: Ledger;
  /**
   * Every start creates a channel, which spends a finite per-app Apple quota
   * that never refills by itself, so starts have their own ceilings, narrowest
   * first: per client address, per device (push-to-start token), per key,
   * then across the gateway.
   */
  channelPerIpLimiter: RateLimiter;
  channelPerDeviceLimiter: RateLimiter;
  channelPerKeyLimiter: RateLimiter;
  channelGlobalLimiter: RateLimiter;
  /** Deletes, per Station key: they give quota back, so kept apart from creates. */
  channelDeleteLimiter: RateLimiter;
  /**
   * Alerts, per device token, tighter than the shared per-token budget.
   * Nothing binds a device token to the Station that registered it (there
   * is no channelAuth for a device), so anyone who learns a token can send
   * it fixed-text alerts with a key of their own; this bounds how often.
   * Without it the alert route answers 503: it fails closed.
   */
  alertPerTokenLimiter?: RateLimiter;
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
  apns?: ApnsGatewayConfig | null;
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

const APNS_OUTCOME_RESPONSES: Record<ApnsOutcome['kind'], [number, string]> = {
  sent: [200, 'sent'],
  deleted: [200, 'deleted'],
  unregistered: [410, 'unregistered'],
  'channel-gone': [410, 'channel-gone'],
  rejected: [422, 'rejected'],
  unavailable: [503, 'unavailable'],
};

/** `extra` rides only on a 200 (a new or refreshed channelAuth). */
function apnsResponse(
  outcome: ApnsOutcome,
  extra: Record<string, string> = {},
): Response {
  const [status, result] = APNS_OUTCOME_RESPONSES[outcome.kind];
  return json(status, status === 200 ? { result, ...extra } : { result });
}

const RATE_LIMITED = () => json(429, { error: 'rate limited' });

/**
 * Checks limiters narrowest first and stops at the first refusal, so a
 * request refused by a narrow limiter never spends a wider (shared) budget.
 */
async function withinLimits(
  checks: ReadonlyArray<readonly [RateLimiter, string]>,
): Promise<boolean> {
  for (const [limiter, key] of checks) {
    if (!(await limiter.limit({ key })).success) return false;
  }
  return true;
}

const hashKey = (value: string) => bodyHash(new TextEncoder().encode(value));

/** The Worker's execution context: work that must outlive the response. */
export interface ExecutionContextLike {
  waitUntil(work: Promise<unknown>): void;
}

/**
 * The rate-limit key for a client address. One IPv6 subscriber usually holds
 * a whole /64, so keying on the full address would let a single client rotate
 * through unlimited budgets; IPv4 addresses are used as they are.
 */
export function addressBucket(address: string): string {
  if (!address.includes(':')) return address;
  const [head, tail] = address.toLowerCase().split('::', 2) as [
    string,
    string | undefined,
  ];
  const groups = (part: string) =>
    part === ''
      ? []
      : part.split(':').flatMap((group) => {
          // An embedded dotted IPv4 (::ffff:192.0.2.1) is the last two groups.
          if (!group.includes('.')) return [group];
          const octets = group.split('.').map(Number);
          return [
            ((octets[0] << 8) | octets[1]).toString(16),
            ((octets[2] << 8) | octets[3]).toString(16),
          ];
        });
  const left = groups(head);
  const right = tail === undefined ? [] : groups(tail);
  const zeros =
    tail === undefined
      ? []
      : Array(Math.max(0, 8 - left.length - right.length)).fill('0');
  const full = [...left, ...zeros, ...right].map(
    (group) => Number.parseInt(group, 16) || 0,
  );
  // IPv4-mapped (::ffff:0:0/96) and NAT64 (64:ff9b::/96) addresses carry one
  // IPv4 client in their last 32 bits: limit that client, not the prefix.
  const mapped = full.slice(0, 6).join(':') === '0:0:0:0:0:65535';
  const nat64 = full.slice(0, 6).join(':') === '100:65435:0:0:0:0';
  if (mapped || nat64)
    return [full[6] >> 8, full[6] & 255, full[7] >> 8, full[7] & 255].join('.');
  return `${full
    .slice(0, 4)
    .map((group) => group.toString(16))
    .join(':')}::/64`;
}

// The channel id shape Apple issues (verified 2026-09-24), for sizing a start
// before its channel exists.
const PLACEHOLDER_CHANNEL_ID = `${'A'.repeat(22)}==`;

const FCM_ROUTE = '/v1/fcm/send';
const LIVE_ACTIVITY_ROUTE = '/v1/apns/live-activity';
const CHANNELS_ROUTE = '/v1/apns/channels';
const ALERT_ROUTE = '/v1/apns/alert';
const ROUTES = new Set([
  FCM_ROUTE,
  LIVE_ACTIVITY_ROUTE,
  CHANNELS_ROUTE,
  ALERT_ROUTE,
]);

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
  ctx?: ExecutionContextLike,
): Promise<Response> {
  const url = new URL(request.url);
  if (url.pathname === '/health' && request.method === 'GET')
    return json(200, { ok: true });
  const route = url.pathname;
  if (!ROUTES.has(route)) return json(404, { error: 'not found' });
  if (request.method !== 'POST')
    return json(405, { error: 'method not allowed' });
  const configured = route === FCM_ROUTE ? config.serviceAccount : config.apns;
  if (!configured)
    return json(503, { error: 'push delivery is not configured' });

  const clientIp = addressBucket(
    request.headers.get('cf-connecting-ip') ?? 'unknown',
  );
  if (!(await config.perIpLimiter.limit({ key: clientIp })).success) {
    return json(429, { error: 'rate limited' });
  }
  const body = await readBounded(request, MAX_BODY_BYTES);
  if (!body) return json(413, { error: 'body too large' });

  const nowSeconds = (
    config.nowSeconds ?? (() => Math.floor(Date.now() / 1000))
  )();
  const auth = await verifyStationRequest({
    authorization: request.headers.get('authorization'),
    body,
    audiences: config.audiences,
    nowSeconds,
  });
  // Reasons are returned to the caller, who holds the key and needs them to
  // debug; they reveal nothing about other Stations.
  if (!auth.ok) return json(401, { error: auth.reason });

  // Both were checked before any work; re-read here so each route is typed
  // against its own configuration.
  const { apns, serviceAccount } = config;
  const signed: Signed = {
    body,
    stationKey: auth.keyThumbprint,
    clientIp,
    nowSeconds,
    // Without a Worker context (tests, other hosts) deferred work is awaited.
    defer: ctx ? (work) => ctx.waitUntil(work) : undefined,
  };
  if (route !== FCM_ROUTE) {
    if (!apns) return json(503, { error: 'push delivery is not configured' });
    if (route === ALERT_ROUTE) return alert(signed, config, apns);
    return route === LIVE_ACTIVITY_ROUTE
      ? liveActivity(signed, config, apns)
      : channels(signed, config, apns);
  }
  if (!serviceAccount)
    return json(503, { error: 'push delivery is not configured' });

  const parsed = parseSendRequest(body, config.allowedPackages);
  if (!parsed.ok) return json(400, { error: parsed.reason });
  if (
    !(await withinLimits([
      [config.perTokenLimiter, await hashKey(parsed.request.token)],
      [config.perKeyLimiter, auth.keyThumbprint],
      [config.globalLimiter, 'global'],
    ]))
  )
    return RATE_LIMITED();

  // The phone pins its own Station's key thumbprint and drops anything else,
  // so a key that verified here still cannot speak for another Station.
  const stamped = {
    ...parsed.request,
    data: { ...parsed.request.data, station_key: auth.keyThumbprint },
  };

  let sender = senders.get(serviceAccount);
  if (!sender) {
    sender = new FcmSender(serviceAccount, config.fetchImpl);
    senders.set(serviceAccount, sender);
  }
  const outcome = await sender.send(stamped);
  const [status, result] = OUTCOME_RESPONSES[outcome.kind];
  return json(status, { result });
}

interface Signed {
  body: Uint8Array<ArrayBuffer>;
  /** The verified signing key's thumbprint. */
  stationKey: string;
  clientIp: string;
  nowSeconds: number;
  defer?: (work: Promise<unknown>) => void;
}

async function liveActivity(
  signed: Signed,
  config: GatewayConfig,
  apns: ApnsGatewayConfig,
): Promise<Response> {
  const parsed = parseLiveActivityRequest(
    signed.body,
    apns.allowedBundles,
    signed.nowSeconds,
  );
  if (!parsed.ok) return json(400, { error: parsed.reason });
  const { request } = parsed;
  const { stationKey } = signed;
  const sender = new ApnsSender(
    apns.credentials,
    config.fetchImpl,
    () => signed.nowSeconds,
  );

  if (request.event === 'start') {
    const deviceHash = await hashKey(request.pushToStartToken ?? '');
    if (
      !(await withinLimits([
        [apns.channelPerIpLimiter, signed.clientIp],
        [apns.channelPerDeviceLimiter, deviceHash],
      ]))
    )
      return RATE_LIMITED();
    // The device's daily ceiling (a guard against an honest Station running
    // away, not an abuse bound: the device key is caller-supplied) sits
    // between its per-minute limit and the wider ones. Reading it spends
    // nothing; the count rises only when Apple accepts a start.
    let startsToday: number;
    try {
      startsToday = await apns.ledger.startsToday(
        deviceHash,
        signed.nowSeconds,
      );
    } catch {
      console.error('apns channel ledger unavailable; start refused');
      return json(503, { result: 'unavailable' });
    }
    if (startsToday >= DAILY_STARTS_PER_DEVICE) return RATE_LIMITED();
    if (
      !(await withinLimits([
        [apns.channelPerKeyLimiter, stationKey],
        [apns.channelGlobalLimiter, 'global'],
      ]))
    )
      return RATE_LIMITED();
    // Refuse an oversized start before it spends a channel.
    if (
      !payloadBytes(
        buildLiveActivityPayload(request, stationKey, PLACEHOLDER_CHANNEL_ID),
      )
    )
      return json(422, { result: 'rejected' });
    const pending: Promise<unknown>[] = [];
    const channelOf = (channelId: string) => ({
      bundleId: request.bundleId,
      environment: request.environment,
      channelId,
    });
    const stationKeyHash = await hashKey(stationKey);
    const outcome = await sender.start(
      request,
      (channelId) =>
        payloadBytes(buildLiveActivityPayload(request, stationKey, channelId)),
      {
        record: (channelId) =>
          apns.ledger.record({
            ...channelOf(channelId),
            stationKeyHash,
            createdAt: signed.nowSeconds,
          }),
        forget: (channelId) => apns.ledger.forget(channelOf(channelId)),
        defer: (work) => {
          const settled = work.catch(() => {});
          if (signed.defer) signed.defer(settled);
          else pending.push(settled);
        },
      },
    );
    await Promise.all(pending);
    if (outcome.kind !== 'started') return apnsResponse(outcome);
    // Best effort: an uncounted start only loosens the guard by one.
    await apns.ledger
      .countStart(deviceHash, signed.nowSeconds)
      .catch(() => console.error('apns channel ledger count failed'));
    const channelAuth = await signChannelAuth(apns.channelAuth, {
      bundleId: request.bundleId,
      environment: request.environment,
      channelId: outcome.channelId,
      stationKey,
    });
    return json(200, {
      result: 'sent',
      channelId: outcome.channelId,
      channelAuth,
    });
  }

  const channelId = request.channelId ?? '';
  const proof = await authorizeChannel(apns, {
    bundleId: request.bundleId,
    environment: request.environment,
    channelId,
    stationKey,
    channelAuth: request.channelAuth ?? '',
  });
  if (proof instanceof Response) return proof;
  if (
    !(await withinLimits([
      [config.perTokenLimiter, await hashKey(channelId)],
      [config.perKeyLimiter, stationKey],
      [config.globalLimiter, 'global'],
    ]))
  )
    return RATE_LIMITED();
  const payload = payloadBytes(buildLiveActivityPayload(request, stationKey));
  if (!payload) return json(422, { result: 'rejected' });
  const outcome = await sender.broadcast(request, payload);
  return apnsResponse(outcome, proof);
}

/**
 * A regular alert push. Limited first by its own tight per-device-token
 * ceiling, then like a Live Activity update: per device token (so key
 * rotation cannot evade it), per key, then globally. It creates no channel,
 * so the channel ceilings do not apply.
 */
async function alert(
  signed: Signed,
  config: GatewayConfig,
  apns: ApnsGatewayConfig,
): Promise<Response> {
  if (!apns.alertPerTokenLimiter)
    return json(503, { error: 'push delivery is not configured' });
  const parsed = parseAlertRequest(signed.body, apns.allowedBundles);
  if (!parsed.ok) return json(400, { error: parsed.reason });
  const { request } = parsed;
  const tokenHash = await hashKey(request.deviceToken);
  if (
    !(await withinLimits([
      [apns.alertPerTokenLimiter, tokenHash],
      [config.perTokenLimiter, tokenHash],
      [config.perKeyLimiter, signed.stationKey],
      [config.globalLimiter, 'global'],
    ]))
  )
    return RATE_LIMITED();
  const payload = payloadBytes(buildAlertPayload(request, signed.stationKey));
  if (!payload) return json(422, { result: 'rejected' });
  const sender = new ApnsSender(
    apns.credentials,
    config.fetchImpl,
    () => signed.nowSeconds,
  );
  return apnsResponse(await sender.alert(request, payload));
}

async function channels(
  signed: Signed,
  config: GatewayConfig,
  apns: ApnsGatewayConfig,
): Promise<Response> {
  const parsed = parseChannelRequest(signed.body, apns.allowedBundles);
  if (!parsed.ok) return json(400, { error: parsed.reason });
  const { request } = parsed;
  const proof = await authorizeChannel(apns, {
    ...request,
    stationKey: signed.stationKey,
  });
  if (proof instanceof Response) return proof;
  if (!(await withinLimits([[apns.channelDeleteLimiter, signed.stationKey]])))
    return RATE_LIMITED();
  const sender = new ApnsSender(
    apns.credentials,
    config.fetchImpl,
    () => signed.nowSeconds,
  );
  const outcome = await sender.deleteChannel(
    request.bundleId,
    request.environment,
    request.channelId,
  );
  // Best effort: a row left behind only keeps the channel "recorded" until it
  // expires, and Apple no longer lists it anyway.
  if (outcome.kind === 'deleted')
    await apns.ledger
      .forget({
        environment: request.environment,
        bundleId: request.bundleId,
        channelId: request.channelId,
      })
      .catch(() => {
        console.error('apns channel ledger forget failed');
      });
  return apnsResponse(outcome, proof);
}

/**
 * Checks `channelAuth` before any per-channel limiter, so a stranger holding
 * only a channel id can neither use the channel nor spend its budget.
 * Returns the fields to add to a 200 (a fresh token after secret rotation),
 * or the 403 to send.
 */
async function authorizeChannel(
  apns: ApnsGatewayConfig,
  input: {
    bundleId: string;
    environment: string;
    channelId: string;
    stationKey: string;
    channelAuth: string;
  },
): Promise<Record<string, string> | Response> {
  const { channelAuth, ...binding } = input;
  const matched = await verifyChannelAuth(
    apns.channelAuth,
    binding,
    channelAuth,
  );
  if (!matched) return json(403, { result: 'channel-unauthorized' });
  if (matched === 'current') return {};
  return { channelAuth: await signChannelAuth(apns.channelAuth, binding) };
}
