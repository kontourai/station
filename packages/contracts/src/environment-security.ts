export const ENVIRONMENT_SECURITY_SCHEMA_VERSION = 1 as const;
export const PUBLIC_HANDSHAKE_SCHEMA_VERSION = 1 as const;
export const REMOTE_AUTH_PROTOCOL_VERSION = 1 as const;
export const PUBLIC_STATION_HANDSHAKE_PATH = '/.well-known/station/v1' as const;
export const PUBLIC_STATION_PROOF_PATH =
  '/.well-known/station/v1/proof' as const;
export const STATION_PROOF_PROTOCOL_VERSION = 1 as const;
export const STATION_PROOF_DOMAIN = 'station-environment-proof' as const;
export const DEVICE_PAIRING_PROTOCOL_VERSION = 1 as const;
/**
 * Pre-scoped pairing marker (archive#1098). Every device paired before
 * this feature shipped persisted exactly this literal in its `scope` field.
 * It is never issued to a new grant — {@link DEFAULT_GRANT_PAIRING_SCOPE} is
 * issued instead — but it is still recognized on read so an existing
 * paired-device registry migrates to the default grant in place rather than
 * forcing a re-pair (R4/AC3). See `DevicePairingService`'s registry loader.
 */
export const DEVICE_PAIRING_SCOPE = 'station:interactive' as const;
export const DEVICE_PAIRING_BROWSER_COOKIE_DELIVERY = 'browser-cookie' as const;
export const PUBLIC_DEVICE_PAIRING_REQUEST_PATH =
  '/.well-known/station/v1/pairing/request' as const;
export const PUBLIC_DEVICE_PAIRING_ACCESS_REQUEST_PATH =
  '/.well-known/station/v1/pairing/access-request' as const;
export const PUBLIC_DEVICE_PAIRING_EXCHANGE_PATH =
  '/.well-known/station/v1/pairing/exchange' as const;
/**
 * Same-user local self-authorization (archive#1715). Exchanges a per-boot,
 * owner-only-file grant secret (`<home>/runtime/local-grant.secret`, minted
 * fresh on every server boot) for a normal paired-device credential, by
 * running the ordinary offer/request/confirm/exchange ceremony server-side in
 * one request. It is reachable ONLY as a direct loopback call — never through
 * Station's own UI proxy, a Tailscale Serve tunnel, or any other forwarded
 * path — because possession of the secret file (readable only by the OS user
 * that owns the Station home) is the entire proof of authority. See
 * `configureDevicePairingPublicRoutes` in `runtime-routes.ts` for the
 * boundary and the threat-model note next to the route.
 */
export const PUBLIC_DEVICE_PAIRING_LOCAL_GRANT_PATH =
  '/.well-known/station/v1/pairing/local-grant' as const;
/**
 * A launcher-issued, single-use capability carried in a local Station UI URL
 * fragment. The browser exchanges it for the ordinary HttpOnly device-session
 * cookie; the capability itself is never sent as an Authorization header and
 * is not a transport-position exception.
 */
export const PUBLIC_DEVICE_PAIRING_UI_BOOTSTRAP_PATH =
  '/.well-known/station/v1/pairing/ui-bootstrap' as const;

/**
 * Refreshes the single current launcher UI-bootstrap capability (archive#1991).
 * It is reachable only by a direct-loopback caller that proves possession of
 * the per-boot local-grant secret. A later mint replaces an unspent token, so
 * only the most recently minted browser fragment can be exchanged.
 */
export const PUBLIC_DEVICE_PAIRING_UI_BOOTSTRAP_MINT_PATH =
  '/.well-known/station/v1/pairing/mint-ui-bootstrap' as const;

/**
 * Scoped pairing (archive#1098): OAuth-style space-delimited scope strings on
 * pairing grants and the device sessions/credentials exchanged from them. A
 * leaked read-only credential can read and stream state but must 403 on
 * every mutation and every terminal route — enforced by the single
 * route-scope table in `src-server/security/pairing-route-scopes.ts`.
 *
 * This started as a deliberately small four-scope set, not a general
 * permission system — see the issue's non-goals (no DPoP, no OAuth server,
 * no relay scopes). {@link PAIRING_SCOPE_INFERENCE_INVOKE} was added as a
 * fifth under the same restraint: it exists
 * because "let my laptop use my workstation's GPU" must not be expressible
 * only as "let my laptop run agents on my workstation".
 */
export const PAIRING_SCOPE_ORCHESTRATION_READ = 'orchestration:read' as const;
export const PAIRING_SCOPE_ORCHESTRATION_OPERATE =
  'orchestration:operate' as const;
