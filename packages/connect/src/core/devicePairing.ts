import {
  DEVICE_PAIRING_BROWSER_COOKIE_DELIVERY,
  DEVICE_PAIRING_PROTOCOL_VERSION,
  type DevicePairingAccessRequestResponse,
  type DevicePairingExchangeResponse,
  type DevicePairingOffer,
  type DevicePairingRequest,
  type PairedDevice,
  PUBLIC_DEVICE_PAIRING_ACCESS_REQUEST_PATH,
  PUBLIC_DEVICE_PAIRING_EXCHANGE_PATH,
  PUBLIC_DEVICE_PAIRING_REQUEST_PATH,
  parsePairingScope,
} from '@kontourai/station-contracts/environment-security';
import type { StationProfileCredentialRef } from '@kontourai/station-contracts/station-profile';

const PAYLOAD_PREFIX = 'station-pairing:v1:';
const CANONICAL_SCANNED_PAIRING_OFFER_FIELDS = new Set([
  'protocolVersion',
  'environmentId',
  'offerId',
  'challenge',
  'endpoint',
  'scope',
  'expiresAt',
]);
const PAIRING_CLIENT_INSTANCE_STORAGE_PREFIX =
  'station-pairing-client-instance:v1:';
const PENDING_EXCHANGE_STORAGE_PREFIX = 'station-pairing-pending-exchange:v1:';
const CLIENT_INSTANCE_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const volatilePairingClientInstanceIds = new Map<string, string>();

/**
 * station#4512 review (M2) — a same-tab re-arm signal for
 * `usePendingPairingApproval`.
 *
 * The browser's own `storage` event exists for exactly this shape of
 * problem, but it fires ONLY in other tabs/windows, never in the tab that
 * called `setItem`/`removeItem` — and the pairing flow that writes a pending
 * record (`DevicePairingPanel.tsx`) and the header chip that reads it
 * (`HeaderActions.tsx`) are mounted in the SAME tab. Without a same-tab
 * signal, a hook that decides once (on mount / endpoint change) whether
 * anything is pending would never notice a request started later in the
 * same session. `savePendingExchange`/`clearPendingExchange` dispatch this;
 * a listener re-reads the store fresh rather than trusting the event's own
 * payload (there is none) — it is a "something changed, look again" nudge,
 * not a delivery mechanism.
 */
export const PENDING_EXCHANGE_CHANGE_EVENT =
  'station-connect:pending-exchange-change';

/**
 * Value-level only, never type-level: `window`/`Event` are DOM lib types,
 * and this module type-checks under a Node `lib` too (`pairingFetch`'s
 * `credentials` parameter above documents the same constraint — the
 * Station CLI imports this module via the `./device-pairing` subpath and
 * compiles it without DOM types). `globalThis` itself is ES-standard and
 * needs no DOM lib; only a browser's `globalThis` actually carries a
 * `dispatchEvent` function and an `Event` constructor on it, so the guard
 * below is the type-checking stand-in for `typeof window === 'undefined'`.
 */
interface DomEventGlobal {
  dispatchEvent?: (event: unknown) => void;
  Event?: new (type: string) => unknown;
}

function notifyPendingExchangeChanged(): void {
  const domGlobal = globalThis as unknown as DomEventGlobal;
  if (typeof domGlobal.dispatchEvent !== 'function' || !domGlobal.Event) {
    return;
  }
  try {
    domGlobal.dispatchEvent(new domGlobal.Event(PENDING_EXCHANGE_CHANGE_EVENT));
  } catch {
    // No DOM `Event` constructor (SSR, a bare Node test) — the caller simply
    // gets no same-tab re-arm signal; nothing here depends on this succeeding.
  }
}

interface PairingStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  /**
   * Optional so every existing `PairingStorage` fixture (the client-instance
   * identity record never needed deletion) keeps satisfying this interface
   * unchanged. Required in practice by the pending-exchange functions below,
   * which must be able to delete a spent or expired record.
   */
  removeItem?(key: string): void;
}

export type NativePairingExchangeTransport = (input: {
  endpoint: string;
  offerId: string;
  proof: string;
  requestId: string;
  clientInstanceId: string;
  /** Unique for one exchange attempt; used by the host cancellation registry. */
  operationId: string;
  browserSession?: boolean;
  signal?: AbortSignal;
}) => Promise<{
  environmentId: string;
  device: PairedDevice;
  credentialHandle: string;
  credentialRef: StationProfileCredentialRef;
}>;

