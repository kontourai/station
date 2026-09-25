// The only Live Activity and broadcast-channel requests the gateway forwards.
//
// A Station never sends APNs JSON: it names an event and supplies routing
// data plus the sealed card, and the gateway builds the `aps` payload from a
// fixed vocabulary. The only readable text a phone can be shown is the fixed
// alert below, so the gateway cannot be used to put arbitrary words on a lock
// screen, and the Station key's thumbprint (`sk`) is stamped here, never
// accepted from the caller.

const APNS_ATTRIBUTES_TYPE = 'StationAgentActivityAttributes';
const LIVE_ACTIVITY_STATE_VERSION = 1;
const ALERT_TITLE = 'Station';
const ALERT_BODY = 'Agent activity';

/**
 * The only words a regular alert push can put on a lock screen, chosen by
 * the Station's `kind`. A notification's own title and body travel only
 * inside `sealed`, for the Notification Service Extension to open on the
 * phone; without that extension the fixed text is what shows.
 */
export const APNS_ALERT_TEXT = {
  attention: { title: 'Station', body: 'Something needs your attention' },
  failed: { title: 'Station', body: 'Something failed' },
  done: { title: 'Station', body: 'Work finished' },
  hidden: { title: 'Station', body: 'You have a new notification' },
} as const satisfies Record<string, { title: string; body: string }>;
export type ApnsAlertKind = keyof typeof APNS_ALERT_TEXT;
const ALERT_KINDS = Object.keys(APNS_ALERT_TEXT) as ApnsAlertKind[];
/** The custom key the sealed notification travels under. */
const APNS_ALERT_PAYLOAD_KEY = 'station';
const ALERT_PAYLOAD_VERSION = 1;
/** Kinds that sound and go out at once; the rest are quiet and may wait. */
const URGENT_ALERT_KINDS: ReadonlySet<ApnsAlertKind> = new Set([
  'attention',
  'failed',
]);
/** APNs caps apns-collapse-id at 64 bytes; the Station sends a hash. */
const COLLAPSE_ID = /^[A-Za-z0-9_-]{16,64}$/;
const MAX_ALERT_SEALED_CHARS = 3000;

/** APNs refuses a Live Activity payload over 4 KB. */
export const MAX_APNS_PAYLOAD_BYTES = 4096;
const MAX_SEALED_CHARS = 3400;
// nonce (12) + tag (16) with an empty ciphertext is 28 bytes: 38 characters.
const MIN_SEALED_CHARS = 38;
/** Allowed disagreement between the Station's clock and the gateway's. */
const CLOCK_SKEW_SECONDS = 120;
/** ActivityKit ends a Live Activity after eight hours regardless. */
const MAX_STALE_AHEAD_SECONDS = 8 * 60 * 60;
/** An ended activity may stay on the lock screen for at most four hours. */
const MAX_DISMISS_AHEAD_SECONDS = 4 * 60 * 60;

const TOKEN = /^(?:[0-9a-f]{2}){32,100}$/i;
// Apple's broadcast channel ids are standard base64 (observed 2026-09-24: 24
// characters, e.g. with '/', '+' and '=' padding). The length bound is kept
// loose in case Apple lengthens them. The id travels in a header, so the
// pattern also excludes CR/LF.
const CHANNEL_ID = /^[A-Za-z0-9+/]{4,128}={0,2}$/;
const REGISTRATION_ID = /^[A-Za-z0-9_-]{22,64}$/;
const BASE64URL = /^[A-Za-z0-9_-]+$/;
// "v1." + base64url(HMAC-SHA256): see apns-channel-auth.ts.
const CHANNEL_AUTH = /^v1\.[A-Za-z0-9_-]{43}$/;

export type ApnsEnvironment = 'production' | 'sandbox';
export type LiveActivityEvent = 'start' | 'update' | 'end';

export interface LiveActivityRequest {
  bundleId: string;
  environment: ApnsEnvironment;
  event: LiveActivityEvent;
  /** Start only: the device's push-to-start token (hex). */
  pushToStartToken?: string;
  /**
   * Update and end only. A start carries none: the gateway creates the
   * activity's channel itself, so a caller cannot spend Apple's channel quota
   * without also addressing a real device.
   */
  channelId?: string;
  /** Update and end only: the gateway's proof this key was handed the channel. */
  channelAuth?: string;
  registrationId: string;
  sealed: string;
  alert: boolean;
  timestamp: number;
  /** Start and update. */
  staleAt?: number;
  /** End only. */
  dismissAt?: number;
}