export const PAIRING_SCOPE_TERMINAL_OPERATE = 'terminal:operate' as const;
/** Pairing/device management (creating offers, confirming/denying requests, revoking devices). */
export const PAIRING_SCOPE_ACCESS_MANAGE = 'access:manage' as const;
/**
 * Fleet inference (archive#1398, `docs/design/inference-fleet.md` §3.3):
 * invoke a *model completion* on this Station's contributed connections, and
 * read which models it contributes. Deliberately NOT `orchestration:operate`:
 * that scope authorizes starting arbitrary agent sessions and driving turns
 * here, and borrowing a GPU must not imply running agents.
 *
 * The scope buys exactly the `/api/inference/**` family and the
 * `GET /api/connections/model-inventory` leaf (§10 OQ-2) — completions only,
 * never `delegate_task`, no tools, no filesystem, no session creation
 * (§3.2). It is granted **only** through {@link PAIRING_SCOPE_PRESETS}'s
 * `inference` preset or an explicit scope string; it is NOT in
 * {@link DEFAULT_GRANT_PAIRING_SCOPE}, so no existing credential gains it by
 * upgrading this build.
 */
export const PAIRING_SCOPE_INFERENCE_INVOKE = 'inference:invoke' as const;

/**
 * Approve or deny a PENDING pairing request, and read the pending list
 * (archive#1887). Exactly `GET /api/pairing/requests`,
 * `POST /api/pairing/requests/:id/confirm`, `DELETE /api/pairing/requests/:id`
 * — and nothing else in the `/api/pairing` family.
 *
 * It is deliberately NOT {@link PAIRING_SCOPE_ACCESS_MANAGE}, for two
 * independent reasons:
 *
 *  1. `access:manage` is *dead* for pairing. `authorizeCredential` refuses
 *     every paired-device credential on `/api/pairing/**` before the scope
 *     table is consulted, so a grant carrying it would still 403 — adding it
 *     to a preset fixes nothing.
 *  2. Its holder population is permanently ambiguous: it is inherited through
 *     {@link DEFAULT_GRANT_PAIRING_SCOPE} by migrated, scope-omitting, and
 *     continuity-flow credentials, never chosen. Honouring it here would
 *     elevate all of them at once. A new token is the only way "every holder
 *     chose this" can be true.
 *
 * It is granted ONLY by an operator promoting an already-paired device — see
 * {@link PAIRING_SCOPE_GRANT_PATHS}. It is in no preset and never in the
 * default grant: pairing time is when a device is least known, and offering
 * approval authority there grants the most to the least-known party.
 */
export const PAIRING_SCOPE_ACCESS_APPROVE = 'access:approve' as const;

/**
 * Decide (approve or deny) a pending {@link ConsentTransaction} on the
 * distinct-origin consent surface (archive#3677). The decision endpoint lives
 * on the dedicated consent listener — a separate port whose origin same-origin
 * plugin code cannot script — never on the main runtime app.
 *
 * Like {@link PAIRING_SCOPE_ACCESS_APPROVE}, it is deliberately NOT
 * {@link PAIRING_SCOPE_ACCESS_MANAGE} and NOT in the default grant:
 * `access:manage`'s holder population is permanently ambiguous (inherited by
 * migrated, scope-omitting, and continuity-flow credentials), and consent
 * authority must revoke independently of device management. It is in no
 * preset — pairing time is when a device is least known — and it is granted
 * ONLY by an operator promoting an already-paired device.
 *
 * The operator/local principal does not obtain this token through a scope
 * string at all: the operator bootstrap credential resolves to the frozen
 * {@link DEFAULT_GRANT_PAIRING_SCOPE} (which must never grow), so the consent
 * listener authorizes the operator by credential identity
 * (`verifyOperatorCredential`) — a derivation, not a scope-label — exactly the
 * `access:approve` enforcement precedent.
 */
export const PAIRING_SCOPE_CONSENT_DECIDE = 'consent:decide' as const;

export const PAIRING_SCOPES = [
  PAIRING_SCOPE_ORCHESTRATION_READ,
  PAIRING_SCOPE_ORCHESTRATION_OPERATE,
  PAIRING_SCOPE_TERMINAL_OPERATE,
  PAIRING_SCOPE_ACCESS_MANAGE,
  PAIRING_SCOPE_INFERENCE_INVOKE,
  PAIRING_SCOPE_ACCESS_APPROVE,
  PAIRING_SCOPE_CONSENT_DECIDE,
] as const;

export type PairingScope = (typeof PAIRING_SCOPES)[number];