// Optional and origin-specific at its registration point: only the desktop
// host installs it. Browser and mobile preserve the public wire response.
let nativePairingExchangeTransport: NativePairingExchangeTransport | undefined;

export function setNativePairingExchangeTransport(
  transport?: NativePairingExchangeTransport,
): void {
  nativePairingExchangeTransport = transport;
}

export interface ScannedPairingOffer {
  protocolVersion: typeof DEVICE_PAIRING_PROTOCOL_VERSION;
  environmentId: string;
  offerId: string;
  challenge: string;
  endpoint: string;
  /** Space-delimited {@link PairingScope} string (station#1098). */
  scope: string;
  expiresAt: number;
}

function encodeBase64Url(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

function decodeBase64Url(value: string): string {
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=');
  const binary = atob(padded);
  return new TextDecoder().decode(
    Uint8Array.from(binary, (character) => character.charCodeAt(0)),
  );
}

export function encodeDevicePairingPayload(offer: DevicePairingOffer): string {
  const payload: ScannedPairingOffer = {
    protocolVersion: offer.protocolVersion,
    environmentId: offer.environmentId,
    offerId: offer.offerId,
    challenge: offer.challenge,
    endpoint: offer.endpoint,
    scope: offer.scope,
    expiresAt: offer.expiresAt,
  };
  return `${PAYLOAD_PREFIX}${encodeBase64Url(JSON.stringify(payload))}`;
}

export function decodeDevicePairingPayload(
  value: string,
  options: { requireCanonicalOfferFields?: boolean } = {},
): ScannedPairingOffer | null {
  if (!value.startsWith(PAYLOAD_PREFIX)) return null;
  try {
    const payload = JSON.parse(
      decodeBase64Url(value.slice(PAYLOAD_PREFIX.length)),
    ) as Partial<ScannedPairingOffer>;
    if (
      options.requireCanonicalOfferFields &&
      Object.keys(payload).some(
        (key) => !CANONICAL_SCANNED_PAIRING_OFFER_FIELDS.has(key),
      )
    ) {
      return null;
    }
    if (
      payload.protocolVersion !== DEVICE_PAIRING_PROTOCOL_VERSION ||
      typeof payload.scope !== 'string' ||
      parsePairingScope(payload.scope) === null ||
      typeof payload.environmentId !== 'string' ||
      typeof payload.offerId !== 'string' ||
      typeof payload.challenge !== 'string' ||
      typeof payload.endpoint !== 'string' ||
      typeof payload.expiresAt !== 'number' ||
      payload.expiresAt <= Date.now()
    ) {
      return null;
    }
    const endpoint = new URL(payload.endpoint);
    const loopback =
      endpoint.hostname === 'localhost' ||
      endpoint.hostname === '127.0.0.1' ||
      endpoint.hostname === '[::1]';
    if (
      endpoint.protocol !== 'https:' &&
      !(endpoint.protocol === 'http:' && loopback)
    ) {
      return null;
    }
    return payload as ScannedPairingOffer;
  } catch {
    return null;
  }
}

/** Long enough for a slow tailnet hop, short enough to retry within the offer. */
const PAIRING_REQUEST_TIMEOUT_MS = 20_000;

/**
 * True only for a request that never reached the Station. Anything else thrown
 * without an HTTP status — a malformed success body, a fault in our own
 * handling — is a real failure and must not be retried silently.
 */
export function isTransportFailure(error: unknown): boolean {
  return (error as { transport?: boolean } | null)?.transport === true;
}

async function pairingFetch<T>(
  endpoint: string,
  path: string,
  body: unknown,
  // Typed as a string union rather than the DOM-only `RequestCredentials` so
  // this module type-checks under a Node `lib` too (the Station CLI imports it
  // via the `./device-pairing` subpath and compiles it without DOM types).
  credentials?: 'same-origin' | 'include' | 'omit',
  extraHeaders?: Record<string, string>,
  signal?: AbortSignal,
): Promise<T> {
  let response: Response;
  // A connection that is dropped rather than refused — a device losing its
  // network, or a webview resumed onto a dead socket — leaves fetch pending
  // with nothing to reject it. Without this, a polling caller waits forever on
  // a request that will never answer.
  const abort = new AbortController();
  const abortTimer = setTimeout(
    () => abort.abort(new Error('pairing_request_timeout')),
    PAIRING_REQUEST_TIMEOUT_MS,
  );
  const abortFromCaller = () => abort.abort(signal?.reason);
  if (signal?.aborted) abortFromCaller();
  else signal?.addEventListener('abort', abortFromCaller, { once: true });
  try {
    response = await fetch(new URL(path, endpoint), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(extraHeaders ?? {}) },
      body: JSON.stringify(body),
      signal: abort.signal,
      ...(credentials ? { credentials } : {}),
    });
  } catch (cause) {
    // The request never reached the Station. Callers that poll need to tell
    // this apart from a fault of their own, because a request worth retrying
    // and a bug worth reporting both arrive here without an HTTP status.
    throw Object.assign(new Error('network_unreachable'), {
      code: 'network_unreachable',
      transport: true,
      cause,
    });
  } finally {
    clearTimeout(abortTimer);
    signal?.removeEventListener('abort', abortFromCaller);
  }
  if (!response.ok) {
    const error = (await response
      .json()
      .catch(() => ({ error: 'request_failed' }))) as { error?: string };
    throw Object.assign(new Error(error.error ?? 'request_failed'), {
      code: error.error,
      status: response.status,
    });
  }
  return response.json() as Promise<T>;
}

