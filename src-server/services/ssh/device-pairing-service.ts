import {
  createHash,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from 'node:crypto';
import {
  closeSync,
  constants,
  existsSync,
  fchmodSync,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import {
  DEFAULT_GRANT_PAIRING_SCOPE,
  DEVICE_PAIRING_PROTOCOL_VERSION,
  DEVICE_PAIRING_SCOPE,
  type DevicePairingOffer,
  type DevicePairingRequest,
  isPairingScopeSubset,
  PAIRING_SCOPE_ACCESS_APPROVE,
  PAIRING_SCOPE_GRANT_PATHS,
  PAIRING_SCOPES,
  type PairedDevice,
  type PairedDeviceKind,
  type PairingScope,
  parsePairingScope,
  type TailscaleServeRequester,
  type WebPushSubscription,
} from '@kontourai/station-contracts';

const REGISTRY_SCHEMA_VERSION = 2 as const;
const PRE_ACTIVITY_REGISTRY_SCHEMA_VERSION = 1;
const REGISTRY_FILE = 'paired-devices.json';
const PRIVATE_FILE_MODE = 0o600;
const DEFAULT_OFFER_TTL_MS = 5 * 60_000;
const DEFAULT_MAX_ACTIVE_OFFERS = 256;
const DEFAULT_MAX_ACTIVE_CREDENTIALS_PER_VERIFIED_IDENTITY = 5;
const DEFAULT_MAX_ACTIVE_CREDENTIALS_WITHOUT_VERIFIED_IDENTITY = 16;
const LAST_USED_WRITE_INTERVAL_MS = 60_000;

/**
 * True for hosts a device can reach only on a trusted local segment —
 * loopback, RFC1918 private IPv4, link-local, CGNAT/tailnet (100.64/10), and
 * the app-webview / mDNS names. Cleartext http is acceptable for these; public
 * hostnames still require https.
 */
function isPrivateOrLoopbackHost(url: URL): boolean {
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (
    host === 'localhost' ||
    host === '127.0.0.1' ||
    host === '::1' ||
    host === 'tauri.localhost' ||
    host.endsWith('.localhost') ||
    host.endsWith('.local')
  ) {
    return true;
  }
  const v4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.\d{1,3}$/);
  if (v4) {
    const a = Number(v4[1]);
    const b = Number(v4[2]);
    if (a === 10) return true; // 10.0.0.0/8
    if (a === 192 && b === 168) return true; // 192.168.0.0/16
    if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
    if (a === 169 && b === 254) return true; // link-local
    if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10 (CGNAT/tailnet)
  }
  return false;
}
const BASE64URL_32_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const OFFER_ID_PATTERN = /^[A-Za-z0-9_-]{32}$/;
const MANUAL_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
const MANUAL_CODE_LENGTH = 10;
const MANUAL_CODE_BATCH_BYTES = 32;
const MANUAL_CODE_MAX_BATCHES = 4;
const MANUAL_CODE_REJECTION_LIMIT = 256 - (256 % MANUAL_ALPHABET.length);
/** 10 * log2(31): exact ideal entropy of the unbiased manual-code alphabet. */
export const MANUAL_CODE_ENTROPY_BITS =
  MANUAL_CODE_LENGTH * Math.log2(MANUAL_ALPHABET.length);
const PUSH_ENDPOINT_PATTERN = /^https:\/\/.{1,2000}$/;
const PUSH_KEY_PATTERN = /^[A-Za-z0-9_-]{1,256}$/;
const CLIENT_INSTANCE_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const REGISTRY_KEYS = new Set(['schemaVersion', 'environmentId', 'devices']);
const DEVICE_RECORD_KEYS = new Set([
  'id',
  'name',
  'scope',
  'kind',
  'createdAt',
  'issuedAt',
  'lastUsedAt',
  'revokedAt',
  'credentialHash',
  'clientInstanceId',
  'pushSubscription',
  'source',
  'requester',
  'activityTracking',
  'lastSeenFrom',
  'usageCount',
  'lastActiveDay',
  'revocation',
  'locality',
  // archive#3677 PR 3. The strict key check rejects any unknown key, so a
  // field the writer persists but this set omits makes the registry
  // UNREADABLE at the next boot — the review caught exactly that.
  'mintKind',
]);
const PRE_ACTIVITY_DEVICE_RECORD_KEYS = new Set([
  'id',
  'name',
  'scope',
  'kind',
  'createdAt',
  'issuedAt',
  'lastUsedAt',
  'revokedAt',
  'credentialHash',
  'clientInstanceId',
  'pushSubscription',
  'source',
  'requester',
]);
const TAILNET_REQUESTER_KEYS = new Set(['provider', 'login', 'displayName']);
const NOT_REVOKED_KEYS = new Set(['state']);
const UNOBSERVED_REVOCATION_KEYS = new Set(['state']);
const RECORDED_REVOCATION_KEYS = new Set(['state', 'actor', 'reason']);

interface StoredDevice extends PairedDevice {
  credentialHash: string;
  /** PRIVATE — never surfaced through publicDevice()/PairedDevice. */
  clientInstanceId?: string;
  /** PRIVATE — never surfaced through publicDevice()/PairedDevice. */
  pushSubscription: WebPushSubscription | null;
  /**
   * PRIVATE — mint-time proof that issuance presented the local-grant
   * secret or a direct-loopback UI-bootstrap (no proxy attestation).
   * Never client-supplied; never copied onto the public PairedDevice wire.
   */
  locality?: 'home-possession';
  /**
   * PRIVATE — WHICH home-possession mint path issued this credential
   * (archive#3677 PR 3). `local-grant` means the per-boot owner-only secret
   * FILE was read and presented — a proof no browser/webview JS context can
   * produce, which is exactly why the native consent broker keys on it:
   * `locality` alone also covers the UI-bootstrap mint, whose credential
   * lives IN browser JS on the host, where same-origin plugin code runs.
   * Never client-supplied; never copied onto the public PairedDevice wire.
   */
  mintKind?: 'local-grant' | 'ui-bootstrap';
}

interface DeviceRegistry {
  schemaVersion: typeof REGISTRY_SCHEMA_VERSION;
  environmentId: string;
  devices: StoredDevice[];
}

interface PairingOfferState extends DevicePairingOffer {
  status: 'open' | 'requested' | 'confirmed' | 'used' | 'cancelled';
  request?: DevicePairingRequest;
  /** PRIVATE — binds display-name reuse to the requesting app instance. */
  clientInstanceId?: string;
  /**
   * archive#1123: host-side-only label (never sent to the joiner as
   * part of {@link DevicePairingOffer}) carried through to the exchanged
   * {@link PairedDevice.kind}. Defaults to `'device'` — see {@link
   * DevicePairingService.createOffer}.
   */
  kind: PairedDeviceKind;
  /**
   * Where the caller that submitted `request` was, as far as this host can
   * prove (archive#1490); set only when a request exists. PRIVATE —
   * deliberately not on the wire `DevicePairingRequest`, which carries no
   * network identity; `station.device_pairing.requests` holds the same line.
   */
  requesterPosition?: PairingRequesterPosition;
}

type PairingProvenance =
  | { source: 'tailnet'; requester: TailscaleServeRequester }
  | {
      source?: 'same-origin' | 'pairing-code';
      requester?: never;
    };

/**
 * Who is asking for a pending pairing request to be APPROVED (archive#1490).
 *
 * Approval is the one pairing step that converts a position into durable
 * authority: the confirmed request is exchanged for a device credential that
 * keeps working after the caller's access to this machine ends. Every other
 * step is either public by design (the joiner's own request/exchange) or
 * reversible by the operator.
 *
 * It is a REQUIRED argument, not an option bag with a permissive default, and
 * the guard below is written as an ALLOW-list. Before this existed,
 * `confirmRequest` had no caller-identity input at all: the "a request cannot
 * approve itself" property that `DevicePairingPanel` states in its own copy
 * historically lived entirely in the HTTP boundary, allowing a caller with an
 * SSH local forward to self-issue a full-authority credential. archive#2051
 * now rejects bare loopback and SSH requests before this route; the property
 * also belongs here, where it holds for every caller of the service rather
 * than for one route.
 *
 * `presented-credential` means the HTTP boundary verified a credential AND it
 * satisfied this route's `access:manage` tier. On `/api/pairing/**` that is the
 * operator's own credential specifically: `EnvironmentSecurityService.
 * authorizeCredential` refuses a paired-device credential on this family
 * outright, so no device — however broadly scoped — reaches here.
 *
 * `local-grant` (archive#1715) is a THIRD strong kind, not a weaker
 * substitute for either of the two above: it means the HTTP boundary verified
 * possession of the per-boot, owner-only-file local-grant secret from a
 * DIRECT loopback caller (`configureDevicePairingPublicRoutes`'s
 * `/.well-known/station/v1/pairing/local-grant` route). Reading that file
 * requires the same OS-user filesystem authority as reading the operator
 * credential file itself, so it is treated the same as `presented-credential`
 * in the check below — never routed through {@link unauthenticatedApprovalAllowed},
 * which exists only for a caller that proved nothing at all.
 */
/**
 * Where a pairing request came from, as far as this host can PROVE
 * (archive#1490).
 *
 * `off-box` is earned by `isDefinitelyOffBox` (`src-server/security/
 * off-box-peer.ts`) — the packet came from a network stack that is not this
 * one. `unproven` is everything else and is not a claim that the requester was
 * local: an unreadable socket, an address family nothing recognises, and this
 * host's own loopback all land here together, because the only safe reading of
 * "cannot prove it was elsewhere" is "do not grant on it."
 */
export type PairingRequesterPosition = 'off-box' | 'unproven';

export type PairingApproval =
  | { readonly kind: 'presented-credential' }
  | { readonly kind: 'local-grant' }
  /** Single-use launcher capability exchanged by the Station UI. */
  | { readonly kind: 'ui-bootstrap' }
  | { readonly kind: 'unauthenticated' };

export type DeviceRevocationActor = 'operator-credential';

/**
 * Whether an exact Station-internal caller with no pairing credential may
 * approve this request.
 *
 * The rule, in one line: **an exact Station-internal caller may approve only a
 * request this host can prove came from somewhere else.** Bare loopback and
 * SSH requests are rejected by runtime authentication before reaching this
 * service. The remaining question is where the REQUEST came from, and a device
 * asking to be paired is a device that is elsewhere.
 *
 * Stated as an allow-list over a positively-earned verdict, not as a negation
 * of "loopback". Those are not the same set, and the difference is the whole
 * finding that shaped this: `isDefinitelyOffBox` also refuses link-local
 * (`fe80::1%lo0` is the loopback interface's own address), every address this
 * host currently holds (so dialling the box's own LAN address from the box
 * proves nothing), the unspecified address, an unreadable socket, and any
 * address family nothing recognises. A rule written as `!== 'loopback'` grants
 * on every one of those.
 *
 * What this preserves is the whole point of the floor: a phone, tablet, or
 * laptop reaching this Station from the LAN or the tailnet contributes its own
 * source address, which is not one of this host's, so the operator still
 * approves it from an unenrolled browser at the machine — for the QR/manual
 * code flow and the per-connection "Request access" flow alike.
 *
 * What it costs is same-machine pairing, whichever address the browser dials:
 * a second browser or a native shell on the host itself must be approved by
 * something presenting a credential (`station environment access approve
 * <id>`, which reads the operator credential from the Station home; the
 * desktop shell can read the same file). That is not a regression a smarter
 * check could avoid — it is the attack, performed by a friendly party, and
 * nothing observable separates the two.
 *
 * WHAT REMAINS, stated plainly (archive#1490): "not this network stack" is
 * weaker than "another machine". A container, VM, or other network namespace
 * on this same box has its own source address and is off-box here; so is any
 * second machine the adversary holds, and so is a NAT hairpin whose source is
 * rewritten to an address this host does not hold. See
 * `docs/security/remote-access-threat-model.md` for the full statement and for
 * why the sound closure (a presented credential on the approval route) is an
 * owner call about first-run experience rather than an oversight.
 */
function unauthenticatedApprovalAllowed(offer: PairingOfferState): boolean {
  if (!offer.request) return false;
  return offer.requesterPosition === 'off-box';
}

export interface DevicePairingServiceOptions {
  homeDir: string;
  environmentId: string;
  now?: () => number;
  offerTtlMs?: number;
  maxActiveOffers?: number;
  /**
   * Limits concurrently active credentials issued for one server-verified
   * ingress identity. The only identity source today is Tailscale Serve, so
   * requests without a verified requester are deliberately not assigned a
   * guessed identity here; their abuse budget belongs at the HTTP boundary.
   */
  maxActiveCredentialsPerVerifiedIdentity?: number;
  /**
   * Bounds active credentials that have no server-verified requester identity
   * (same-origin/pairing-code and historical records). This is intentionally
   * global: no self-declared client field is an authority key.
   */
  maxActiveCredentialsWithoutVerifiedIdentity?: number;
}

export class DevicePairingError extends Error {
  constructor(
    readonly code:
      | 'invalid_offer'
      | 'offer_expired'
      | 'offer_capacity_reached'
      | 'offer_unavailable'
      | 'identity_credential_quota_reached'
      | 'unattributed_credential_quota_reached'
      | 'invalid_request'
      | 'request_not_found'
      | 'request_not_confirmed'
      | 'request_denied'
      | 'approval_requires_operator'
      | 'device_revoked'
      | 'device_active'
      | 'device_not_found'
      // archive#3816: a requested scope outside the closed vocabulary, or
      // empty. Distinct from `scope_not_grantable`, which is a well-formed
      // token that has no legitimate promotion path.
      | 'invalid_scope'
      | 'scope_not_grantable'
      // archive#3816: the device's scope changed under a caller who was
      // editing it. Its whole-scope replacement is refused rather than
      // silently reverting someone else's decision.
      | 'scope_changed',
  ) {
    super(
      code === 'identity_credential_quota_reached' ||
        code === 'unattributed_credential_quota_reached'
        ? 'Credential grant quota reached. Open Paired Devices in the connection manager to review last-used grants and revoke stale ones.'
        : code,
    );
    this.name = 'DevicePairingError';
  }
}

function digest(value: string): Buffer {
  return createHash('sha256').update(value).digest();
}

function equalSecret(left: string, right: string): boolean {
  return timingSafeEqual(digest(left), digest(right));
}

/**
 * Truncates to at most `maxCodeUnits` UTF-16 code units without splitting an
 * astral (surrogate-pair) character in two. `String#slice` counts code
 * units, so a naive slice can leave a lone leading surrogate at the cut
 * point; dropping that trailing high surrogate keeps the result
 * well-formed.
 */
function truncateToCodeUnits(value: string, maxCodeUnits: number): string {
  if (value.length <= maxCodeUnits) return value;
  const sliced = value.slice(0, maxCodeUnits);
  const lastCodeUnit = sliced.charCodeAt(sliced.length - 1);
  const endsInHighSurrogate = lastCodeUnit >= 0xd800 && lastCodeUnit <= 0xdbff;
  return endsInHighSurrogate ? sliced.slice(0, -1) : sliced;
}

/**
 * Draws uniformly from the 31-symbol manual alphabet. Bytes 248..255 are
 * rejected because mapping them modulo 31 would make eight symbols more
 * likely. Four fixed 32-byte draws bound entropy-source work; exhausting
 * them is a loud failure rather than a biased fallback.
 */
export function manualCodeFromEntropy(
  readBytes: (size: number) => Uint8Array = randomBytes,
): string {
  let value = '';
  for (let batch = 0; batch < MANUAL_CODE_MAX_BATCHES; batch += 1) {
    const bytes = readBytes(MANUAL_CODE_BATCH_BYTES);
    if (bytes.length !== MANUAL_CODE_BATCH_BYTES) {
      throw new Error('Manual pairing-code entropy source returned wrong size');
    }
    for (const byte of bytes) {
      if (byte >= MANUAL_CODE_REJECTION_LIMIT) continue;
      value += MANUAL_ALPHABET[byte % MANUAL_ALPHABET.length];
      if (value.length === MANUAL_CODE_LENGTH) return value;
    }
  }
  throw new Error(
    'Manual pairing-code entropy source yielded insufficient bytes',
  );
}

function manualCode(): string {
  return manualCodeFromEntropy();
}

function publicDevice(device: StoredDevice): PairedDevice {
  const {
    credentialHash: _credentialHash,
    clientInstanceId: _clientInstanceId,
    pushSubscription: _pushSubscription,
    locality: _locality,
    mintKind: _mintKind,
    ...safe
  } = device;
  return safe;
}

function isValidPushSubscription(value: unknown): value is WebPushSubscription {
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  if (
    typeof record.endpoint !== 'string' ||
    !PUSH_ENDPOINT_PATTERN.test(record.endpoint)
  ) {
    return false;
  }
  const keys = record.keys;
  if (!keys || typeof keys !== 'object') return false;
  const keyRecord = keys as Record<string, unknown>;
  return (
    typeof keyRecord.p256dh === 'string' &&
    PUSH_KEY_PATTERN.test(keyRecord.p256dh) &&
    typeof keyRecord.auth === 'string' &&
    PUSH_KEY_PATTERN.test(keyRecord.auth)
  );
}

function pairingProvenance(input: {
  source?: DevicePairingRequest['source'];
  requester?: TailscaleServeRequester;
}):
  | { source: 'tailnet'; requester: TailscaleServeRequester }
  | { source: 'same-origin' | 'pairing-code' } {
  const source = input.source ?? 'pairing-code';
  if (source === 'tailnet') {
    const requester = input.requester;
    if (
      requester?.provider !== 'tailscale-serve' ||
      !safeRequesterText(requester.login, 254) ||
      (requester.displayName !== undefined &&
        !safeRequesterText(requester.displayName, 128))
    ) {
      throw new DevicePairingError('invalid_request');
    }
    return { source, requester: { ...requester } };
  }
  if (
    input.requester !== undefined ||
    (source !== 'same-origin' && source !== 'pairing-code')
  ) {
    throw new DevicePairingError('invalid_request');
  }
  return { source };
}

function cloneRequest(request: DevicePairingRequest): DevicePairingRequest {
  return request.source === 'tailnet'
    ? { ...request, requester: { ...request.requester } }
    : { ...request };
}

function safeRequesterText(value: string, maxLength: number): boolean {
  return (
    value === value.trim() &&
    value.length > 0 &&
    value.length <= maxLength &&
    !Array.from(value).some((character) => {
      const code = character.charCodeAt(0);
      return code <= 0x1f || code === 0x7f;
    })
  );
}

/**
 * Same shape check {@link pairingProvenance} applies to an incoming request,
 * reused for a persisted {@link PairedDevice.requester} on registry load
 * (archive#1878) so a corrupted or hand-edited record fails closed
 * instead of surfacing a malformed requester to a caller.
 */
function isValidStoredRequester(
  value: unknown,
): value is TailscaleServeRequester {
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  return (
    hasOnlyKnownKeys(record, TAILNET_REQUESTER_KEYS) &&
    record.provider === 'tailscale-serve' &&
    typeof record.login === 'string' &&
    safeRequesterText(record.login, 254) &&
    (record.displayName === undefined ||
      (typeof record.displayName === 'string' &&
        safeRequesterText(record.displayName, 128)))
  );
}

function hasOnlyKnownKeys(
  value: Record<string, unknown>,
  knownKeys: ReadonlySet<string>,
): boolean {
  return Object.keys(value).every((key) => knownKeys.has(key));
}

function isValidActivityDay(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return false;
  }
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return (
    !Number.isNaN(parsed.valueOf()) &&
    parsed.toISOString().slice(0, 10) === value
  );
}