/**
 * The scope string issued to a grant that omits an explicit scope
 * (back-compat default), to every credential migrated from a pre-scoping
 * registry (see {@link DEVICE_PAIRING_SCOPE}), and — treated as carrying it
 * rather than stored — to the Station operator bootstrap credential, which
 * predates scoping and has always had full authority.
 *
 * **This is a curated constant, not `PAIRING_SCOPES.join(' ')`, and the
 * difference is the whole point**
 * (`docs/design/inference-fleet.md` §11). While the two happened to be equal,
 * every vocabulary addition silently did two harmful things at once:
 *
 *  1. it granted the new scope to all three populations above, none of whom
 *     asked for it — an implicit widening of live credentials on upgrade; and
 *  2. it changed the *bytes* every one of those grants carries, and
 *     {@link parsePairingScope} rejects an unknown token by returning `null`
 *     for the WHOLE string, so every peer predating the addition would refuse
 *     the grant outright rather than degrade.
 *
 * Decoupling removes both. These four tokens are frozen as the historical
 * default grant; the string is byte-identical to what shipped before
 * `inference:invoke` existed, and it is pinned literally in
 * `__tests__/environment-security.test.ts`. A new scope joins
 * {@link PAIRING_SCOPES} and a preset — never this constant — unless someone
 * deliberately decides every unscoped, migrated, and bootstrap credential
 * should gain it.
 *
 * It is deliberately no longer called `FULL_PAIRING_SCOPE`: "full" stopped
 * being true the moment the vocabulary grew past it, and a name that lies is
 * how the widening above would have gone unnoticed.
 */
export const DEFAULT_GRANT_PAIRING_SCOPE: string = [
  PAIRING_SCOPE_ORCHESTRATION_READ,
  PAIRING_SCOPE_ORCHESTRATION_OPERATE,
  PAIRING_SCOPE_TERMINAL_OPERATE,
  PAIRING_SCOPE_ACCESS_MANAGE,
].join(' ');

/**
 * The pairing-UI presets: "Read-only" pairs a device that can only
 * read/stream state, "Standard" additionally grants control (mutate + open a
 * terminal) but withholds `access:manage` — a paired device, however
 * broadly scoped, can never manage other devices or pairing offers itself.
 *
 * `delegation` (archive#1123, `docs/design/station-peer-pairing.md`
 * §2) is a THIRD preset, not a reuse of `standard`: every call
 * `delegate_task` makes against a remote target resolves to either
 * `orchestration:read` or `orchestration:operate`
 * (`src-server/security/pairing-route-scopes.ts`) and never touches a
 * terminal route or the terminal WebSocket, but `standard` already includes
 * `terminal:operate` and there is no way to express "standard minus
 * terminal" by combining existing presets — `terminal:operate` is enforced
 * independently at the WebSocket layer
 * (`PAIRING_WS_SCOPES.terminal`, `pairing-route-scopes.ts`), so a session
 * carrying `standard` scope but never presenting it over HTTP would still
 * pass that separate WS check. A dedicated preset is required to grant
 * exactly the delegation surface and nothing else.
 *
 * IMPORTANT nuance (design doc §2, "what it also grants" / correction 2):
 * omitting `terminal:operate` bounds the surface the *calling peer* uses to
 * submit and monitor a delegated task on this Station — it says nothing
 * about what tools the *remote's own agent* has inside that delegated
 * session (e.g. shell access). A delegated task can still run shell
 * commands; what a `delegation`-scoped credential cannot do is open a side-
 * channel PTY on the grantor outside the orchestration session. Never
 * describe this preset as "no shell for the delegated agent" — that
 * conflates the peer's own API reach with the remote agent's local tool
 * authority.
 *
 * `inference` (archive#1398, `docs/design/inference-fleet.md` §3.3)
 * is a FOURTH preset and is a single scope on purpose: it is not "delegation
 * plus inference", it is *only* the fleet-inference surface. A peer holding
 * it may read which models this Station contributes and ask for a completion
 * on one of them; it may not read orchestration state, start a session, or
 * open a terminal. Invoking is operator-opt-in on the granting side, exactly
 * as contributing is operator-opt-in on the serving side — which is why
 * `inference:invoke` is in no other preset and not in
 * {@link DEFAULT_GRANT_PAIRING_SCOPE}.
 */
export const PAIRING_SCOPE_PRESETS = {
  'read-only': [PAIRING_SCOPE_ORCHESTRATION_READ],
  standard: [
    PAIRING_SCOPE_ORCHESTRATION_READ,
    PAIRING_SCOPE_ORCHESTRATION_OPERATE,
    PAIRING_SCOPE_TERMINAL_OPERATE,
  ],
  delegation: [
    PAIRING_SCOPE_ORCHESTRATION_READ,
    PAIRING_SCOPE_ORCHESTRATION_OPERATE,
  ],
  inference: [PAIRING_SCOPE_INFERENCE_INVOKE],
} as const satisfies Record<string, readonly PairingScope[]>;

export type PairingScopePreset = keyof typeof PAIRING_SCOPE_PRESETS;

/**
 * How a token can legitimately reach a real credential (archive#1883).
 *
 * - `preset` — offered at pairing time, via {@link PAIRING_SCOPE_PRESETS}.
 * - `default-grant` — inherited by {@link DEFAULT_GRANT_PAIRING_SCOPE} holders:
 *   migrated pre-scoping credentials, scope-omitting `createOffer` callers, and
 *   the same-origin continuity flow. Nobody *chooses* this path; they land in it.
 * - `operator-promotion` — granted deliberately by the operator to an
 *   already-paired device, never at pairing time.
 */