/**
 * What the host said went wrong, if it said anything a client can key on.
 *
 * `pairingFetch` copies the host's own `error` field onto the thrown error as
 * `code` (see the `!response.ok` branch above); a transport failure carries
 * `network_unreachable` from the branch before it. The pattern bound is not a
 * validity check on our own vocabulary — an unrecognized code is still worth
 * showing — but a bound on what a *remote* host can put on this device's
 * screen, since the joiner is by definition talking to a Station it has not
 * yet established any trust in.
 */
function pairingFailureCode(error: unknown): string | undefined {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' && /^[a-z][a-z0-9_]{0,63}$/.test(code)
    ? code
    : undefined;
}

/**
 * The remedy for a refused pairing request, named from the host's own reason.
 *
 * The host computes a precise cause for every refusal — an offer that ran out
 * of time, an offer another device already claimed, an operator who said no,
 * a rate limit — and the joining device threw all of it away to print "The
 * pairing offer is invalid, expired, or already used." Those are three
 * conditions with three different next actions (scan a fresh code / have the
 * host make a new one for this device / stop, someone refused you), and the
 * person holding the phone could not tell which had happened.
 *
 * Codes that cannot arise from a join request are deliberately absent:
 * `device_active`, `device_revoked`, and `device_not_found` belong to the
 * host's own Paired Devices actions, and inventing joiner-facing copy for
 * them would be describing a screen this one can never reach.
 */
const PAIRING_REQUEST_FAILURE_MESSAGES: Readonly<Record<string, string>> = {
  network_unreachable:
    'Could not reach the Station at that address. Check that it is running and that this device can reach it.',
  rate_limited:
    'This Station is refusing further pairing attempts for now. Wait a minute, then try again.',
  invalid_offer:
    'This Station has no open pairing offer matching that code. Create a new code on the Station.',
  offer_expired:
    'That pairing code has expired. Create a new code on the Station and use it before it runs out.',
  offer_unavailable:
    'That pairing code has already been claimed by another device. Create a new code on the Station for this one.',
  offer_capacity_reached:
    'This Station already has as many pairing codes open as it allows. Finish or cancel one on the Station, then try again.',
  invalid_request:
    'This Station rejected these pairing details. Check the code and the device name, then try again.',
  request_denied:
    'Someone on the Station denied this request. Ask them to approve the next one before trying again.',
  request_not_found:
    'This Station has no record of this request — it was already finished or cleared. Start pairing again.',
  request_not_confirmed:
    'Nobody has approved this request yet. Approve it on the Station, then try again.',
  approval_requires_operator:
    'This request has to be approved on the Station itself. Run “station environment access approve” there.',
  identity_credential_quota_reached:
    'This Station has already granted you as many devices as it allows. Revoke one under Paired Devices on the Station, then try again.',
  unattributed_credential_quota_reached:
    'This Station has already granted as many devices as it allows. Revoke one under Paired Devices on the Station, then try again.',
};