function isValidRevocation(value: unknown, revokedAt: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  if (record.state === 'not-revoked') {
    return revokedAt === null && hasOnlyKnownKeys(record, NOT_REVOKED_KEYS);
  }
  if (record.state === 'unobserved-before-revocation-provenance') {
    return (
      typeof revokedAt === 'number' &&
      hasOnlyKnownKeys(record, UNOBSERVED_REVOCATION_KEYS)
    );
  }
  return (
    record.state === 'recorded' &&
    typeof revokedAt === 'number' &&
    ((record.actor === 'operator-credential' &&
      record.reason === 'owner-request') ||
      (record.actor === 'same-client-replacement' &&
        record.reason === 'same-client-replacement')) &&
    hasOnlyKnownKeys(record, RECORDED_REVOCATION_KEYS)
  );
}

function validateRegistry(
  value: unknown,
  environmentId: string,
): DeviceRegistry {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Invalid paired-device registry');
  }
  const record = value as Partial<DeviceRegistry> & Record<string, unknown>;
  const schemaVersion: unknown = record.schemaVersion;
  const migratesPreActivityRegistry =
    schemaVersion === PRE_ACTIVITY_REGISTRY_SCHEMA_VERSION;
  if (
    !hasOnlyKnownKeys(record, REGISTRY_KEYS) ||
    (!migratesPreActivityRegistry &&
      schemaVersion !== REGISTRY_SCHEMA_VERSION) ||
    record.environmentId !== environmentId ||
    !Array.isArray(record.devices)
  ) {
    throw new Error('Invalid paired-device registry schema or environment');
  }
  for (const device of record.devices) {
    const deviceRecord = device as unknown as Record<string, unknown>;
    if (
      !device ||
      !hasOnlyKnownKeys(
        deviceRecord,
        migratesPreActivityRegistry
          ? PRE_ACTIVITY_DEVICE_RECORD_KEYS
          : DEVICE_RECORD_KEYS,
      ) ||
      typeof device.id !== 'string' ||
      typeof device.name !== 'string' ||
      typeof device.scope !== 'string' ||
      // A device paired before scoped pairing (archive#1098) persisted the
      // legacy fixed marker; every other record must be a valid scope
      // string. Both cases are migrated to a real scope below.
      (device.scope !== DEVICE_PAIRING_SCOPE &&
        parsePairingScope(device.scope) === null) ||
      typeof device.createdAt !== 'number' ||
      (device.issuedAt !== undefined && typeof device.issuedAt !== 'number') ||
      (device.lastUsedAt !== undefined &&
        device.lastUsedAt !== null &&
        typeof device.lastUsedAt !== 'number') ||
      (!migratesPreActivityRegistry &&
        device.activityTracking !== 'tracked-since-issued' &&
        device.activityTracking !== 'unobserved-before-activity-tracking') ||
      (!migratesPreActivityRegistry &&
        device.lastSeenFrom !== null &&
        device.lastSeenFrom !== 'loopback' &&
        device.lastSeenFrom !== 'lan' &&
        device.lastSeenFrom !== 'tailnet') ||
      (!migratesPreActivityRegistry &&
        device.usageCount !== null &&
        (!Number.isSafeInteger(device.usageCount) || device.usageCount < 0)) ||
      (!migratesPreActivityRegistry &&
        device.lastActiveDay !== null &&
        !isValidActivityDay(device.lastActiveDay)) ||
      (device.revokedAt !== null && typeof device.revokedAt !== 'number') ||
      (!migratesPreActivityRegistry &&
        !isValidRevocation(device.revocation, device.revokedAt)) ||
      typeof device.credentialHash !== 'string' ||
      !BASE64URL_32_PATTERN.test(device.credentialHash) ||
      (device.clientInstanceId !== undefined &&
        (typeof device.clientInstanceId !== 'string' ||
          !CLIENT_INSTANCE_ID_PATTERN.test(device.clientInstanceId))) ||
      // Additive field (archive#1123): a record persisted before
      // `kind` existed has no such key at all — only reject a PRESENT but
      // malformed value, never a missing one. Migrated to 'device' below.
      (device.kind !== undefined &&
        device.kind !== 'device' &&
        device.kind !== 'delegation') ||
      // Additive fields (archive#1878): a record persisted before
      // `source`/`requester` existed has no such keys at all — only reject a
      // PRESENT but malformed value, never a missing one. Unlike `kind`
      // there is no forward migration: an absent `source` stays absent, see
      // `PairedDevice.source`'s doc.
      (device.source !== undefined &&
        device.source !== 'same-origin' &&
        device.source !== 'pairing-code' &&
        device.source !== 'tailnet') ||
      // `requester` is only ever written alongside `source: 'tailnet'` (see
      // `exchange()`) — any other combination is corruption, not a legacy
      // shape, so it fails closed rather than being silently dropped.
      (device.requester !== undefined && device.source !== 'tailnet') ||
      (device.source === 'tailnet' &&
        !isValidStoredRequester(device.requester)) ||
      // Additive (D6 round 3): mint-time home-possession only. Absent on
      // every historical record and on every pairing/access-request mint.
      // A present value that is not the one token is corruption.
      (device.locality !== undefined &&
        device.locality !== 'home-possession') ||
      // archive#3677 PR 3, same posture as `locality`: absent on every
      // historical record; a present value outside the two mint kinds is
      // corruption. And a kind WITHOUT the possession proof is refused at
      // READ as well as at write — it is a mint-path label with no
      // derivation, and this is the layer a hand-edited registry reaches.
      (device.mintKind !== undefined &&
        (device.locality !== 'home-possession' ||
          (device.mintKind !== 'local-grant' &&
            device.mintKind !== 'ui-bootstrap')))
    ) {
      throw new Error('Invalid paired-device record');
    }
    // Additive field: older registries never wrote it. Missing means null,
    // never an implicit subscription.
    if (
      device.pushSubscription !== undefined &&
      device.pushSubscription !== null &&
      !isValidPushSubscription(device.pushSubscription)
    ) {
      throw new Error('Invalid paired-device push subscription');
    }
  }
  return {
    ...record,
    schemaVersion: REGISTRY_SCHEMA_VERSION,
    devices: record.devices.map((rawDevice) => {
      // Null was the old on-disk spelling for never used. Normalize it (and
      // any non-number value) to ABSENT here so no later projection can leak
      // null to consumers whose contract is absent-never-null.
      const { issuedAt, lastUsedAt, ...device } = rawDevice;
      return {
        ...device,
        // R4/AC3 migration: a pre-scoping device reads as full access, in
        // place, with no forced re-pair.
        scope:
          device.scope === DEVICE_PAIRING_SCOPE
            ? DEFAULT_GRANT_PAIRING_SCOPE
            : device.scope,
        // archive#1123: a device paired before `kind` existed has no
        // such key at all and reads back as 'device' — every existing stored
        // record migrates in place, no forced re-pair.
        kind: device.kind === 'delegation' ? 'delegation' : 'device',
        ...(typeof issuedAt === 'number' ? { issuedAt } : {}),
        ...(typeof lastUsedAt === 'number' ? { lastUsedAt } : {}),
        pushSubscription: device.pushSubscription ?? null,
        ...(migratesPreActivityRegistry
          ? {
              activityTracking: 'unobserved-before-activity-tracking' as const,
              lastSeenFrom: null,
              usageCount: null,
              lastActiveDay: null,
              revocation:
                device.revokedAt === null
                  ? ({ state: 'not-revoked' } as const)
                  : ({
                      state: 'unobserved-before-revocation-provenance',
                    } as const),
            }
          : {}),
      };
    }),
  } as DeviceRegistry;
}