export type PairingScopeGrantPath =
  | 'preset'
  | 'default-grant'
  | 'operator-promotion';

/**
 * Every scope token, mapped to how a human can actually obtain it
 * (archive#1883).
 *
 * **The defect this exists to make unrepresentable.** `access:manage` was in
 * {@link DEFAULT_GRANT_PAIRING_SCOPE} and in *no* preset. So it had a large
 * holder population — every migrated, scope-omitting, and continuity-cookie
 * credential — and simultaneously no deliberate way to grant it. Four route
 * families were then tiered at `access:manage` on the stated assumption that no
 * preset grants it to a paired device, which was true and beside the point: the
 * default grant did. Nothing in the type system or the tests could see that,
 * because no artifact anywhere related a token to its grant paths.
 *
 * This declaration is that artifact. Because it is a `Record` keyed by
 * {@link PairingScope}, a new token **cannot compile** without stating how a
 * human obtains it. The companion test in
 * `__tests__/environment-security.test.ts` then checks the declaration against
 * reality — `preset` iff the token is in some preset, `default-grant` iff it is
 * in the default grant — so the declaration cannot lie, and every token must
 * have at least one path.
 *
 * Declaring a path here does NOT create it. Adding `'preset'` to a token still
 * requires putting it in a preset, or the test fails.
 */
export const PAIRING_SCOPE_GRANT_PATHS: Record<
  PairingScope,
  readonly PairingScopeGrantPath[]
> = {
  [PAIRING_SCOPE_ORCHESTRATION_READ]: ['preset', 'default-grant'],
  [PAIRING_SCOPE_ORCHESTRATION_OPERATE]: ['preset', 'default-grant'],
  [PAIRING_SCOPE_TERMINAL_OPERATE]: ['preset', 'default-grant'],
  // The recorded historical exception: in the frozen default grant, in no
  // preset, and deliberately never added to one — elevation at pairing time
  // grants the most to the least-known device. See archive#1883.
  [PAIRING_SCOPE_ACCESS_MANAGE]: ['default-grant'],
  [PAIRING_SCOPE_INFERENCE_INVOKE]: ['preset'],
  // archive#1887: the only token whose sole path is an operator promoting an
  // already-paired device. In no preset (elevation at pairing time grants the
  // most to the least-known device) and never in the default grant.
  [PAIRING_SCOPE_ACCESS_APPROVE]: ['operator-promotion'],
  // archive#3677: same posture as access:approve — operator promotion only.
  // The operator itself decides consent by credential identity, not via this
  // token (see the PAIRING_SCOPE_CONSENT_DECIDE doc block).
  [PAIRING_SCOPE_CONSENT_DECIDE]: ['operator-promotion'],
};

export const DEFAULT_PAIRING_SCOPE_PRESET: PairingScopePreset = 'standard';

/** The space-delimited scope string a UI preset resolves to. */
export function pairingScopePresetString(preset: PairingScopePreset): string {
  return PAIRING_SCOPE_PRESETS[preset].join(' ');
}

/**
 * Parses an OAuth-style space-delimited scope string into its known,
 * deduplicated tokens. `null` for anything empty, oversized, containing an
 * unknown token, or containing a duplicate — every caller treats `null` as
 * "reject", never as "grant nothing", which keeps this fail-closed.
 */
export function parsePairingScope(value: string): PairingScope[] | null {
  if (typeof value !== 'string' || value.length === 0 || value.length > 256) {
    return null;
  }
  const known = new Set<string>(PAIRING_SCOPES);
  const seen = new Set<PairingScope>();
  for (const token of value.split(' ')) {
    if (!token || !known.has(token) || seen.has(token as PairingScope)) {
      return null;
    }
    seen.add(token as PairingScope);
  }
  return [...seen];
}

/** Whether a (possibly multi-scope) grant/session scope string includes one required scope. */
export function pairingScopeIncludes(
  scope: string,
  required: PairingScope,
): boolean {
  const parsed = parsePairingScope(scope);
  return !!parsed?.includes(required);
}

/**
 * A session's granted scope is valid only when every one of its scopes is
 * also present on the grant it was exchanged from — a session can never
 * carry more authority than its grant (R1). Both sides must parse; an
 * unparseable scope on either side is never treated as a subset.
 */
export function isPairingScopeSubset(
  sessionScope: string,
  grantScope: string,
): boolean {
  const session = parsePairingScope(sessionScope);
  const grant = parsePairingScope(grantScope);
  if (session === null || grant === null) return false;
  const grantSet = new Set(grant);
  return session.every((scope) => grantSet.has(scope));
}