/**
 * Turns a failure from {@link requestDevicePairing} into one sentence naming
 * the condition and its remedy. See
 * {@link PAIRING_REQUEST_FAILURE_MESSAGES} for why this exists.
 *
 * An unrecognized code still gets shown verbatim rather than dressed as one of
 * the known cases — the same shape as `deviceRevokeError`'s `(HTTP ${status})`
 * fallback, and for the same reason: a specific wrong answer is worse than an
 * honest one carrying the detail someone can search for.
 */
export function describePairingRequestFailure(error: unknown): string {
  const code = pairingFailureCode(error);
  const known = code ? PAIRING_REQUEST_FAILURE_MESSAGES[code] : undefined;
  if (known) return known;
  return code
    ? `This Station refused the pairing request (${code}). Create a new code on the Station and try again.`
    : 'This Station refused the pairing request. Create a new code on the Station and try again.';
}

export function requestDevicePairing(input: {
  endpoint: string;
  offerId: string;
  proof: string;
  deviceName: string;
}): Promise<DevicePairingRequest> {
  return pairingFetch(input.endpoint, PUBLIC_DEVICE_PAIRING_REQUEST_PATH, {
    clientInstanceId: pairingClientInstanceIdForOrigin(input.endpoint),
    deviceName: input.deviceName,
    offerId: input.offerId,
    proof: input.proof,
  });
}

export function requestCurrentStationAccess(input: {
  endpoint: string;
  deviceName: string;
  /**
   * Explicit `Origin` header value. Browser callers omit this — the browser
   * sets `Origin` itself and forbids scripts from overriding it. Non-browser
   * requesters (the Station CLI) must pass the host origin here so the
   * host's `same-origin` pairing-origin gate accepts the request; without it
   * Node's `fetch` sends no `Origin` header and the host answers
   * `origin_forbidden`.
   */
  origin?: string;
}): Promise<DevicePairingAccessRequestResponse> {
  return pairingFetch(
    input.endpoint,
    PUBLIC_DEVICE_PAIRING_ACCESS_REQUEST_PATH,
    {
      clientInstanceId: pairingClientInstanceIdForOrigin(input.endpoint),
      deviceName: input.deviceName,
    },
    'same-origin',
    input.origin ? { Origin: input.origin } : undefined,
  );
}

/**
 * Returns one opaque identifier for a Station endpoint origin. This is
 * correlation only: the offer proof and an operator approval remain the
 * pairing authority. Keeping it in client-local storage lets an approved
 * re-pair replace this app instance's old grant without inferring identity
 * from the user-visible device name.
 */
export function pairingClientInstanceIdForOrigin(
  endpoint: string,
  storage?: PairingStorage,
): string {
  const key = `${PAIRING_CLIENT_INSTANCE_STORAGE_PREFIX}${
    new URL(endpoint).origin
  }`;
  try {
    // Reading the localStorage property itself can throw SecurityError for an
    // opaque or policy-restricted origin, so even resolving the default lives
    // inside this boundary.
    const selectedStorage = storage ?? globalThis.localStorage;
    const existing = selectedStorage?.getItem(key);
    if (existing && CLIENT_INSTANCE_ID_PATTERN.test(existing)) return existing;
    const volatile = volatilePairingClientInstanceIds.get(key);
    if (volatile) {
      selectedStorage?.setItem(key, volatile);
      return volatile;
    }
    const instanceId = globalThis.crypto.randomUUID();
    selectedStorage?.setItem(key, instanceId);
    volatilePairingClientInstanceIds.set(key, instanceId);
    return instanceId;
  } catch {
    // Storage can be unavailable in private/restricted browser contexts. A
    // process-local opaque id still keeps request and exchange correlated;
    // only replacement semantics across launches are unavailable.
    const existing = volatilePairingClientInstanceIds.get(key);
    if (existing) return existing;
    const instanceId = globalThis.crypto.randomUUID();
    volatilePairingClientInstanceIds.set(key, instanceId);
    return instanceId;
  }
}