function cloneRegistry(registry: DeviceRegistry): DeviceRegistry {
  return {
    ...registry,
    devices: registry.devices.map((device) => ({
      ...device,
      ...(device.requester ? { requester: { ...device.requester } } : {}),
      pushSubscription: device.pushSubscription
        ? {
            ...device.pushSubscription,
            keys: { ...device.pushSubscription.keys },
          }
        : null,
      revocation: { ...device.revocation },
    })),
  };
}

/**
 * A caller-controlled instance id is only a replacement key inside an
 * already-proven principal. It must never let one tailnet identity, or an
 * identityless source, revoke another's device.
 */
function isSameReplacementDomain(
  existing: Pick<StoredDevice, 'source' | 'requester'>,
  request: PairingProvenance,
): boolean {
  if (request.source === 'tailnet') {
    return (
      existing.source === 'tailnet' &&
      existing.requester?.provider === request.requester.provider &&
      existing.requester.login === request.requester.login
    );
  }
  return (
    (request.source === 'same-origin' || request.source === 'pairing-code') &&
    existing.source === request.source &&
    existing.requester === undefined
  );
}

export class DevicePairingService {
  readonly #registryPath: string;
  #environmentId: string;
  readonly #now: () => number;
  readonly #offerTtlMs: number;
  readonly #maxActiveOffers: number;
  readonly #maxActiveCredentialsPerVerifiedIdentity: number;
  readonly #maxActiveCredentialsWithoutVerifiedIdentity: number;
  readonly #offers = new Map<string, PairingOfferState>();
  #registry: DeviceRegistry;
  #pendingLegacyScopeMigrationPersist = false;