/**
 * Monotonic integer for the *client/server contract* — deliberately NOT the
 * marketing/package version. `serverVersion` (e.g. `0.4.1`) moves on every
 * release and says nothing about whether a phone build can talk to a host;
 * this number moves only when the contract itself changes.
 *
 * Bump it when, and only when, a change would make an existing client
 * misbehave against a new host or a new client misbehave against an existing
 * host. Concretely, a bump is obligatory for:
 *   - removing or renaming a field a client reads, or changing its meaning;
 *   - changing an existing endpoint's status codes, auth requirements, or
 *     error taxonomy in a way a deployed client branches on;
 *   - changing the wire encoding of an existing request or response;
 *   - retiring a capability listed in {@link StationCompatibility.capabilities}.
 * Purely additive changes (a new optional field, a new endpoint, a new
 * capability entry) do NOT justify a bump — that is what keeps old clients
 * working and is why this number is not the package version.
 *
 * When it is bumped, decide separately whether the host still serves the
 * previous generation of clients. If it does, leave
 * {@link STATION_COMPAT_MIN_CLIENT_PROTOCOL} alone; if it cannot, raise that
 * too — that is the switch that turns a silent misbehavior into a
 * "update your app" verdict.
 */
export const STATION_COMPAT_PROTOCOL_VERSION = 1;

/**
 * Oldest client protocol this host still serves. A client advertising less
 * than this is told to update itself, because the host can no longer honor
 * the contract that client was built against.
 */
export const STATION_COMPAT_MIN_CLIENT_PROTOCOL = 1;

/**
 * Oldest host protocol this client still accepts. A host advertising less
 * than this is a host the user must update; the client cannot downgrade
 * itself to speak the older contract.
 */
export const STATION_COMPAT_MIN_SERVER_PROTOCOL = 1;

/**
 * The compatibility block a host advertises on the public handshake.
 *
 * Optional in the wire type because public input must be parsed before it can
 * be rejected. A client treats absence as an unverifiable, blocking response
 * and tells the operator to update or repair the Station endpoint.
 */
export interface StationCompatibility {
  /** Real package version of the running host, for display and support. */
  serverVersion: string;
  /** See {@link STATION_COMPAT_PROTOCOL_VERSION}. */
  protocolVersion: number;
  /** See {@link STATION_COMPAT_MIN_CLIENT_PROTOCOL}. */
  minClientProtocol: number;
  /**
   * Per-capability protocol versions, so a client can reason about one
   * sub-protocol without waiting for a whole-contract bump. Keys are stable
   * capability names; values are the existing per-capability version
   * constants (`REMOTE_AUTH_PROTOCOL_VERSION`, and friends).
   */
  capabilities?: Record<string, number>;
}

/**
 * What the client concluded about a host it just handshook with.
 *
 * `unknown` means the host response could not be verified. It is blocking
 * until the Station advertises a valid compatibility declaration.
 */
export type StationCompatibilityVerdict =
  | 'compatible'
  | 'client-too-old'
  | 'server-too-old'
  | 'unknown';

export interface StationCompatibilityResult {
  verdict: StationCompatibilityVerdict;
  /**
   * Human-readable, and always names which side to update and how. Rendered
   * verbatim; never a bare code.
   */
  reason: string;
  /** True only when the client should refuse to proceed with this host. */
  blocking: boolean;
  /** Present when the host advertised it. */
  serverVersion?: string;
  /** Present when the host advertised it. */
  serverProtocol?: number;
}

/** What this client is, for {@link StationCompatibility} comparison. */
export interface StationClientCompatibilityPolicy {
  clientProtocol: number;
  minServerProtocol: number;
}

export interface DevicePairingOffer {
  protocolVersion: typeof DEVICE_PAIRING_PROTOCOL_VERSION;
  environmentId: string;
  offerId: string;
  challenge: string;
  manualCode: string;
  endpoint: string;
  /** Space-delimited {@link PairingScope} string — see {@link parsePairingScope}. */
  scope: string;
  expiresAt: number;
}

interface DevicePairingRequestBase {
  requestId: string;
  offerId: string;
  deviceName: string;
  /** Space-delimited {@link PairingScope} string, copied from the offer. */
  scope: string;
  createdAt: number;
  expiresAt: number;
  status: 'pending' | 'confirmed' | 'denied';
}

export interface TailscaleServeRequester {
  provider: 'tailscale-serve';
  login: string;
  displayName?: string;
}

export type DevicePairingRequest = DevicePairingRequestBase &
  (
    | {
        source: 'tailnet';
        requester: TailscaleServeRequester;
      }
    | {
        source: 'same-origin' | 'pairing-code';
        requester?: never;
      }
  );

/** A public access request is pending until explicit authority confirms it. */
export interface DevicePairingAccessRequestResponse {
  environmentId: string;
  offerId: string;
  proof: string;
  requestId: string;
  expiresAt: number;
}

/**
 * What a paired-device grant is FOR:
 *  - `'device'` — an ordinary interactive device (phone, browser, CLI) that
 *    may control this Station through the paired-device UI/API surface.
 *  - `'delegation'` — a credential minted so a PEER Station may call
 *    `delegate_task`-equivalent orchestration routes on this Station. Same
 *    registry, same revoke affordance, distinctly labeled so an operator can
 *    tell "a phone is paired with me" apart from "a peer Station may
 *    delegate work to me" in the same list. See
 *    `docs/design/station-peer-pairing.md` §5.
 */