/**
 * station#1711 — the pending exchange used to be component-local `useState`,
 * discarded on every unmount (closing the panel, navigating away, the app
 * being killed, or an OS-terminated webview). Approval is asynchronous and
 * human-paced, so any of those left `offerId`/`proof`/`requestId`
 * unrecoverable while the host request sat `confirmed` with nothing left to
 * exchange it. Persisting it here — origin-and-kind-scoped, see
 * {@link pendingExchangeStorageKey} — and restoring it on mount lets the poll
 * resume instead of stranding an already-approved request.
 *
 * This is a bearer-equivalent secret at rest (the `proof`), so it is bounded
 * deliberately narrowly:
 * - keyed by endpoint origin plus `requestKind`, never a broader scope — see
 *   {@link pendingExchangeStorageKey} for why the kind is part of the key,
 *   not just a field on the stored record;
 * - never stored longer than the offer's own `expiresAt` — an expired record
 *   reads back as absent and is deleted on read, so a lapsed proof cannot
 *   silently resume;
 * - the caller (`DevicePairingPanel`) deletes it on every terminal outcome —
 *   success, denial, expiry, and the fatal branch — so a spent proof never
 *   lingers either;
 * - restoring it does not, and cannot, bypass `expectedEnvironmentId`
 *   verification: that check lives entirely in the exchange loop that already
 *   runs the same way whether `pending` came from a fresh request or from
 *   this restore.
 */
export interface PendingPairingExchange {
  endpoint: string;
  offerId: string;
  proof: string;
  requestId: string;
  expiresAt: number;
  expectedEnvironmentId?: string;
  browserSession: boolean;
  requestKind: 'code' | 'direct';
  /** Exact saved Station row that owns this request once it leaves the chooser. */
  targetConnectionId?: string;
  /** Snapshot of that row's user-facing label, retained across active-host changes. */
  targetConnectionLabel?: string;
  /**
   * When the request was created (station#1876). Optional because records
   * written by an earlier build do not carry it, and rejecting those would
   * strand a live, already-approvable request purely to gain a progress bar.
   * Its ONLY consumer is
   * {@link observePendingPairingApproval}'s `elapsedFraction`, which is
   * `undefined` without it — so an old record shows an indeterminate wait
   * rather than a fabricated percentage.
   */
  requestedAt?: number;
}

/**
 * A live pairing request that is waiting for someone to approve it on the
 * host (station#1876).
 *
 * This exists because "waiting for approval" and "the host is unreachable"
 * were rendering as the same screen. During the approval window the device
 * has no credential yet, so every health probe fails exactly as it would
 * against a dead host — and the gate showed "Can't reach server" while the
 * request sat there, perfectly healthy, waiting on a human.
 */
export interface PendingPairingApproval {
  requestKind: PendingPairingExchange['requestKind'];
  expiresAt: number;
  /** Milliseconds until the request expires; never negative. */
  remainingMs: number;
  /**
   * How far through its lifetime the request is, 0..1 — `undefined` when the
   * record predates `requestedAt` and the true span is unknown. Callers must
   * render an indeterminate wait in that case rather than inventing a value.
   */
  elapsedFraction?: number;
}

/**
 * station#1711 review (HIGH), second round — the key used to be origin-only,
 * so a direct request-access flow and a QR/manual-code flow at the same
 * origin wrote to the same slot: starting the second flow (e.g. "let me try
 * the QR code instead") clobbered a still-open, possibly already-approved
 * record from the first, and that approval became permanently uncollectible.
 * `requestKind` is now part of the key itself, so a `'direct'` flow and a
 * `'code'` flow at one origin occupy separate slots and cannot destroy each
 * other — this is a structural fix, not a read-side filter.
 *
 * A record written under the old origin-only key by a previous build is
 * unreadable through this key shape. That is accepted deliberately: these
 * records live only for the length of one pairing offer (minutes), this is
 * pre-release, and an unreadable old record cannot wedge anything — it is
 * simply inert leftover `localStorage` state that a fresh offer never reads
 * or writes back to.
 */
function pendingExchangeStorageKey(
  endpoint: string,
  requestKind: PendingPairingExchange['requestKind'],
): string {
  return `${PENDING_EXCHANGE_STORAGE_PREFIX}${new URL(endpoint).origin}:${requestKind}`;
}