/** Channels are created only inside a start; the route only deletes. */
export interface ChannelRequest {
  op: 'delete';
  bundleId: string;
  environment: ApnsEnvironment;
  channelId: string;
  channelAuth: string;
}

type Parsed<T> = { ok: true; request: T } | { ok: false; reason: string };

const COMMON_KEYS = [
  'bundleId',
  'environment',
  'event',
  'registrationId',
  'sealed',
  'alert',
  'timestamp',
] as const;
const EVENT_KEYS: Record<LiveActivityEvent, readonly string[]> = {
  start: [...COMMON_KEYS, 'pushToStartToken', 'staleAt'],
  update: [...COMMON_KEYS, 'channelId', 'channelAuth', 'staleAt'],
  end: [...COMMON_KEYS, 'channelId', 'channelAuth', 'dismissAt'],
};
const ALERT_KEYS = [
  'bundleId',
  'environment',
  'deviceToken',
  'registrationId',
  'kind',
  'collapseId',
  'sealed',
] as const;
const CHANNEL_KEYS = [
  'op',
  'bundleId',
  'environment',
  'channelId',
  'channelAuth',
] as const;

function decodeObject(
  body: Uint8Array<ArrayBuffer>,
): Record<string, unknown> | string {
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder().decode(body));
  } catch {
    return 'body is not JSON';
  }
  if (!value || typeof value !== 'object' || Array.isArray(value))
    return 'body must be an object';
  return value as Record<string, unknown>;
}

/** Exactly `allowed`, every one of them present: no optional extras. */
function checkKeys(
  input: Record<string, unknown>,
  allowed: readonly string[],
): string | null {
  // The gateway stamps `sk`; say so rather than report a generic unknown key.
  if ('sk' in input) return 'sk is stamped by the gateway';
  for (const key of Object.keys(input)) {
    if (!allowed.includes(key)) return `unknown key ${key.slice(0, 64)}`;
  }
  for (const key of allowed) {
    if (input[key] === undefined) return `missing ${key}`;
  }
  return null;
}

function checkRouting(
  input: Record<string, unknown>,
  allowedBundles: readonly string[],
): string | null {
  if (
    typeof input.bundleId !== 'string' ||
    !allowedBundles.includes(input.bundleId)
  )
    return 'bundle is not a Station app';
  if (input.environment !== 'production' && input.environment !== 'sandbox')
    return 'invalid environment';
  return null;
}

const isChannelId = (value: unknown): value is string =>
  typeof value === 'string' && CHANNEL_ID.test(value);

export const isApnsChannelId = isChannelId;

const isChannelAuth = (value: unknown): value is string =>
  typeof value === 'string' && CHANNEL_AUTH.test(value);

const isSeconds = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value > 0;