export type PairedDeviceKind = 'device' | 'delegation';
export type PairedDeviceActivityTracking =
  | 'tracked-since-issued'
  | 'unobserved-before-activity-tracking';
export type PairedDeviceRevocation =
  | { state: 'not-revoked' }
  | { state: 'unobserved-before-revocation-provenance' }
  | {
      state: 'recorded';
      actor: 'operator-credential';
      reason: 'owner-request';
    }
  | {
      state: 'recorded';
      actor: 'same-client-replacement';
      reason: 'same-client-replacement';
    };

/** Bounded server-owned projection of currently open primary event streams. */
export interface ConnectedClientProjection {
  deviceId: string;
  sessionCount: number;
  connectedAt: number;
  lastSeenAt: number;
  transports: readonly ['events-sse'];
}

export interface PairedDevice {
  id: string;
  name: string;
  /**
   * Space-delimited {@link PairingScope} string granted to this device
   * (archive#1098). A device paired before scoped pairing shipped reads as
   * {@link DEFAULT_GRANT_PAIRING_SCOPE} — see {@link DEVICE_PAIRING_SCOPE}'s
   * doc. That set is no longer the whole vocabulary, so a renderer must
   * describe the tokens held rather than call it "full" (see
   * `packages/connect`'s `describeDeviceScope`).
   */
  scope: string;
  /**
   * Additive: a device paired before this field
   * existed has no such key in its persisted record and reads back as
   * `'device'` — see `DevicePairingService`'s registry loader, which
   * migrates it in place the same way `scope` itself was migrated
   * (archive#1098 R4). Never absent on a value read out of the service.
   */
  kind: PairedDeviceKind;
  createdAt: number;
  /**
   * When this grant was issued. Older registry records predate this explicit
   * label and intentionally leave it absent rather than inferring a date.
   */
  issuedAt?: number;
  /**
   * Last successful use of this grant. Absent means never used, including
   * records that predate use tracking (historically spelled on disk as either
   * an explicit `null` or a missing key — both normalize to absent on load);
   * it is never fabricated on read.
   */
  lastUsedAt?: number;
  /**
   * Explicit migration state for the durable request-activity fields below.
   * Registries written before the v2 activity schema are upgraded to
   * `'unobserved-before-activity-tracking'`; their historical count and peer
   * are unknown, not zero or a guessed location. New credentials always use
   * `'tracked-since-issued'`.
   */
  activityTracking: PairedDeviceActivityTracking;
  /**
   * Coarse server-derived location of the latest authenticated request. This
   * is never a raw socket address; `null` means the latest peer could not be
   * classified honestly, or historical state predates activity tracking.
   */
  lastSeenFrom: 'loopback' | 'lan' | 'tailnet' | null;
  /** Durable HTTP request count, or null when pre-tracking history is unknown. */
  usageCount: number | null;
  /** UTC calendar day of the latest request, or null when never/unobserved. */
  lastActiveDay: string | null;
  revokedAt: number | null;
  /**
   * Bounded revocation provenance. V1 records upgrade to an explicit
   * unobserved state instead of inventing an actor/reason for past actions.
   */
  revocation: PairedDeviceRevocation;
  /**
   * Additive (archive#1878): how this device's pairing *request*
   * reached the host — carried onto the record at exchange, from the same
   * {@link DevicePairingRequest.source} the approval decision already
   * weighed and then used to discard. A device paired before this field
   * existed has no such key at all and reads back as `undefined`; that is
   * never guessed forward, unlike {@link PairedDevice.kind}, because there is
   * no honest default for "how did this already-approved device get here".
   */
  source?: DevicePairingRequest['source'];
  /**
   * Additive (archive#1878): who asked, when the pairing request
   * arrived over the tailnet with a server-verified identity (archive#1490)
   * — the same {@link DevicePairingRequest.requester} the approval decision
   * already saw. Present only when `source === 'tailnet'`; `same-origin` and
   * `pairing-code` requests carry no requester identity to record, and a
   * device paired before this field existed has no such key at all.
   */
  requester?: TailscaleServeRequester;
  /**
   * Ephemeral connection state, added only by the access-management listing.
   * It is not persisted with a paired device and never includes session ids.
   */
  connectedClients?: ConnectedClientProjection | null;
}

/**
 * A browser Web Push subscription (the JSON shape of the browser's
 * `PushSubscription`). Persisted only on the private `StoredDevice` record —
 * never surfaced through `publicDevice()` / `PairedDevice`. Structurally
 * compatible with the `web-push` package's own `PushSubscription` type so it
 * can be passed straight to `sendNotification` without casting.
 */
export interface WebPushSubscription {
  endpoint: string;
  expirationTime?: number | null;
  keys: {
    p256dh: string;
    auth: string;
  };
}