export function savePendingExchange(
  exchange: PendingPairingExchange,
  storage?: PairingStorage,
): void {
  try {
    const selectedStorage = storage ?? globalThis.localStorage;
    selectedStorage?.setItem(
      pendingExchangeStorageKey(exchange.endpoint, exchange.requestKind),
      JSON.stringify(exchange),
    );
    notifyPendingExchangeChanged();
  } catch {
    // Storage can be unavailable in private/restricted browser contexts. The
    // exchange still proceeds for this session; it just cannot survive an
    // unmount the way it would with storage available — the pre-fix
    // behavior for this one session, not a crash.
  }
}

/**
 * Reads back a pending exchange for this endpoint origin and `requestKind`,
 * or `null` when there is none, it fails to parse, it is missing a required
 * field, or it has expired (deleted on read either way — an expired record
 * is treated as absent, never resumed).
 *
 * `requestKind` is a required parameter, not a post-read filter: the storage
 * key is origin-and-kind-scoped (see {@link pendingExchangeStorageKey}), so
 * a `'code'` flow and a `'direct'` flow at the same origin already live in
 * separate slots and cannot read each other's record through this function —
 * there is no mismatch case left to guard against here. The one shape check
 * this function still performs on `parsed.requestKind` is ordinary payload
 * validation (the same treatment every other field gets), not a security
 * boundary; the key is the boundary.
 */