export function parseLiveActivityRequest(
  body: Uint8Array<ArrayBuffer>,
  allowedBundles: readonly string[],
  nowSeconds: number,
): Parsed<LiveActivityRequest> {
  const input = decodeObject(body);
  if (typeof input === 'string') return { ok: false, reason: input };
  const { event } = input;
  if (event !== 'start' && event !== 'update' && event !== 'end')
    return { ok: false, reason: 'unsupported event' };
  const keyError = checkKeys(input, EVENT_KEYS[event]);
  if (keyError) return { ok: false, reason: keyError };
  const routingError = checkRouting(input, allowedBundles);
  if (routingError) return { ok: false, reason: routingError };

  if (
    event === 'start' &&
    (typeof input.pushToStartToken !== 'string' ||
      !TOKEN.test(input.pushToStartToken))
  )
    return { ok: false, reason: 'invalid pushToStartToken' };
  if (event !== 'start') {
    if (!isChannelId(input.channelId))
      return { ok: false, reason: 'invalid channelId' };
    if (!isChannelAuth(input.channelAuth))
      return { ok: false, reason: 'invalid channelAuth' };
  }
  if (
    typeof input.registrationId !== 'string' ||
    !REGISTRATION_ID.test(input.registrationId)
  )
    return { ok: false, reason: 'invalid registrationId' };
  if (
    typeof input.sealed !== 'string' ||
    !BASE64URL.test(input.sealed) ||
    input.sealed.length < MIN_SEALED_CHARS ||
    input.sealed.length > MAX_SEALED_CHARS
  )
    return { ok: false, reason: 'invalid sealed' };
  if (typeof input.alert !== 'boolean')
    return { ok: false, reason: 'alert must be a boolean' };

  if (
    !isSeconds(input.timestamp) ||
    Math.abs(input.timestamp - nowSeconds) > CLOCK_SKEW_SECONDS
  )
    return { ok: false, reason: 'timestamp out of range' };
  if (event === 'end') {
    if (
      !isSeconds(input.dismissAt) ||
      input.dismissAt < nowSeconds - CLOCK_SKEW_SECONDS ||
      input.dismissAt >
        nowSeconds + MAX_DISMISS_AHEAD_SECONDS + CLOCK_SKEW_SECONDS
    )
      return { ok: false, reason: 'dismissAt out of range' };
  } else if (
    !isSeconds(input.staleAt) ||
    input.staleAt <= nowSeconds - CLOCK_SKEW_SECONDS ||
    input.staleAt > nowSeconds + MAX_STALE_AHEAD_SECONDS + CLOCK_SKEW_SECONDS
  ) {
    return { ok: false, reason: 'staleAt out of range' };
  }

  return {
    ok: true,
    request: {
      bundleId: input.bundleId as string,
      environment: input.environment as ApnsEnvironment,
      event,
      ...(event === 'start'
        ? { pushToStartToken: (input.pushToStartToken as string).toLowerCase() }
        : {
            channelId: input.channelId as string,
            channelAuth: input.channelAuth as string,
          }),
      registrationId: input.registrationId,
      sealed: input.sealed,
      alert: input.alert,
      timestamp: input.timestamp,
      ...(event === 'end'
        ? { dismissAt: input.dismissAt as number }
        : { staleAt: input.staleAt as number }),
    },
  };
}

/**
 * A regular (alert) push to one device: `deviceToken` is the app's APNs
 * device token, not a Live Activity token, and the topic is the bundle id.
 */
export interface AlertRequest {
  bundleId: string;
  environment: ApnsEnvironment;
  deviceToken: string;
  registrationId: string;
  kind: ApnsAlertKind;
  /** Same notification, same id: a later push replaces the shown one. */
  collapseId: string;
  sealed: string;
}

export function parseAlertRequest(
  body: Uint8Array<ArrayBuffer>,
  allowedBundles: readonly string[],
): Parsed<AlertRequest> {
  const input = decodeObject(body);
  if (typeof input === 'string') return { ok: false, reason: input };
  const keyError = checkKeys(input, ALERT_KEYS);
  if (keyError) return { ok: false, reason: keyError };
  const routingError = checkRouting(input, allowedBundles);
  if (routingError) return { ok: false, reason: routingError };
  if (typeof input.deviceToken !== 'string' || !TOKEN.test(input.deviceToken))
    return { ok: false, reason: 'invalid deviceToken' };
  if (
    typeof input.registrationId !== 'string' ||
    !REGISTRATION_ID.test(input.registrationId)
  )
    return { ok: false, reason: 'invalid registrationId' };
  if (
    typeof input.kind !== 'string' ||
    !(ALERT_KINDS as readonly string[]).includes(input.kind)
  )
    return { ok: false, reason: 'unsupported kind' };
  if (
    typeof input.collapseId !== 'string' ||
    !COLLAPSE_ID.test(input.collapseId)
  )
    return { ok: false, reason: 'invalid collapseId' };
  if (
    typeof input.sealed !== 'string' ||
    !BASE64URL.test(input.sealed) ||
    input.sealed.length < MIN_SEALED_CHARS ||
    input.sealed.length > MAX_ALERT_SEALED_CHARS
  )
    return { ok: false, reason: 'invalid sealed' };
  return {
    ok: true,
    request: {
      bundleId: input.bundleId as string,
      environment: input.environment as ApnsEnvironment,
      deviceToken: input.deviceToken.toLowerCase(),
      registrationId: input.registrationId,
      kind: input.kind as ApnsAlertKind,
      collapseId: input.collapseId,
      sealed: input.sealed,
    },
  };
}