export interface DevicePairingExchangeRequest {
  offerId: string;
  proof: string;
  requestId: string;
  /**
   * Opaque, client-local correlation identifier scoped to the Station origin.
   * It lets the host replace an older active grant from this same app
   * instance after a new approved pairing. It is deliberately not an
   * authentication factor and is never returned in a paired-device response.
   *
   * Optional for additive wire compatibility with deployed clients. New
   * clients send it on every exchange.
   */
  clientInstanceId?: string;
  delivery?: typeof DEVICE_PAIRING_BROWSER_COOKIE_DELIVERY;
}

export interface DevicePairingBearerExchangeResponse {
  environmentId: string;
  device: PairedDevice;
  credential: string;
}

export interface DevicePairingBrowserExchangeResponse {
  environmentId: string;
  device: PairedDevice;
  delivery: typeof DEVICE_PAIRING_BROWSER_COOKIE_DELIVERY;
}

export type DevicePairingExchangeResponse =
  | DevicePairingBearerExchangeResponse
  | DevicePairingBrowserExchangeResponse;

export interface PublicStationProofRequest {
  protocolVersion: typeof STATION_PROOF_PROTOCOL_VERSION;
  nonce: string;
}

export interface PublicStationProofResponse {
  protocolVersion: typeof STATION_PROOF_PROTOCOL_VERSION;
  environmentId: string;
  nonce: string;
  signature: string;
}

export function buildStationProofMessage(
  environmentId: string,
  nonce: string,
): string {
  return `${STATION_PROOF_DOMAIN}\n${STATION_PROOF_PROTOCOL_VERSION}\n${environmentId}\n${nonce}`;
}

export interface EnvironmentSecurityRecord {
  schemaVersion: typeof ENVIRONMENT_SECURITY_SCHEMA_VERSION;
  environmentId: string;
  credential: string;
}

/**
 * Feature-detection flags on the public handshake (archive#1095) — the
 * rolling-upgrade story for phone/CLI vs server skew. Every key is an
 * optional boolean, and BOTH the whole object and any individual key may be
 * absent; either absence means "unsupported" (the host predates the
 * feature, or never shipped it). That is deliberate, not an oversight: it is
 * what lets an old-shaped consumer decode a payload with new flags it has
 * never heard of (it just ignores them), and a new-shaped consumer decode a
 * payload from a host that predates this field entirely (every flag reads
 * as `false`/absent) — both directions are pinned by the fixture tests next
 * to {@link PublicStationHandshake}.
 *
 * Distinct from two other same-named-in-spirit but unrelated concepts in
 * this codebase, kept apart on purpose:
 *  - {@link StationCompatibility.capabilities} is a map of *sub-protocol
 *    version numbers* (remote auth, device pairing, environment proof), not
 *    boolean feature flags.
 *  - `packages/connect`'s `EnvironmentCapabilities` (`SavedConnection.
 *    capabilities`) is a client-local summary *derived* from the
 *    `transports` block, not read off the wire from this field.
 *
 * The single source of truth for which flags this host advertises is
 * `src-server/capabilities/station-capability-flags.ts` — add a new flag
 * there (and mirror its key here for type safety), not in the route handler
 * or the service.
 */