export function loadPendingExchange(
  endpoint: string,
  requestKind: PendingPairingExchange['requestKind'],
  storage?: PairingStorage,
): PendingPairingExchange | null {
  try {
    const selectedStorage = storage ?? globalThis.localStorage;
    const key = pendingExchangeStorageKey(endpoint, requestKind);
    const raw = selectedStorage?.getItem(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<PendingPairingExchange>;
    if (
      typeof parsed.endpoint !== 'string' ||
      typeof parsed.offerId !== 'string' ||
      typeof parsed.proof !== 'string' ||
      typeof parsed.requestId !== 'string' ||
      typeof parsed.expiresAt !== 'number' ||
      typeof parsed.browserSession !== 'boolean' ||
      (parsed.requestKind !== 'code' && parsed.requestKind !== 'direct') ||
      (parsed.expectedEnvironmentId !== undefined &&
        typeof parsed.expectedEnvironmentId !== 'string') ||
      (parsed.targetConnectionId !== undefined &&
        typeof parsed.targetConnectionId !== 'string') ||
      (parsed.targetConnectionLabel !== undefined &&
        typeof parsed.targetConnectionLabel !== 'string')
    ) {
      selectedStorage?.removeItem?.(key);
      return null;
    }
    if (parsed.expiresAt <= Date.now()) {
      selectedStorage?.removeItem?.(key);
      return null;
    }
    return parsed as PendingPairingExchange;
  } catch {
    return null;
  }
}

/**
 * Observes whether a pairing request for `endpoint` is currently awaiting
 * approval, without mutating anything (station#1876).
 *
 * Deliberately NOT built on {@link loadPendingExchange}: that function deletes
 * an expired record as a side effect of reading it, which is correct for the
 * poll loop that owns the record's lifecycle and wrong for a render path that
 * merely wants to describe the current state. A screen asking "what is
 * happening right now?" must not be able to destroy the thing it is asking
 * about.
 *
 * Returns `null` when no request is pending, when the stored record is
 * unparseable, or when it has already expired — so a caller can only show a
 * waiting state while one genuinely exists. That direction matters as much as
 * the other: relabelling a real outage as "preparing the connection" would be
 * the same lie as calling an approval wait "can't reach server".
 *
 * Both request kinds are checked because the caller (an app-level gate) does
 * not know which flow the user started. When both slots hold a live record —
 * the user began a direct request and then also scanned a code — the one
 * expiring LAST is reported, since that is the one still worth waiting on.
 */
export function observePendingPairingApproval(
  endpoint: string,
  now: number,
  storage?: PairingStorage,
): PendingPairingApproval | null {
  let best: PendingPairingApproval | null = null;
  for (const requestKind of ['direct', 'code'] as const) {
    const record = readPendingExchangeWithoutExpiry(
      endpoint,
      requestKind,
      storage,
    );
    if (!record) continue;
    if (record.expiresAt <= now) continue;
    const span =
      typeof record.requestedAt === 'number'
        ? record.expiresAt - record.requestedAt
        : undefined;
    const candidate: PendingPairingApproval = {
      requestKind,
      expiresAt: record.expiresAt,
      remainingMs: Math.max(0, record.expiresAt - now),
      ...(span !== undefined && span > 0
        ? {
            elapsedFraction: Math.min(
              1,
              Math.max(0, (now - (record.requestedAt as number)) / span),
            ),
          }
        : {}),
    };
    if (!best || candidate.expiresAt > best.expiresAt) best = candidate;
  }
  return best;
}

/** Parse-only read backing {@link observePendingPairingApproval}: no expiry deletion, no writes. */
function readPendingExchangeWithoutExpiry(
  endpoint: string,
  requestKind: PendingPairingExchange['requestKind'],
  storage?: PairingStorage,
): PendingPairingExchange | null {
  try {
    const selectedStorage = storage ?? globalThis.localStorage;
    const raw = selectedStorage?.getItem(
      pendingExchangeStorageKey(endpoint, requestKind),
    );
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<PendingPairingExchange>;
    if (
      typeof parsed.endpoint !== 'string' ||
      typeof parsed.requestId !== 'string' ||
      typeof parsed.expiresAt !== 'number' ||
      parsed.requestKind !== requestKind ||
      (parsed.targetConnectionId !== undefined &&
        typeof parsed.targetConnectionId !== 'string') ||
      (parsed.targetConnectionLabel !== undefined &&
        typeof parsed.targetConnectionLabel !== 'string')
    ) {
      return null;
    }
    return parsed as PendingPairingExchange;
  } catch {
    return null;
  }
}

export function clearPendingExchange(
  endpoint: string,
  requestKind: PendingPairingExchange['requestKind'],
  storage?: PairingStorage,
): void {
  try {
    const selectedStorage = storage ?? globalThis.localStorage;
    selectedStorage?.removeItem?.(
      pendingExchangeStorageKey(endpoint, requestKind),
    );
    notifyPendingExchangeChanged();
  } catch {
    // Best-effort, matching the read/write paths above.
  }
}

export function exchangeDevicePairing(input: {
  endpoint: string;
  offerId: string;
  proof: string;
  requestId: string;
  /** Explicit injection is useful to non-browser clients and focused tests. */
  clientInstanceId?: string;
  browserSession?: boolean;
  /** Cancels only this exchange attempt; browser callers retain the 20s cap. */
  signal?: AbortSignal;
  /** Explicit injection is useful to native transport tests. */
  operationId?: string;
}): Promise<{
  environmentId: string;
  clientInstanceId: string;
  device: PairedDevice;
  credential?: string;
  credentialHandle?: string;
  credentialRef?: StationProfileCredentialRef;
  browserSession: boolean;
}> {
  const exchangeInput = {
    ...input,
    clientInstanceId:
      input.clientInstanceId ??
      pairingClientInstanceIdForOrigin(input.endpoint),
    operationId: input.operationId ?? globalThis.crypto.randomUUID(),
  };
  const exchange = nativePairingExchangeTransport
    ? nativePairingExchangeTransport(exchangeInput)
    : pairingFetch<DevicePairingExchangeResponse>(
        input.endpoint,
        PUBLIC_DEVICE_PAIRING_EXCHANGE_PATH,
        {
          ...(input.browserSession
            ? { delivery: DEVICE_PAIRING_BROWSER_COOKIE_DELIVERY }
            : {}),
          clientInstanceId: exchangeInput.clientInstanceId,
          offerId: input.offerId,
          proof: input.proof,
          requestId: input.requestId,
        },
        input.browserSession ? 'same-origin' : undefined,
        undefined,
        input.signal,
      );
  return exchange.then((result) => ({
    environmentId: result.environmentId,
    // This is the exact UUID sent to the host and bound into its device grant.
    // Carry it through completion so native persistence never reconstructs or
    // guesses the server's supersession subject.
    clientInstanceId: exchangeInput.clientInstanceId,
    device: result.device,
    credential: 'credential' in result ? result.credential : undefined,
    credentialHandle:
      'credentialHandle' in result &&
      typeof result.credentialHandle === 'string'
        ? result.credentialHandle
        : undefined,
    credentialRef:
      'credentialRef' in result && result.credentialRef
        ? result.credentialRef
        : undefined,
    browserSession:
      'delivery' in result &&
      result.delivery === DEVICE_PAIRING_BROWSER_COOKIE_DELIVERY,
  }));
}