/** Attention and failures go out at once; the rest may wait for power. */
export function alertPriority(request: AlertRequest): 5 | 10 {
  return URGENT_ALERT_KINDS.has(request.kind) ? 10 : 5;
}

/**
 * The complete APNs body of an alert push. The visible text comes only from
 * {@link APNS_ALERT_TEXT}; `mutable-content` lets the phone's Notification
 * Service Extension replace it with the sealed notification once there is
 * one. `sk` is the verified signing key's thumbprint, never the caller's.
 */
export function buildAlertPayload(
  request: AlertRequest,
  stationKey: string,
): Record<string, unknown> {
  const text = APNS_ALERT_TEXT[request.kind];
  return {
    aps: {
      alert: { title: text.title, body: text.body },
      ...(URGENT_ALERT_KINDS.has(request.kind) ? { sound: 'default' } : {}),
      'mutable-content': 1,
    },
    [APNS_ALERT_PAYLOAD_KEY]: {
      v: ALERT_PAYLOAD_VERSION,
      rid: request.registrationId,
      sk: stationKey,
      sealed: request.sealed,
    },
  };
}

export function parseChannelRequest(
  body: Uint8Array<ArrayBuffer>,
  allowedBundles: readonly string[],
): Parsed<ChannelRequest> {
  const input = decodeObject(body);
  if (typeof input === 'string') return { ok: false, reason: input };
  if (input.op !== 'delete') return { ok: false, reason: 'unsupported op' };
  const keyError = checkKeys(input, CHANNEL_KEYS);
  if (keyError) return { ok: false, reason: keyError };
  const routingError = checkRouting(input, allowedBundles);
  if (routingError) return { ok: false, reason: routingError };
  if (!isChannelId(input.channelId))
    return { ok: false, reason: 'invalid channelId' };
  if (!isChannelAuth(input.channelAuth))
    return { ok: false, reason: 'invalid channelAuth' };
  return {
    ok: true,
    request: {
      op: 'delete',
      bundleId: input.bundleId as string,
      environment: input.environment as ApnsEnvironment,
      channelId: input.channelId,
      channelAuth: input.channelAuth,
    },
  };
}

/** Start, end, and an alerting update go out immediately; the rest may wait. */
export function livePriority(request: LiveActivityRequest): 5 | 10 {
  return request.event === 'update' && !request.alert ? 5 : 10;
}

/**
 * The complete APNs body. `stationKey` is the thumbprint of the key that
 * signed the request, which the widget pins before opening the card.
 * `startChannelId` is the channel the gateway created for a start.
 */
export function buildLiveActivityPayload(
  request: LiveActivityRequest,
  stationKey: string,
  startChannelId?: string,
): { aps: Record<string, unknown> } {
  const contentState = {
    v: LIVE_ACTIVITY_STATE_VERSION,
    rid: request.registrationId,
    sk: stationKey,
    sealed: request.sealed,
  };
  const alert = {
    title: ALERT_TITLE,
    body: ALERT_BODY,
    ...(request.alert ? { sound: 'default' } : {}),
  };
  const aps: Record<string, unknown> = {
    timestamp: request.timestamp,
    event: request.event,
    'content-state': contentState,
  };
  if (request.event === 'start') {
    aps['attributes-type'] = APNS_ATTRIBUTES_TYPE;
    aps.attributes = { rid: request.registrationId };
    aps['input-push-channel'] = startChannelId;
    aps['stale-date'] = request.staleAt;
    // Push-to-start needs an alert to present the activity; it is silent
    // unless the Station asked for one.
    aps.alert = alert;
  } else if (request.event === 'update') {
    aps['stale-date'] = request.staleAt;
    if (request.alert) aps.alert = alert;
  } else {
    aps['dismissal-date'] = request.dismissAt;
    if (request.alert) aps.alert = alert;
  }
  return { aps };
}

export function payloadBytes(payload: object): Uint8Array<ArrayBuffer> | null {
  const bytes = new TextEncoder().encode(JSON.stringify(payload));
  return bytes.length > MAX_APNS_PAYLOAD_BYTES ? null : bytes;
}