export interface StationCapabilityFlags {
  /** SSH environment management (`src-server/services/ssh/`, `/api/ssh-environments`). */
  sshEnvironments?: boolean;
  /** Web Push subscribe/unsubscribe (`src-server/routes/operations/push-routes.ts`). */
  webPushNotifications?: boolean;
  /**
   * The `/api/orchestration/events` (+ per-session) SSE stream honors a
   * `Last-Event-ID` resume cursor with bounded replay-or-snapshot semantics
   * (archive#1092). Server-side resume handling itself is unconditional and
   * harmless to old clients; this flag only gates whether a *client* trusts
   * the new dedup/skip-refetch behavior.
   */
  eventStreamResume?: boolean;
  /** The versioned bounded per-session event-window protocol is available. */
  sessionEventWindow?: boolean;
  /**
   * Scoped pairing (archive#1098): pairing grants and device sessions carry
   * an OAuth-style scope string, enforced by a single route -> required-scope
   * table (`src-server/security/pairing-route-scopes.ts`).
   */
  scopedPairing?: boolean;
  /**
   * Fleet inference (archive#1398): this build understands the
   * `inference:invoke` pairing scope token, so a peer may mint a grant
   * containing it.
   *
   * This is a **static protocol fact, not a participation signal.**
   * {@link parsePairingScope} rejects an unknown token by returning `null`
   * for the WHOLE scope string, so handing a host
   * `"orchestration:read inference:invoke"` that it cannot parse refuses
   * the grant entirely rather than degrading — the mint side must therefore
   * be gated on this flag (`docs/design/inference-fleet.md` §3.3 point 2).
   *
   * **A host advertises it only once {@link PAIRING_SCOPES} actually
   * contains the token.** Slice 1 declared this key and left it
   * unadvertised: a build that claimed it while still rejecting the token
   * would invite exactly the mixed-version refusal the flag exists to
   * prevent. Slice 2 flips both halves together — the token joined
   * {@link PAIRING_SCOPES} and the `inference` preset, and
   * {@link DEFAULT_GRANT_PAIRING_SCOPE} was decoupled from the vocabulary in
   * the same change so no unscoped, migrated, or bootstrap grant silently
   * gained it and no older peer was handed a scope string it cannot parse.
   * The if-and-only-if coupling stays pinned by
   * `src-server/capabilities/__tests__/station-capability-flags.test.ts`, so
   * neither half can be reverted alone.
   *
   * It must NEVER become "this Station is currently contributing models".
   * The handshake is public and unauthenticated
   * (`pairing-route-scopes.ts`), and advertising participation would let any
   * LAN or tailnet scanner enumerate which of the owner's machines have GPUs
   * (§5.2 rule 1). Participation is readable only after authentication, from
   * the contributed-subset manifest (`fleet-contribution.ts`).
   */
  fleetInference?: boolean;
  /**
   * A device whose scope carries {@link PAIRING_SCOPE_ACCESS_APPROVE} may
   * approve or deny pending pairing requests (archive#1887).
   *
   * Coupled if-and-only-if to the token parsing, and pinned by
   * `packages/contracts/src/__tests__/environment-security.test.ts`:
   * advertising the flag while the vocabulary cannot parse the token would be
   * a false claim, and parsing it without advertising leaves clients unable to
   * discover the capability. Neither half can be reverted alone.
   */
  devicePairingApproval?: boolean;
}

export interface PublicStationHandshake {
  schemaVersion: typeof PUBLIC_HANDSHAKE_SCHEMA_VERSION;
  environmentId: string;
  authentication: {
    scheme: 'bearer';
    protocolVersion: typeof REMOTE_AUTH_PROTOCOL_VERSION;
  };
  transports: {
    http: typeof REMOTE_AUTH_PROTOCOL_VERSION;
    sse: typeof REMOTE_AUTH_PROTOCOL_VERSION;
    websocket: typeof REMOTE_AUTH_PROTOCOL_VERSION;
  };
  /**
   * Required for every conforming Station handshake. Raw public input must be
   * parsed as unknown before it is accepted as this producer-valid contract.
   */
  compatibility: StationCompatibility;
  /**
   * Additive, see {@link StationCapabilityFlags}. Hosts from before
   * archive#1095 omit it entirely; every consumer must keep working when it
   * is absent.
   */
  capabilities?: StationCapabilityFlags;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Validates the compatibility declaration shared by every public-handshake
 * consumer. This is deliberately separate from the enclosing handshake so
 * connection setup and capability negotiation cannot drift on what a valid
 * host compatibility claim means.
 */
export function parseStationCompatibility(
  value: unknown,
): StationCompatibility | undefined {
  if (!isRecord(value)) return undefined;
  if (
    typeof value.serverVersion !== 'string' ||
    value.serverVersion.length === 0 ||
    !Number.isSafeInteger(value.protocolVersion) ||
    !Number.isSafeInteger(value.minClientProtocol)
  ) {
    return undefined;
  }
  if (
    value.capabilities !== undefined &&
    (!isRecord(value.capabilities) ||
      Object.values(value.capabilities).some(
        (version) => !Number.isSafeInteger(version),
      ))
  ) {
    return undefined;
  }
  return value as unknown as StationCompatibility;
}

/**
 * Validates an untrusted public-handshake response before consumers use its
 * feature flags. A missing capability is compatible with an older host; a
 * missing required handshake field is not a handshake at all.
 */
export function parsePublicStationHandshake(
  value: unknown,
): PublicStationHandshake | undefined {
  if (!isRecord(value)) return undefined;
  if (
    value.schemaVersion !== PUBLIC_HANDSHAKE_SCHEMA_VERSION ||
    typeof value.environmentId !== 'string' ||
    !isRecord(value.authentication) ||
    value.authentication.scheme !== 'bearer' ||
    value.authentication.protocolVersion !== REMOTE_AUTH_PROTOCOL_VERSION ||
    !isRecord(value.transports) ||
    value.transports.http !== REMOTE_AUTH_PROTOCOL_VERSION ||
    value.transports.sse !== REMOTE_AUTH_PROTOCOL_VERSION ||
    value.transports.websocket !== REMOTE_AUTH_PROTOCOL_VERSION ||
    !parseStationCompatibility(value.compatibility)
  ) {
    return undefined;
  }
  if (
    value.capabilities !== undefined &&
    (!isRecord(value.capabilities) ||
      Object.values(value.capabilities).some(
        (enabled) => typeof enabled !== 'boolean',
      ))
  ) {
    return undefined;
  }
  return value as unknown as PublicStationHandshake;
}