  constructor(options: DevicePairingServiceOptions) {
    this.#registryPath = join(options.homeDir, 'security', REGISTRY_FILE);
    this.#environmentId = options.environmentId;
    this.#now = options.now ?? Date.now;
    this.#offerTtlMs = options.offerTtlMs ?? DEFAULT_OFFER_TTL_MS;
    this.#maxActiveOffers =
      options.maxActiveOffers ?? DEFAULT_MAX_ACTIVE_OFFERS;
    if (!Number.isInteger(this.#maxActiveOffers) || this.#maxActiveOffers < 1) {
      throw new Error('maxActiveOffers must be a positive integer');
    }
    this.#maxActiveCredentialsPerVerifiedIdentity =
      options.maxActiveCredentialsPerVerifiedIdentity ??
      DEFAULT_MAX_ACTIVE_CREDENTIALS_PER_VERIFIED_IDENTITY;
    if (
      !Number.isInteger(this.#maxActiveCredentialsPerVerifiedIdentity) ||
      this.#maxActiveCredentialsPerVerifiedIdentity < 1
    ) {
      throw new Error(
        'maxActiveCredentialsPerVerifiedIdentity must be a positive integer',
      );
    }
    this.#maxActiveCredentialsWithoutVerifiedIdentity =
      options.maxActiveCredentialsWithoutVerifiedIdentity ??
      DEFAULT_MAX_ACTIVE_CREDENTIALS_WITHOUT_VERIFIED_IDENTITY;
    if (
      !Number.isInteger(this.#maxActiveCredentialsWithoutVerifiedIdentity) ||
      this.#maxActiveCredentialsWithoutVerifiedIdentity < 1
    ) {
      throw new Error(
        'maxActiveCredentialsWithoutVerifiedIdentity must be a positive integer',
      );
    }
    this.#registry = this.#loadRegistry();
    // Durably migrate a pre-scoping registry (archive#1098 R4) on first load
    // rather than waiting for an unrelated mutation to persist it.
    if (this.#pendingLegacyScopeMigrationPersist) {
      this.#pendingLegacyScopeMigrationPersist = false;
      this.#persistRegistry();
    }
  }

  /**
   * @param input.scope Space-delimited {@link PairingScope} string for the
   *   grant this offer becomes. Defaults to
   *   {@link DEFAULT_GRANT_PAIRING_SCOPE} — the same-origin "current browser"
   *   continuity flow ({@link requestAccess}) never passes a narrower scope.
   *   The scoped-pairing UI (QR/manual-code flow) always passes an explicit
   *   preset scope (R3). Since archive#1398 that default is a frozen
   *   four-token constant rather than the whole vocabulary, so an unscoped
   *   offer emits the byte-identical string it always did and never picks up
   *   a newly-added scope such as `inference:invoke`.
   * @param input.kind archive#1123: `'device'` (default) or
   *   `'delegation'` — a host-side label only, never encoded into the
   *   wire {@link DevicePairingOffer} the joiner scans/types. Carried
   *   through to the exchanged {@link PairedDevice.kind} so a delegation
   *   grant is visibly distinct from an ordinary device in the same list.
   */
  createOffer(input: {
    endpoint: string;
    scope?: string;
    kind?: PairedDeviceKind;
  }): DevicePairingOffer {
    let endpoint: URL;
    try {
      endpoint = new URL(input.endpoint);
    } catch {
      throw new DevicePairingError('invalid_request');
    }
    // Station is commonly reached over plain http on a loopback, LAN, or
    // tailnet address — the deployment the mobile-connect flow exists for — so
    // cleartext is permitted for those hosts (public hostnames still require
    // https). Mirrors the Android cleartext / iOS ATS local-networking scope.
    if (endpoint.protocol !== 'https:' && !isPrivateOrLoopbackHost(endpoint)) {
      throw new DevicePairingError('invalid_request');
    }
    const scope = input.scope ?? DEFAULT_GRANT_PAIRING_SCOPE;
    if (parsePairingScope(scope) === null) {
      throw new DevicePairingError('invalid_request');
    }
    if (
      input.kind !== undefined &&
      input.kind !== 'device' &&
      input.kind !== 'delegation'
    ) {
      throw new DevicePairingError('invalid_request');
    }
    this.#pruneOffers();
    if (this.#offers.size >= this.#maxActiveOffers) {
      throw new DevicePairingError('offer_capacity_reached');
    }
    const offer: PairingOfferState = {
      protocolVersion: DEVICE_PAIRING_PROTOCOL_VERSION,
      environmentId: this.#environmentId,
      offerId: randomBytes(24).toString('base64url'),
      challenge: randomBytes(32).toString('base64url'),
      manualCode: manualCode(),
      endpoint: endpoint.origin,
      scope,
      expiresAt: this.#now() + this.#offerTtlMs,
      status: 'open',
      kind: input.kind ?? 'device',
    };
    this.#offers.set(offer.offerId, offer);
    return this.#publicOffer(offer);
  }

  /**
   * @param input.requesterPosition Where this request's submitter was, as
   *   proven by {@link isDefinitelyOffBox} at the HTTP boundary
   *   (archive#1490). Required, not defaulted: it is what
   *   {@link DevicePairingService.confirmRequest} weighs an unauthenticated
   *   approver against, so a caller that does not supply it produces a request
   *   nobody on the floor can approve — a visible failure — rather than one
   *   anybody can.
   */
  requestPairing(
    input: {
      offerId: string;
      proof: string;
      deviceName: string;
      clientInstanceId?: string;
      requesterPosition: PairingRequesterPosition;
    } & PairingProvenance,
  ): DevicePairingRequest {
    const offer = input.offerId
      ? this.#activeOffer(input.offerId)
      : this.#activeOfferForManualCode(input.proof);
    if (offer.status !== 'open')
      throw new DevicePairingError('offer_unavailable');
    const name = input.deviceName.trim();
    if (
      !name ||
      name.length > 64 ||
      (input.clientInstanceId !== undefined &&
        !CLIENT_INSTANCE_ID_PATTERN.test(input.clientInstanceId)) ||
      (input.offerId !== '' && !OFFER_ID_PATTERN.test(input.offerId)) ||
      (!equalSecret(input.proof, offer.challenge) &&
        !equalSecret(input.proof.toUpperCase(), offer.manualCode))
    ) {
      throw new DevicePairingError('invalid_request');
    }
    offer.clientInstanceId = input.clientInstanceId;
    const provenance = pairingProvenance(input);
    const request: DevicePairingRequest = {
      requestId: randomUUID(),
      offerId: offer.offerId,
      deviceName: this.#uniqueDeviceName(
        name,
        input.clientInstanceId,
        provenance,
      ),
      scope: offer.scope,
      createdAt: this.#now(),
      expiresAt: offer.expiresAt,
      ...provenance,
      status: 'pending',
    };
    offer.request = request;
    offer.requesterPosition = input.requesterPosition;
    offer.status = 'requested';
    return cloneRequest(request);
  }

  requestAccess(
    input: {
      endpoint: string;
      deviceName: string;
      clientInstanceId?: string;
      scope?: string;
      requesterPosition: PairingRequesterPosition;
    } & PairingProvenance,
  ): {
    environmentId: string;
    offerId: string;
    proof: string;
    requestId: string;
    expiresAt: number;
  } {
    const offer = this.createOffer({
      endpoint: input.endpoint,
      scope: input.scope,
    });
    try {
      const provenance = pairingProvenance({
        ...input,
        source: input.source ?? 'same-origin',
      });
      const request = this.requestPairing({
        deviceName: input.deviceName,
        clientInstanceId: input.clientInstanceId,
        offerId: offer.offerId,
        proof: offer.challenge,
        requesterPosition: input.requesterPosition,
        ...provenance,
      });
      return {
        environmentId: offer.environmentId,
        offerId: offer.offerId,
        proof: offer.challenge,
        requestId: request.requestId,
        expiresAt: offer.expiresAt,
      };
    } catch (error) {
      this.#offers.delete(offer.offerId);
      throw error;
    }
  }

  listRequests(): DevicePairingRequest[] {
    this.#pruneOffers();
    return [...this.#offers.values()]
      .filter(
        (offer) => offer.status === 'requested' || offer.status === 'confirmed',
      )
      .flatMap((offer) => (offer.request ? [cloneRequest(offer.request)] : []));
  }

  /**
   * @param approval Who is approving — see {@link PairingApproval}. Required
   *   on purpose: archive#1490 historically found an approval with no caller
   *   identity reachable before archive#2051 retired the generic loopback
   *   floor.
   */
  confirmRequest(
    requestId: string,
    approval: PairingApproval,
  ): DevicePairingRequest {
    const offer = [...this.#offers.values()].find(
      (candidate) => candidate.request?.requestId === requestId,
    );
    if (!offer) throw new DevicePairingError('request_not_found');
    this.#ensureNotExpired(offer);
    if (offer.status !== 'requested' || !offer.request) {
      throw new DevicePairingError('offer_unavailable');
    }
    // Anything that is not a verified presented credential or an equally
    // strong local-grant secret is treated as the unauthenticated floor, so a
    // future new approval kind fails closed here rather than inheriting the
    // floor's permission by omission.
    if (
      approval.kind !== 'presented-credential' &&
      approval.kind !== 'local-grant' &&
      approval.kind !== 'ui-bootstrap' &&
      !unauthenticatedApprovalAllowed(offer)
    ) {
      throw new DevicePairingError('approval_requires_operator');
    }
    offer.status = 'confirmed';
    offer.request.status = 'confirmed';
    return cloneRequest(offer.request);
  }

  denyRequest(requestId: string): DevicePairingRequest {
    const offer = [...this.#offers.values()].find(
      (candidate) => candidate.request?.requestId === requestId,
    );
    if (!offer) throw new DevicePairingError('request_not_found');
    this.#ensureNotExpired(offer);
    if (
      (offer.status !== 'requested' && offer.status !== 'confirmed') ||
      !offer.request
    ) {
      throw new DevicePairingError('offer_unavailable');
    }
    offer.status = 'cancelled';
    offer.request.status = 'denied';
    return cloneRequest(offer.request);
  }

  exchange(input: {
    offerId: string;
    proof: string;
    requestId: string;
    clientInstanceId?: string;
    /**
     * Server-only mint stamp. Written solely by the local-grant route and
     * by a UI-bootstrap exchange that was direct loopback with no proxy
     * attestation. Access-request, pairing-code, tailnet, and operator
     * paths must omit it.
     */
    locality?: 'home-possession';
    /** Server-only mint stamp — see StoredDevice.mintKind. */
    mintKind?: 'local-grant' | 'ui-bootstrap';
  }): {
    environmentId: string;
    device: PairedDevice;
    credential: string;
    replacement: 'none' | 'superseded';
  } {
    const offer = this.#activeOffer(input.offerId);
    if (
      offer.status === 'cancelled' &&
      offer.request?.requestId === input.requestId &&
      offer.request.status === 'denied'
    ) {
      throw new DevicePairingError('request_denied');
    }
    if (
      offer.status !== 'confirmed' ||
      offer.request?.requestId !== input.requestId
    ) {
      throw new DevicePairingError('request_not_confirmed');
    }
    // The status/request-id guard above establishes this, but retain the
    // explicit fail-closed guard when binding it locally for all later
    // exchange decisions.
    const request = offer.request;
    if (!request) throw new DevicePairingError('request_not_confirmed');
    const requestProvenance = pairingProvenance(request);
    if (
      !equalSecret(input.proof, offer.challenge) &&
      !equalSecret(input.proof.toUpperCase(), offer.manualCode)
    ) {
      throw new DevicePairingError('invalid_request');
    }
    // R1 invariant: the session (device) scope can never exceed the grant
    // (offer) scope it was exchanged from. Today the two are always equal by
    // construction (the line below copies offer.scope verbatim), but this
    // stays an explicit, tested check rather than a silent assumption so a
    // future narrower-session exchange cannot regress it unnoticed.
    if (!isPairingScopeSubset(offer.scope, offer.scope)) {
      throw new DevicePairingError('invalid_request');
    }
    if (
      input.clientInstanceId !== undefined &&
      !CLIENT_INSTANCE_ID_PATTERN.test(input.clientInstanceId)
    ) {
      throw new DevicePairingError('invalid_request');
    }
    if (input.clientInstanceId !== offer.clientInstanceId) {
      throw new DevicePairingError('invalid_request');
    }
    const credential = randomBytes(32).toString('base64url');
    const nextRegistry = cloneRegistry(this.#registry);
    const replacement = input.clientInstanceId
      ? nextRegistry.devices.some(
          (item) =>
            item.revokedAt === null &&
            item.clientInstanceId === input.clientInstanceId &&
            isSameReplacementDomain(item, requestProvenance),
        )
      : false;
    if (input.clientInstanceId) {
      const revokedAt = this.#now();
      for (const item of nextRegistry.devices) {
        if (
          item.revokedAt === null &&
          item.clientInstanceId === input.clientInstanceId &&
          isSameReplacementDomain(item, requestProvenance)
        ) {
          item.revokedAt = revokedAt;
          item.revocation = {
            state: 'recorded',
            actor: 'same-client-replacement',
            reason: 'same-client-replacement',
          };
          item.pushSubscription = null;
        }
      }
    }
    // `requester` is recorded only when the ingress identity source proved it
    // (tailnet WhoIs today). Do not derive an identity from a self-declared
    // client name/instance id or source address: that would turn an unknown
    // caller into a plausible principal. The request layer separately bounds
    // those unclassified exchanges before parsing (archive#2001).
    if (request.source === 'tailnet') {
      const activeForRequester = nextRegistry.devices.filter(
        (item) =>
          item.revokedAt === null &&
          item.source === 'tailnet' &&
          item.requester?.provider === request.requester.provider &&
          item.requester.login === request.requester.login,
      );
      if (
        activeForRequester.length >=
        this.#maxActiveCredentialsPerVerifiedIdentity
      ) {
        // The only mutations above are on the private clone. Leaving the
        // confirmed offer usable after refusal lets a subsequent deliberate
        // revocation/re-pair retry without creating a half-replacement.
        throw new DevicePairingError('identity_credential_quota_reached');
      }
    } else {
      const activeWithoutVerifiedIdentity = nextRegistry.devices.filter(
        (item) =>
          item.revokedAt === null &&
          (item.source !== 'tailnet' || item.requester === undefined),
      );
      if (
        activeWithoutVerifiedIdentity.length >=
        this.#maxActiveCredentialsWithoutVerifiedIdentity
      ) {
        throw new DevicePairingError('unattributed_credential_quota_reached');
      }
    }
    const issuedAt = this.#now();
    const device: StoredDevice = {
      id: randomUUID(),
      name: request.deviceName,
      scope: offer.scope,
      kind: offer.kind,
      createdAt: issuedAt,
      activityTracking: 'tracked-since-issued',
      lastSeenFrom: null,
      usageCount: 0,
      lastActiveDay: null,
      revokedAt: null,
      revocation: { state: 'not-revoked' },
      credentialHash: digest(credential).toString('base64url'),
      issuedAt,
      ...(input.clientInstanceId
        ? { clientInstanceId: input.clientInstanceId }
        : {}),
      pushSubscription: null,
      // archive#1878: carry the pairing request's own provenance
      // onto the durable record instead of discarding it after the approval
      // decision — the same `source`/`requester` `confirmRequest` already
      // weighed. No clientClass field: nothing between here and the wire
      // request carries a truthful signal for the client's platform, and a
      // guessed one would be worse than an absent one.
      source: request.source,
      ...(request.source === 'tailnet'
        ? { requester: { ...request.requester } }
        : {}),
      ...(input.locality === 'home-possession'
        ? { locality: 'home-possession' as const }
        : {}),
      // Recorded only alongside a proven home-possession locality — a mint
      // kind without the possession proof would be a label with no
      // derivation behind it.
      ...(input.locality === 'home-possession' && input.mintKind
        ? { mintKind: input.mintKind }
        : {}),
    };
    nextRegistry.devices.push(device);
    // Persist the complete replacement before exposing it in memory: a write
    // fault therefore leaves neither an in-memory nor an on-disk half
    // supersession (old active grant revoked without its replacement).
    this.#persistRegistry(nextRegistry);
    this.#registry = nextRegistry;
    offer.status = 'used';
    return {
      environmentId: this.#environmentId,
      device: publicDevice(device),
      credential,
      replacement: replacement ? 'superseded' : 'none',
    };
  }

  cancelOffer(offerId: string): void {
    const offer = this.#offers.get(offerId);
    if (!offer) throw new DevicePairingError('invalid_offer');
    offer.status = 'cancelled';
  }

  /** Remove a server-owned offer that must never be resumed by a caller. */
  discardOffer(offerId: string): void {
    this.#offers.delete(offerId);
  }

  listDevices(): PairedDevice[] {
    return this.#registry.devices.map(publicDevice);
  }

  /** Stable environment identifier for an already-authenticated UI session. */
  environmentId(): string {
    return this.#environmentId;
  }

  revokeDevice(deviceId: string, actor: DeviceRevocationActor): PairedDevice {
    const nextRegistry = cloneRegistry(this.#registry);
    const device = nextRegistry.devices.find((item) => item.id === deviceId);
    if (!device) throw new DevicePairingError('device_not_found');
    if (device.revokedAt === null) {
      device.revokedAt = this.#now();
      device.revocation = {
        state: 'recorded',
        actor,
        reason: 'owner-request',
      };
      // Revocation explicitly severs push, not just credential lookup — a
      // subscription must never survive its device record.
      device.pushSubscription = null;
      this.#persistRegistry(nextRegistry);
      this.#registry = nextRegistry;
    }
    return publicDevice(device);
  }

  /**
   * Removes only a revoked tombstone. The active-credential path is
   * deliberately separate: deleting a live row must never become a hidden
   * alternative to explicit revocation.
   */
  removeRevokedDevice(
    deviceId: string,
    actor: DeviceRevocationActor,
  ): PairedDevice {
    if (actor !== 'operator-credential') {
      throw new DevicePairingError('approval_requires_operator');
    }
    const device = this.#registry.devices.find((item) => item.id === deviceId);
    if (!device) throw new DevicePairingError('device_not_found');
    if (device.revokedAt === null)
      throw new DevicePairingError('device_active');
    const nextRegistry: DeviceRegistry = {
      ...this.#registry,
      devices: this.#registry.devices.filter((item) => item.id !== deviceId),
    };
    this.#persistRegistry(nextRegistry);
    this.#registry = nextRegistry;
    return publicDevice(device);
  }

  /**
   * Grants or removes {@link PAIRING_SCOPE_ACCESS_APPROVE} on an
   * ALREADY-PAIRED device (archive#1887).
   *
   * This is the sole grant path for that token — it is in no preset and never
   * in the default grant. Elevation at pairing time would grant approval
   * authority to the least-known party at the moment it is least known, which
   * is the conversion archive#1490 analysed; promotion is a separate,
   * deliberate act against a device the operator has already accepted.
   *
   * **The authority check lives here, not at the route.** Runtime
   * authentication rejects bare loopback and SSH callers before
   * `/api/pairing/**`; this service remains the defense in depth for internal
   * callers. `unauthenticated` is refused with **no** off-box
   * exception: unlike approving a request, promotion carries no "the subject
   * is provably elsewhere" mitigating fact.
   *
   * Revoked devices cannot be promoted — a revoked record is a tombstone, and
   * re-granting authority on one would resurrect it without a fresh pairing.
   */
  /**
   * Sets a paired device's scope (archive#3816).
   *
   * A device's access level was fixed at pairing time: the only mutation was
   * revoking the whole device, so narrowing a phone from Standard to
   * Read-only meant unpairing it and starting over — which pushes people to
   * grant MORE than they need at pairing time, because the alternative is
   * losing the device's identity and history. It also left
   * `operator-promotion` — a grant path the contracts declare for
   * `access:approve` and `consent:decide` — with no mechanism at all.
   *
   * What it refuses, and why:
   *  - a revoked device: its scope is not a live question.
   *  - an unknown token: the vocabulary is closed.
   *  - a token whose ONLY declared grant path is `default-grant`
   *    (`access:manage`): that population is inherited by migrated,
   *    scope-omitting, and continuity-flow credentials and is permanently
   *    ambiguous. Granting it deliberately here would widen exactly the set
   *    the contracts warn must not grow — a promotion path for it was never
   *    intended to exist, so this refuses rather than quietly offering one.
   *
   * The scope is re-serialised through the vocabulary order so the stored
   * string stays canonical rather than recording the caller's spelling.
   */
  setDeviceScope(
    deviceId: string,
    scope: readonly PairingScope[],
    approval: PairingApproval,
    /**
     * The scope the caller believes the device currently has (archive#3816
     * review). A scope edit submits a COMPLETE replacement, so without this
     * two operators racing silently overwrite each other's security
     * decisions: B opens an editor showing `consent:decide`, A removes it,
     * B adds something unrelated and applies — re-granting what A just took
     * away, with no signal to either of them. Optional so existing callers
     * are unaffected; supplied, it makes the write conditional.
     */
    expectedScope?: string,
  ): PairedDevice {
    if (
      approval.kind !== 'presented-credential' &&
      approval.kind !== 'local-grant'
    ) {
      throw new DevicePairingError('approval_requires_operator');
    }
    for (const token of scope) {
      if (!PAIRING_SCOPES.includes(token)) {
        throw new DevicePairingError('invalid_scope');
      }
      const paths = PAIRING_SCOPE_GRANT_PATHS[token] ?? [];
      if (paths.length === 1 && paths[0] === 'default-grant') {
        throw new DevicePairingError('scope_not_grantable');
      }
    }
    const nextRegistry = cloneRegistry(this.#registry);
    const device = nextRegistry.devices.find((item) => item.id === deviceId);
    if (!device) throw new DevicePairingError('device_not_found');
    if (device.revokedAt !== null) {
      throw new DevicePairingError('device_revoked');
    }
    if (expectedScope !== undefined && device.scope !== expectedScope) {
      throw new DevicePairingError('scope_changed');
    }
    const next = PAIRING_SCOPES.filter((token) => scope.includes(token));
    if (next.length === 0) throw new DevicePairingError('invalid_scope');
    const canonical = next.join(' ');
    if (device.scope === canonical) return publicDevice(device);
    device.scope = canonical;
    // Persisted before it is exposed in memory, for the same reason the
    // approval-authority setter does it: a write fault must not leave a
    // device narrowed in this process and wide open on disk, where a restart
    // silently restores what the operator just took away.
    this.#persistRegistry(nextRegistry);
    this.#registry = nextRegistry;
    return publicDevice(device);
  }

  setDeviceApprovalAuthority(
    deviceId: string,
    granted: boolean,
    approval: PairingApproval,
  ): PairedDevice {
    if (
      approval.kind !== 'presented-credential' &&
      approval.kind !== 'local-grant'
    ) {
      throw new DevicePairingError('approval_requires_operator');
    }
    const nextRegistry = cloneRegistry(this.#registry);
    const device = nextRegistry.devices.find((item) => item.id === deviceId);
    if (!device) throw new DevicePairingError('device_not_found');
    if (device.revokedAt !== null) {
      throw new DevicePairingError('device_revoked');
    }
    const current = parsePairingScope(device.scope) ?? [];
    const hasToken = current.includes(PAIRING_SCOPE_ACCESS_APPROVE);
    if (hasToken === granted) return publicDevice(device);
    const next = granted
      ? [...current, PAIRING_SCOPE_ACCESS_APPROVE]
      : current.filter((scope) => scope !== PAIRING_SCOPE_ACCESS_APPROVE);
    // Re-serialised through the vocabulary order so the stored string stays
    // canonical rather than accumulating append order.
    device.scope = PAIRING_SCOPES.filter((scope) => next.includes(scope)).join(
      ' ',
    );
    // Persist the authority change before exposing it in memory (archive#3324): a
    // write fault must not leave approval authority granted in this process
    // and absent on disk, where a restart would silently withdraw it.
    this.#persistRegistry(nextRegistry);
    this.#registry = nextRegistry;
    return publicDevice(device);
  }

  /**
   * True when this credential belongs to a live device carrying
   * {@link PAIRING_SCOPE_ACCESS_APPROVE} (archive#1887). Consulted by
   * `authorizeCredential` to admit exactly the three pending-request leaves,
   * and nothing else in the `/api/pairing` family.
   */
  credentialMayApprovePairing(candidate: string): boolean {
    const device = this.identifyDevice(candidate);
    if (!device) return false;
    return (parsePairingScope(device.scope) ?? []).includes(
      PAIRING_SCOPE_ACCESS_APPROVE,
    );
  }

  /**
   * Sets (replaces) the Web Push subscription on a paired device. Callers
   * must resolve the caller's own device via {@link identifyDevice} first —
   * this method trusts the deviceId it is given.
   */
  setPushSubscription(
    deviceId: string,
    subscription: WebPushSubscription,
  ): PairedDevice {
    const nextRegistry = cloneRegistry(this.#registry);
    const device = nextRegistry.devices.find((item) => item.id === deviceId);
    if (!device) throw new DevicePairingError('device_not_found');
    device.pushSubscription = subscription;
    // Persist before exposing (archive#3324): a subscription live in memory but
    // absent on disk stops receiving pushes at the next restart, with no
    // signal to the device that registered it.
    this.#persistRegistry(nextRegistry);
    this.#registry = nextRegistry;
    return publicDevice(device);
  }

  /** Idempotent: clearing an already-cleared subscription is a no-op write. */
  clearPushSubscription(deviceId: string): PairedDevice {
    const nextRegistry = cloneRegistry(this.#registry);
    const device = nextRegistry.devices.find((item) => item.id === deviceId);
    if (!device) throw new DevicePairingError('device_not_found');
    if (device.pushSubscription === null) return publicDevice(device);
    device.pushSubscription = null;
    // Persist before exposing (archive#3324). This direction is the one revocation
    // depends on — "a subscription must never survive its device record" is
    // only as durable as this write.
    this.#persistRegistry(nextRegistry);
    this.#registry = nextRegistry;
    return publicDevice(device);
  }

  /** Fan-out source for the Web Push sender — active devices only. */
  listPushSubscriptions(): Array<{
    deviceId: string;
    subscription: WebPushSubscription;
  }> {
    const results: Array<{
      deviceId: string;
      subscription: WebPushSubscription;
    }> = [];
    for (const device of this.#registry.devices) {
      if (device.revokedAt === null && device.pushSubscription !== null) {
        results.push({
          deviceId: device.id,
          subscription: device.pushSubscription,
        });
      }
    }
    return results;
  }

  resetEnvironment(environmentId: string): void {
    const nextRegistry: DeviceRegistry = {
      schemaVersion: REGISTRY_SCHEMA_VERSION,
      environmentId,
      devices: [],
    };
    // Persist the emptied registry before adopting it (archive#3324). A failed write
    // here used to leave the process with no devices while every credential
    // stayed valid on disk — a reset that reports success and un-resets on
    // restart. Offers are in-memory only, so they are cleared after the
    // durable write succeeds.
    this.#persistRegistry(nextRegistry);
    this.#environmentId = environmentId;
    this.#registry = nextRegistry;
    this.#offers.clear();
  }

  verifyCredential(candidate: string): boolean {
    return this.#resolveActiveDevice(candidate) !== undefined;
  }

  /**
   * Records one successful HTTP credential use. The caller supplies only a
   * server-derived coarse peer class; unknown/public peers remain absent
   * rather than being converted into a plausible LAN or tailnet claim.
   *
   * This deliberately writes each counted request. The value is described as
   * a durable request count, so sampling or a deferred best-effort flush
   * would make it false after a restart.
   */
  recordCredentialActivity(
    candidate: string,
    lastSeenFrom?: Exclude<PairedDevice['lastSeenFrom'], null>,
  ): boolean {
    const nextRegistry = cloneRegistry(this.#registry);
    const device = this.#findActiveDevice(nextRegistry, candidate);
    if (!device) return false;
    const now = this.#now();
    device.lastUsedAt = now;
    if (device.activityTracking === 'tracked-since-issued') {
      device.usageCount = (device.usageCount ?? 0) + 1;
    }
    device.lastActiveDay = new Date(now).toISOString().slice(0, 10);
    device.lastSeenFrom = lastSeenFrom ?? null;
    this.#persistRegistry(nextRegistry);
    this.#registry = nextRegistry;
    return true;
  }

  /**
   * Identifies the paired device a credential belongs to, sharing the same
   * timing-safe lookup as {@link verifyCredential} so this primitive never
   * becomes an oracle distinguishable from a plain boolean check.
   */
  identifyDevice(candidate: string): PairedDevice | null {
    const device = this.#resolveActiveDevice(candidate);
    return device ? publicDevice(device) : null;
  }

  /**
   * Mint-time home-possession stamp, if this credential's issuance proved
   * possession of the Station home. Timing-safe lookup; does not bump
   * lastUsedAt (verifyCredential / identifyDevice already do on the auth
   * path). Never reads pairing `source` or network position.
   */
  credentialLocality(candidate: string): 'home-possession' | undefined {
    const device = this.#findActiveDevice(this.#registry, candidate);
    return device?.locality === 'home-possession'
      ? 'home-possession'
      : undefined;
  }

  /**
   * Mint-KIND lookup for a home-possession credential (archive#3677 PR 3).
   * Returns a kind only when the possession proof is also present — a
   * pre-#3677 record has neither field and reads `undefined`, which every
   * consumer must treat as "not local-grant" (fail closed).
   */
  credentialMintKind(
    candidate: string,
  ): 'local-grant' | 'ui-bootstrap' | undefined {
    const device = this.#findActiveDevice(this.#registry, candidate);
    return device?.locality === 'home-possession' ? device.mintKind : undefined;
  }

  /**
   * Timing-safe credential -> active (non-revoked) device lookup, shared by
   * verifyCredential and identifyDevice. Touches lastUsedAt at the same
   * bounded write cadence either primitive is called through.
   */
  #resolveActiveDevice(
    candidate: string,
    touchLastUsed = true,
  ): StoredDevice | undefined {
    const device = this.#findActiveDevice(this.#registry, candidate);
    if (!device) return undefined;
    const now = this.#now();
    if (
      touchLastUsed &&
      (device.lastUsedAt == null ||
        now - device.lastUsedAt >= LAST_USED_WRITE_INTERVAL_MS)
    ) {
      // This is a bookkeeping write on a READ path (archive#3324): the callers are
      // verifyCredential and identifyDevice, whose contract is to answer a
      // question about a credential. Two deliberate choices follow.
      //
      // It persists before mutating memory, like every other write here, so
      // a failed write cannot leave a lastUsedAt that only this process
      // believes. And it swallows the failure rather than propagating it,
      // because these callers have no way to report one: the request-less
      // paths (terminal and voice WebSocket authorisation, scope resolution)
      // would turn a transiently unwritable registry — antivirus, backup, a
      // full disk — into a refused connection over a stale timestamp.
      //
      // Scope, precisely: this does NOT make authenticated HTTP fault-
      // tolerant. That path always supplies `activity`, so it authorises
      // through recordCredentialActivity, whose durable per-request write
      // deliberately propagates. The swallow covers the callers that reach
      // this touch directly, and nothing more.
      //
      // Two disclosed costs. The failure is silent: this service has no
      // logger seam, so a persistently unwritable home degrades lastUsedAt
      // with no signal anywhere (archive#3324). And because the failed write
      // leaves the in-memory timestamp stale, the cadence gate stays open, so
      // retries happen per call rather than once per interval — self-healing
      // for a transient fault, unbounded re-attempts under a lasting one.
      const nextRegistry = cloneRegistry(this.#registry);
      const pending = this.#findActiveDevice(nextRegistry, candidate);
      if (pending) {
        pending.lastUsedAt = now;
        try {
          this.#persistRegistry(nextRegistry);
          this.#registry = nextRegistry;
          return pending;
        } catch {
          // Keep serving from the unmutated registry; the next call retries.
        }
      }
    }
    return device;
  }

  /**
   * Suffixes a requested device name ("Mac · Chrome" -> "Mac · Chrome (2)")
   * when it collides with either an existing active paired device's name or
   * another still-pending/confirmed request's name, so the approver and the
   * paired-device list never show two indistinguishable entries — including
   * two concurrent pending requests that haven't become devices yet (e.g.
   * two identical phones, or a same-origin/pairing-code request copying a
   * legitimate pending request's label since those sources carry no
   * requester identity to disambiguate them). Revoked devices, expired
   * offers, and denied/cancelled/already-exchanged offers don't reserve
   * their name.
   */
  #findActiveDevice(
    registry: DeviceRegistry,
    candidate: string,
  ): StoredDevice | undefined {
    const candidateHash = digest(candidate);
    return registry.devices.find(
      (item) =>
        item.revokedAt === null &&
        timingSafeEqual(
          candidateHash,
          Buffer.from(item.credentialHash, 'base64url'),
        ),
    );
  }

  #uniqueDeviceName(
    name: string,
    clientInstanceId?: string,
    provenance?: PairingProvenance,
  ): string {
    const existingNames = new Set(
      this.#registry.devices
        .filter(
          (device) =>
            device.revokedAt === null &&
            (!clientInstanceId ||
              !provenance ||
              device.clientInstanceId !== clientInstanceId ||
              !isSameReplacementDomain(device, provenance)),
        )
        .map((device) => device.name),
    );
    const now = this.#now();
    for (const offer of this.#offers.values()) {
      if (offer.expiresAt <= now) continue;
      if (offer.status !== 'requested' && offer.status !== 'confirmed') {
        continue;
      }
      if (
        offer.request &&
        (!clientInstanceId ||
          !provenance ||
          offer.clientInstanceId !== clientInstanceId ||
          !isSameReplacementDomain(offer.request, provenance))
      ) {
        existingNames.add(offer.request.deviceName);
      }
    }
    if (!existingNames.has(name)) return name;
    const maxLength = 64;
    for (let suffix = 2; suffix < 1000; suffix += 1) {
      const suffixText = ` (${suffix})`;
      const base =
        name.length + suffixText.length > maxLength
          ? truncateToCodeUnits(name, maxLength - suffixText.length)
          : name;
      const candidate = `${base}${suffixText}`;
      if (!existingNames.has(candidate)) return candidate;
    }
    return name;
  }

  #activeOffer(offerId: string): PairingOfferState {
    const offer = this.#offers.get(offerId);
    if (!offer) throw new DevicePairingError('invalid_offer');
    this.#ensureNotExpired(offer);
    return offer;
  }

  #activeOfferForManualCode(proof: string): PairingOfferState {
    this.#pruneOffers();
    const normalized = proof.toUpperCase();
    const offer = [...this.#offers.values()].find(
      (candidate) =>
        candidate.status === 'open' &&
        equalSecret(normalized, candidate.manualCode),
    );
    if (!offer) throw new DevicePairingError('invalid_offer');
    return offer;
  }

  #ensureNotExpired(offer: PairingOfferState): void {
    if (offer.expiresAt <= this.#now()) {
      this.#offers.delete(offer.offerId);
      throw new DevicePairingError('offer_expired');
    }
  }

  #pruneOffers(): void {
    for (const offer of this.#offers.values()) {
      if (offer.expiresAt <= this.#now()) this.#offers.delete(offer.offerId);
    }
  }

  #publicOffer(offer: PairingOfferState): DevicePairingOffer {
    // `kind` is a host-side label — never part of the wire DevicePairingOffer
    // a joiner scans/types (archive#1123).
    const {
      status: _status,
      request: _request,
      kind: _kind,
      clientInstanceId: _clientInstanceId,
      ...safe
    } = offer;
    return safe;
  }

  #loadRegistry(): DeviceRegistry {
    if (!existsSync(this.#registryPath)) {
      return {
        schemaVersion: REGISTRY_SCHEMA_VERSION,
        environmentId: this.#environmentId,
        devices: [],
      };
    }
    const status = lstatSync(this.#registryPath);
    if (
      !status.isFile() ||
      status.isSymbolicLink() ||
      status.nlink !== 1 ||
      (process.platform !== 'win32' &&
        (status.mode & 0o777) !== PRIVATE_FILE_MODE)
    ) {
      throw new Error('Unsafe paired-device registry');
    }
    const parsed: unknown = JSON.parse(
      readFileSync(this.#registryPath, 'utf8'),
    );
    const registry = validateRegistry(parsed, this.#environmentId);
    const rawDevices = Array.isArray((parsed as { devices?: unknown })?.devices)
      ? ((parsed as { devices: Array<{ scope?: unknown }> }).devices ?? [])
      : [];
    // validateRegistry maps devices 1:1 without reordering, so index-aligned
    // comparison against the pre-migration raw scope is safe here.
    this.#pendingLegacyScopeMigrationPersist =
      (parsed as { schemaVersion?: unknown }).schemaVersion ===
        PRE_ACTIVITY_REGISTRY_SCHEMA_VERSION ||
      rawDevices.some((device) => device.scope === DEVICE_PAIRING_SCOPE);
    return registry;
  }

  #persistRegistry(registry: DeviceRegistry = this.#registry): void {
    const temporaryPath = join(
      dirname(this.#registryPath),
      `.${REGISTRY_FILE}.${process.pid}.${randomUUID()}.tmp`,
    );
    let descriptor: number | undefined;
    try {
      descriptor = openSync(
        temporaryPath,
        constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
        PRIVATE_FILE_MODE,
      );
      if (process.platform !== 'win32')
        fchmodSync(descriptor, PRIVATE_FILE_MODE);
      writeFileSync(descriptor, `${JSON.stringify(registry)}\n`, 'utf8');
      fsyncSync(descriptor);
      closeSync(descriptor);
      descriptor = undefined;
      renameSync(temporaryPath, this.#registryPath);
    } finally {
      if (descriptor !== undefined) closeSync(descriptor);
      rmSync(temporaryPath, { force: true });
    }
  }
}
