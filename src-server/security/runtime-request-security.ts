import {
  CLIENT_ORIGIN_HEADER,
  CLIENT_ORIGIN_VERSION,
  type ClientOrigin,
  parseClientReportedOrigin,
} from '@kontourai/station-contracts/client-origin';
import { pairingScopeIncludes } from '@kontourai/station-contracts/environment-security';

export type RuntimePeerClass = 'loopback' | 'remote' | 'absent';
export type PairedDeviceLastSeenFrom = 'loopback' | 'lan' | 'tailnet';

export interface RuntimeCredentialActivityContext {
  lastSeenFrom?: PairedDeviceLastSeenFrom;
}

export type RuntimeCredentialAuthority =
  | 'operator-credential'
  | 'device-credential';
export const RUNTIME_CREDENTIAL_AUTHORITY_VAR =
  'stationRuntimeCredentialAuthority';

/**
 * The authenticated ingress credential is held only for the lifetime of its
 * Request. Runtime seams use this instead of reparsing a particular transport
 * header, which keeps bearer and HttpOnly device-session cookie callers on
 * the one middleware-authenticated path.
 */
/**
 * How a device credential was minted. `same-origin` is the local-grant /
 * UI-bootstrap / same-origin continuity session. `pairing-code` and
 * `tailnet` are pairing credentials. `same-origin` is also the label on
 * LAN / Tauri / access-request grants — it is NOT local-operator proof.
 */
export type RuntimeDevicePairingSource =
  | 'same-origin'
  | 'pairing-code'
  | 'tailnet';

/**
 * Mint-time proof that issuance presented the local-grant secret or the
 * per-boot internal token to a same-machine process. Written onto the
 * stored credential (or the ephemeral internal-token principal) only by
 * those mint paths. `isLocalRuntimeCaller` reads this field and nothing
 * else.
 */
export type CredentialLocality = 'home-possession';

/**
 * WHICH home-possession mint path issued the credential (archive#3677 PR 3).
 * `local-grant` is the only kind whose proof — reading the per-boot
 * owner-only secret FILE — cannot be produced from any browser or webview
 * JS context; `ui-bootstrap` proves the same possession but hands the
 * resulting credential to host-browser JS, where same-origin plugin code
 * runs. Surfaces that let a caller APPROVE on the operator's behalf (the
 * native consent broker) must require `local-grant`; read-only local
 * surfaces (log reads) keep keying on locality alone.
 */
export type CredentialMintKind = 'local-grant' | 'ui-bootstrap';

export interface RuntimeAuthenticatedRequestPrincipal {
  /** Explicit server-minted principal discriminant; never inferred from credential text. */
  readonly kind?: 'internal' | 'credential';
  readonly credential: string;
  readonly authority: RuntimeCredentialAuthority | undefined;
  /** Server-resolved paired-device identity; never request supplied. */
  readonly deviceId?: string;
  readonly source: 'bearer' | 'session';
  /** Present only for a device credential whose pairing request recorded a source. */
  readonly pairingSource?: RuntimeDevicePairingSource;
  /**
   * Set only when mint proved home-directory possession. Operator
   * credentials, access-request grants, pairing-code/tailnet devices, and
   * a UI-bootstrap exchanged through the proxy never carry this.
   */
  readonly locality?: CredentialLocality;
  /**
   * Present only when `locality` is present AND the pairing store recorded
   * which mint path proved it. Pre-#3677 credentials and the ephemeral
   * internal-token principal have locality with no kind — consumers that
   * require `local-grant` therefore fail closed on them.
   */
  readonly mintKind?: CredentialMintKind;
}
const authenticatedRequestPrincipals = new WeakMap<
  Request,
  RuntimeAuthenticatedRequestPrincipal
>();
const boundLocalOperator = new WeakMap<Request, boolean>();
const boundLocalGrantMintedOperator = new WeakMap<Request, boolean>();
export function setRuntimeAuthenticatedRequestPrincipal(
  request: Request,
  principal: RuntimeAuthenticatedRequestPrincipal,
): void {
  authenticatedRequestPrincipals.set(request, Object.freeze({ ...principal }));
}
export function getRuntimeAuthenticatedRequestPrincipal(
  request: Request,
): RuntimeAuthenticatedRequestPrincipal | undefined {
  return authenticatedRequestPrincipals.get(request);
}

/**
 * The only authenticated request-origin resolver. The header contributes
 * bounded reported display metadata only; actor/device facts come from the
 * credential already accepted at the runtime security seam.
 */
export function resolveClientOriginForRequest(request: Request): ClientOrigin {
  const principal = getRuntimeAuthenticatedRequestPrincipal(request);
  const actor =
    principal?.kind === 'internal'
      ? ({ kind: 'internal' } as const)
      : principal?.authority === 'operator-credential'
        ? ({ kind: 'operator' } as const)
        : principal?.authority === 'device-credential' && principal.deviceId
          ? ({ kind: 'device', deviceId: principal.deviceId } as const)
          : ({ kind: 'unknown' } as const);
  return Object.freeze({
    version: CLIENT_ORIGIN_VERSION,
    actor,
    reported: parseClientReportedOrigin(
      request.headers.get(CLIENT_ORIGIN_HEADER) ?? undefined,
    ),
  });
}

export interface RuntimeDeviceActivityClassifierContext {
  environment: unknown;
  header(name: string): string | undefined;
  directSocketAddress: string | undefined;
  /**
   * Peer observed by Station's UI proxy, supplied only after runtime-http
   * proved the proxy's per-boot internal token on a loopback hop.
   */
  attestedProxyPeerAddress?: string | undefined;
}

export interface RuntimeSecurityAuditRecord {
  [key: string]: unknown;
  event: 'station.auth.failure' | 'station.auth.rate_limited';
  /** HTTP method and pathname only; never query parameters or headers. */
  method: string;
  outcome: 'denied';
  path: string;
  /** Leading-slash-free closed-vocabulary label safe for durable logs. */
  routeLabel: string;
  reason: string;
  routeClass: 'public' | 'protected';
  peerClass: RuntimePeerClass;
  transport: 'http';
  timestamp: number;
}

export interface RuntimeHttpSecurityOptions {
  verifyCredential: (
    credential: string,
    request?: {
      method: string;
      path: string;
      tenant?: TenantRequestContext;
      activity?: RuntimeCredentialActivityContext;
    },
  ) => boolean | Promise<boolean>;
  /** Resolves a verified credential's concrete authority for route handlers. */
  resolveCredentialAuthority?: (
    credential: string,
  ) => RuntimeCredentialAuthority | undefined;
  /** Server-side paired-device lookup used only for durable provenance. */
  resolveCredentialDeviceId?: (credential: string) => string | undefined;
  /**
   * Resolves a device credential's pairing-request source. Operator
   * credentials and historical devices without a source resolve `undefined`.
   */
  resolvePairingSource?: (
    credential: string,
  ) => RuntimeDevicePairingSource | undefined;
  /**
   * Resolves mint-time home-possession. Operator credentials and every
   * pairing/access-request grant resolve `undefined`.
   */
  resolveCredentialLocality?: (
    credential: string,
  ) => CredentialLocality | undefined;
  /**
   * Resolves which home-possession mint path issued a credential — see
   * `CredentialMintKind`. Resolves `undefined` for everything without a
   * recorded kind (which consumers treat as "not local-grant").
   */
  resolveCredentialMintKind?: (
    credential: string,
  ) => CredentialMintKind | undefined;
  /**
   * Resolves a peer to a non-identifying device-activity class. Production
   * passes the verified ingress resolver; a missing resolver records activity
   * with no location rather than inventing one from forwarded headers.
   */
  classifyPairedDeviceActivity?: (
    context: RuntimeDeviceActivityClassifierContext,
  ) => PairedDeviceLastSeenFrom | undefined;
  /**
   * Scoped pairing (archive#1098): resolves the space-delimited scope string
   * a credential was granted (the operator credential resolves to every
   * scope; a paired device resolves to its grant's scope), or `undefined`
   * for an invalid credential. Every protected route is checked against
   * `requiredPairingScope` from `pairing-route-scopes.ts` and denied (403
   * `insufficient_scope`) unless the granted scope includes the route's
   * required scope.
   *
   * Required, not optional: an omitted resolver used to silently skip scope
   * enforcement entirely (a credential-valid request passed straight
   * through with no scope check), which would let a future call site revert
   * to pre-scoping auth with no compile error. A harness that genuinely
   * doesn't care about scoping (most existing boundary tests) still must
   * supply a resolver — typically one that maps every credential it accepts
   * to `DEFAULT_GRANT_PAIRING_SCOPE`, which is the honest pre-archive#1098 behavior:
   * every valid credential could reach every protected route.
   */
  resolveGrantedScope: (
    credential: string,
  ) => string | undefined | Promise<string | undefined>;
  allowedOrigins?: readonly string[];
  audit?: (record: RuntimeSecurityAuditRecord) => void;
  now?: () => number;
  maxFailures?: number;
  windowMs?: number;
  maxTrackedPeers?: number;
  // ── Mutation budgets (archive#514) ──
  /** Max request body bytes for a standard authenticated JSON mutation. */
  maxMutationBodyBytes?: number;
  /** Max request body bytes for an enumerated streaming mutation (chat turns). */
  maxStreamingBodyBytes?: number;
  /** Max standard mutations per principal per window before 429. */
  maxMutationsPerWindow?: number;
  /** Max streaming mutations per principal per window before 429. */
  maxStreamingPerWindow?: number;
  /** Max explicit performance-diagnostic mutations per principal per window. */
  maxPerformanceDiagnosticPerWindow?: number;
  /** Rate-budget window in milliseconds (shared across both classes). */
  mutationWindowMs?: number;
  /** LRU bound on distinct principal keys tracked in the rate Map. */
  maxBudgetPrincipals?: number;
}

function isPublicRuntimeRoute(method: string, path: string): boolean {
  return (
    requiredExternalSurfaceCapability('http', method, path)?.capability ===
    'public'
  );
}

export function classifyRuntimePeer(address: string | undefined): {
  address: string | undefined;
  peerClass: RuntimePeerClass;
} {
  const normalized = normalizeSocketAddress(address);
  if (!normalized) return { address: undefined, peerClass: 'absent' };

  if (
    normalized === '::1' ||
    normalized === '0:0:0:0:0:0:0:1' ||
    (normalized.startsWith('127.') && isValidIpv4(normalized))
  ) {
    return { address: normalized, peerClass: 'loopback' };
  }
  return { address: normalized, peerClass: 'remote' };
}

/**
 * Direct socket peer of a Hono request's Node incoming, never a forwarded
 * header. Station's UI proxy always re-dials the API from loopback, so this
 * alone cannot tell a local operator from a phone on the UI port.
 */
export function getDirectSocketAddress(
  environment: unknown,
): string | undefined {
  if (!environment || typeof environment !== 'object') return undefined;
  const incoming = (environment as { incoming?: unknown }).incoming;
  if (!incoming || typeof incoming !== 'object') return undefined;
  const socket = (incoming as { socket?: unknown }).socket;
  if (!socket || typeof socket !== 'object') return undefined;
  const address = (socket as { remoteAddress?: unknown }).remoteAddress;
  return typeof address === 'string' ? address : undefined;
}

/**
 * The auth boundary's attested-proxy classification (archive#2051).
 *
 * `undefined` means no attestation headers were presented — the caller
 * reached the API directly, and {@link classifyRuntimePeer} on the socket
 * is the whole story. `'loopback'` is earned only by the Station-owned
 * UI/MCP hop: trusted per-boot internal token, direct loopback socket,
 * and `x-station-proxy-caller: local`. Anything else with attestation
 * present (including a junk token) is `'remote'`, which is the SAFE
 * verdict at this boundary.
 *
 * Pairing approval must NOT reuse this: there `'remote'` is the
 * permissive answer. See `pairingRequesterPosition` in runtime-routes.ts.
 */
export function classifyAttestedProxyCaller(
  environment: unknown,
  headers: { caller?: string; token?: string },
): 'loopback' | 'remote' | undefined {
  const hasAttestation =
    headers.caller !== undefined || headers.token !== undefined;
  if (!hasAttestation) return undefined;
  const directPeer = classifyRuntimePeer(getDirectSocketAddress(environment));
  if (
    directPeer.peerClass !== 'loopback' ||
    !isTrustedInternalApiToken(headers.token)
  ) {
    return 'remote';
  }
  return headers.caller === 'local' ? 'loopback' : 'remote';
}

/**
 * Whether this request crossed Station's OWN loopback proxy hop, attested.
 *
 * Two facts, both required and neither spellable by the proxy's client: the
 * request reached this server from a direct LOOPBACK socket, and it carries
 * the per-boot internal token. The proxy strips every client-supplied copy of
 * its attestation headers before setting its own, so a browser cannot present
 * this and a caller off the machine cannot either without the token.
 *
 * This is the ONE gate on every header the proxy attests
 * (`x-station-proxy-peer`, `x-station-proxy-forwarded-host`,
 * `x-station-ingress-identity`); each reader below composes it rather than
 * restating it, so a change to what "Station's own proxy" means moves them
 * together.
 */
function isAttestedStationProxyHop(request: RuntimeCallerRequest): boolean {
  return (
    classifyRuntimePeer(getDirectSocketAddress(request.environment))
      .peerClass === 'loopback' &&
    isTrustedInternalApiToken(request.header(INTERNAL_API_TOKEN_HEADER))
  );
}

/**
 * The address Station's own UI proxy saw its DIRECTLY connected client at, or
 * `undefined` when this request did not cross that hop under a trusted
 * attestation (archive#1490).
 *
 * `undefined` therefore means two different things and the caller must decide
 * which it is looking at: no proxy in the loop at all (read the direct socket
 * instead), or a proxy attestation this host refused. A caller for which the
 * permissive answer is "same machine" must ALSO check that no attestation
 * headers are present, or a junk token buys the direct socket's reading of
 * the hop standing in front of it.
 */
export function attestedProxyPeerAddress(
  request: RuntimeCallerRequest,
): string | undefined {
  return isAttestedStationProxyHop(request)
    ? request.header(INTERNAL_PROXY_PEER_HEADER)
    : undefined;
}

/**
 * Whether an `host:port` authority names THIS machine's loopback interface —
 * `localhost`, `127.0.0.0/8`, or `::1`. Any other name (a LAN address, a
 * `.ts.net` name, a public host) is false.
 *
 * Used on an ATTESTED browser-visible host (see {@link browserVisibleHost}),
 * where it answers "did the browser dial this machine's loopback?" — a fact
 * the socket alone cannot supply once a proxy has terminated the connection.
 */
export function isLoopbackAuthority(authority: string | undefined): boolean {
  // Through `validAuthority` first, so nothing but a bare `host:port` is ever
  // judged: `station.local@127.0.0.1:5274` parses to the loopback hostname and
  // would otherwise read as this machine (the same absorption archive#3752's
  // review caught one layer up).
  const exact = validAuthority(authority);
  if (exact === undefined) return false;
  const hostname = new URL(`http://${exact}`).hostname.toLowerCase();
  if (hostname === 'localhost') return true;
  return (
    classifyRuntimePeer(normalizeSocketAddress(hostname)).peerClass ===
    'loopback'
  );
}

/**
 * The `Host` the BROWSER used, for a URL this server mints FOR the browser
 * (archive#3752 — today the consent review URL).
 *
 * Station's own UI proxy rewrites `Host` to the upstream address, so the
 * request's own `Host` names `127.0.0.1:<serverPort>` for every browser that
 * came through it. A URL built from that names a host whose cookie jar is
 * NOT the browser's — cookies are scoped by host, ports ignored — so the
 * transaction cookie set under `localhost` was never sent to `127.0.0.1` and
 * the consent review page refused everyone.
 *
 * The proxy's forwarded host is accepted under exactly the rule
 * `x-station-proxy-peer` uses: a direct LOOPBACK socket AND a trusted
 * per-boot internal token, which together mean this hop is Station's own
 * proxy rather than a client spelling a header. Anything else falls back to
 * the request's own `Host` — the direct-topology answer, which is correct
 * when there is no proxy. This is deliberately NOT `x-forwarded-host`, which
 * any direct caller can send and which `public-ingress-origin.ts` refuses to
 * trust for the same reason.
 */
export function browserVisibleHost(
  request: RuntimeCallerRequest,
): string | undefined {
  return (
    attestedBrowserVisibleHost(request) ??
    validAuthority(request.header('host'))
  );
}

/**
 * ONLY the `Host` Station's own proxy attested for its client, with no
 * fallback to the request's own — `undefined` when this request did not cross
 * that hop, or crossed it without a syntactically exact authority.
 *
 * {@link browserVisibleHost} falls back because it is picking the best answer
 * for a URL it has to mint either way. A caller deciding whether the browser
 * addressed THIS MACHINE must not take that fallback: behind the proxy the
 * request's own `Host` is the address the PROXY dialled (`127.0.0.1:<port>`),
 * which reads as loopback for every browser on earth.
 */
export function attestedBrowserVisibleHost(
  request: RuntimeCallerRequest,
): string | undefined {
  const forwarded = request.header(INTERNAL_PROXY_FORWARDED_HOST_HEADER);
  if (forwarded === undefined || !isAttestedStationProxyHop(request)) {
    return undefined;
  }
  return validAuthority(forwarded);
}

/**
 * One syntactically exact `host:port` authority, or `undefined`.
 *
 * Attestation proves WHO supplied a value, never WHAT it says: the proxy
 * copies its client's `Host` verbatim, and a caller that is not a browser can
 * spell anything there. Consumers embed this in a URL as
 * `new URL('http://' + host)`, and WHATWG parsing happily absorbs userinfo,
 * paths and queries — so `station.local@evil.example:3000` would mint a
 * review URL on `evil.example` (archive#3752 review, MEDIUM). Anything but a
 * bare authority is refused here, and the caller falls back or fails closed.
 */
function validAuthority(value: string | undefined): string | undefined {
  if (value === undefined || value.length === 0 || value.length > 255) {
    return undefined;
  }
  // Reject the delimiters that make a value more than an authority BEFORE
  // parsing, so nothing depends on how the URL parser chooses to absorb them.
  if (/[@/\\?#,\s]/.test(value)) return undefined;
  let parsed: URL;
  try {
    parsed = new URL(`http://${value}`);
  } catch {
    return undefined;
  }
  // The round trip is the real check: anything the parser normalized away or
  // reinterpreted is not the authority the caller sent.
  return parsed.host === value.toLowerCase() &&
    parsed.username === '' &&
    parsed.password === '' &&
    parsed.pathname === '/' &&
    parsed.search === '' &&
    parsed.hash === ''
    ? value
    : undefined;
}

export interface RuntimeCallerRequest {
  environment: unknown;
  header: (name: string) => string | undefined;
  /**
   * The auth boundary's already-bound principal. Locality is the mint-time
   * `home-possession` stamp, never socket/proxy/credential-kind.
   */
  principal?: RuntimeAuthenticatedRequestPrincipal;
}

/** The local-operator predicate reads only `principal.locality`. */
export interface LocalOperatorRequest {
  principal?: RuntimeAuthenticatedRequestPrincipal;
  /** Ignored. Accepted so a RuntimeCallerRequest still typechecks. */
  environment?: unknown;
  header?: (name: string) => string | undefined;
}

/**
 * Live predicate object so a test can replace `evaluate` and have both
 * {@link isLocalRuntimeCaller} (boundary) and {@link bindRuntimeLocalOperator}
 * (the write diagnostics later reads) move together. Same-file function
 * bindings are not live under `vi.mock`.
 */
export const localRuntimeCaller = {
  evaluate(request: LocalOperatorRequest): boolean {
    return request.principal?.locality === 'home-possession';
  },
};

/**
 * The ONE derivation of "is this caller the local operator?" for
 * unredacted server-log reads. Reads only the mint-time
 * `locality: 'home-possession'` field recorded on the principal.
 * Socket, proxy stamp, pairing source, and credential authority are
 * irrelevant here.
 *
 * Do not reimplement this in a route handler. The auth boundary calls
 * {@link bindRuntimeLocalOperator} once; diagnostics reads the bound
 * flag, not a second call. Replace {@link localRuntimeCaller}.evaluate
 * in a test to prove every consumer moved together.
 */
export function isLocalRuntimeCaller(request: LocalOperatorRequest): boolean {
  return localRuntimeCaller.evaluate(request);
}

/**
 * Auth-boundary write of the one local-operator predicate. Diagnostics
 * and any later consumer must read {@link isBoundRuntimeLocalOperator}
 * rather than calling {@link isLocalRuntimeCaller} again.
 */
export function bindRuntimeLocalOperator(
  request: Request,
  principal:
    | RuntimeAuthenticatedRequestPrincipal
    | undefined = getRuntimeAuthenticatedRequestPrincipal(request),
): boolean {
  const local = localRuntimeCaller.evaluate({ principal });
  boundLocalOperator.set(request, local);
  // The stricter approve-capable flag (archive#3677 PR 3) is bound at the
  // same single write point: local AND minted via the local-grant secret
  // file. A ui-bootstrap mint, the internal-token principal, and every
  // pre-#3677 record (locality with no recorded kind) all bind false —
  // their credentials exist in, or are reachable from, JS contexts where
  // same-origin plugin code runs, so they must not be able to APPROVE.
  boundLocalGrantMintedOperator.set(
    request,
    local && principal?.mintKind === 'local-grant',
  );
  return local;
}

/** Bound by the auth boundary; absent means redact (fail closed). */
export function isBoundRuntimeLocalOperator(request: Request): boolean {
  return boundLocalOperator.get(request) === true;
}

/**
 * The approve-capable local predicate (archive#3677 PR 3): bound true only
 * for a caller whose credential was minted through the LOCAL-GRANT path —
 * the per-boot owner-only secret file that no browser or webview JS can
 * read. This is the authority the native consent broker requires; the
 * read-only local predicate above stays sufficient for log reads. Bound by
 * the same {@link bindRuntimeLocalOperator} write; absent means refuse.
 */
export function isBoundLocalGrantMintedOperator(request: Request): boolean {
  return boundLocalGrantMintedOperator.get(request) === true;
}

/**
 * Same derivation the auth boundary stores as `effectivePeerClass`:
 * attested-proxy verdict when present, otherwise the direct socket peer.
 */
export function classifyRuntimeCallerPeerClass(
  request: RuntimeCallerRequest,
): RuntimePeerClass {
  const socketAddress = getDirectSocketAddress(request.environment);
  const peer = classifyRuntimePeer(socketAddress);
  const proxyCaller = classifyAttestedProxyCaller(request.environment, {
    caller: request.header(INTERNAL_PROXY_CALLER_HEADER),
    token: request.header(INTERNAL_API_TOKEN_HEADER),
  });
  return proxyCaller ?? peer.peerClass;
}

/**
 * Classifies only directly connected local-network peers. Tailnet requires a
 * verified ingress identity and is resolved by the runtime route boundary,
 * never guessed merely from the CGNAT address range.
 */
export function classifyDirectDeviceActivityPeer(
  address: string | undefined,
): Exclude<PairedDeviceLastSeenFrom, 'tailnet'> | undefined {
  const normalized = normalizeSocketAddress(address);
  if (!normalized) return undefined;
  if (classifyRuntimePeer(normalized).peerClass === 'loopback') {
    return 'loopback';
  }
  const v4 = normalized.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.\d{1,3}$/);
  if (v4 && isValidIpv4(normalized)) {
    const first = Number(v4[1]);
    const second = Number(v4[2]);
    if (
      first === 10 ||
      (first === 172 && second >= 16 && second <= 31) ||
      (first === 192 && second === 168) ||
      (first === 169 && second === 254)
    ) {
      return 'lan';
    }
  }
  if (/^(?:fe[89ab]|f[cd][0-9a-f]{2}):/i.test(normalized)) return 'lan';
  return undefined;
}

/** Normalize only the directly connected socket peer. Forwarding headers are intentionally irrelevant. */
export function normalizeSocketAddress(
  address: string | undefined,
): string | undefined {
  if (!address) return undefined;
  let normalized = address.trim().toLowerCase();
  if (!normalized) return undefined;
  if (normalized.startsWith('[') && normalized.endsWith(']')) {
    normalized = normalized.slice(1, -1);
  }
  const zoneIndex = normalized.indexOf('%');
  if (zoneIndex >= 0) normalized = normalized.slice(0, zoneIndex);
  const mapped = normalized.match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/);
  return mapped?.[1] && isValidIpv4(mapped[1]) ? mapped[1] : normalized;
}

function isValidIpv4(address: string): boolean {
  const octets = address.split('.');
  return (
    octets.length === 4 &&
    octets.every((octet) => /^\d{1,3}$/.test(octet) && Number(octet) <= 255)
  );
}

export function classifyRuntimeRoute(
  method: string,
  path: string,
): 'public' | 'protected' {
  return isPublicRuntimeRoute(method, path) ? 'public' : 'protected';
}

export function parseStrictBearer(
  value: string | undefined,
): string | undefined {
  if (!value) return undefined;
  const match = /^Bearer ([^\s,]+)$/.exec(value);
  return match?.[1];
}

interface FailureWindow {
  count: number;
  expiresAt: number;
}

export class RuntimeAuthFailureLimiter {
  readonly #entries = new Map<string, FailureWindow>();
  readonly #now: () => number;
  readonly #maxFailures: number;
  readonly #windowMs: number;
  readonly #maxTrackedPeers: number;

  constructor(
    options: {
      now?: () => number;
      maxFailures?: number;
      windowMs?: number;
      maxTrackedPeers?: number;
    } = {},
  ) {
    this.#now = options.now ?? Date.now;
    this.#maxFailures = Math.max(1, options.maxFailures ?? 10);
    this.#windowMs = Math.max(1, options.windowMs ?? 60_000);
    this.#maxTrackedPeers = Math.max(1, options.maxTrackedPeers ?? 1_024);
  }

  retryAfterSeconds(key: string): number | undefined {
    const now = this.#now();
    const entry = this.#entries.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= now) {
      this.#entries.delete(key);
      return undefined;
    }
    if (entry.count < this.#maxFailures) return undefined;
    return Math.max(1, Math.ceil((entry.expiresAt - now) / 1_000));
  }

  recordFailure(key: string): void {
    const now = this.#now();
    this.#prune(now);
    const current = this.#entries.get(key);
    if (current && current.expiresAt > now) {
      current.count += 1;
      // Refresh insertion order so eviction remains least-recently-used.
      this.#entries.delete(key);
      this.#entries.set(key, current);
      return;
    }
    while (this.#entries.size >= this.#maxTrackedPeers) {
      const oldest = this.#entries.keys().next().value;
      if (oldest === undefined) break;
      this.#entries.delete(oldest);
    }
    this.#entries.set(key, { count: 1, expiresAt: now + this.#windowMs });
  }

  clear(key: string): void {
    this.#entries.delete(key);
  }

  #prune(now: number): void {
    for (const [key, entry] of this.#entries) {
      if (entry.expiresAt <= now) this.#entries.delete(key);
    }
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// Mutation budgets (archive#514): body-size ceilings and per-principal rate
// budgets for authenticated mutations, composed into `configureRuntimeSecurity`
// alongside the auth-failure limiter above. archive#496's route-local Task bounds stay
// as defence in depth; this is the shared layer every product route inherits.
// ═══════════════════════════════════════════════════════════════════════════

const MUTATION_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

export type RuntimeMutationClass =
  | 'unbudgeted'
  | 'streaming'
  | 'standard'
  | 'performance-diagnostic';

/**
 * Authenticated mutation routes that initiate a long-lived streaming response
 * (chat turns, orchestration sends, streaming invokes). These get their own,
 * more generous rate bucket so active chat usage does not collide with — and
 * is not throttled by — the standard mutation budget, and vice versa.
 *
 * Body-size ceilings still apply (a 100 MB chat body is abusive regardless of
 * streaming class); only the rate bucket differs.
 *
 * Every entry is enumerated here rather than matched by a prefix wildcard so
 * the streaming surface is reviewable and cannot grow silently.
 */
const STREAMING_MUTATION_PREFIXES: readonly string[] = [
  // createChatRoutes mounted at /api/agents — the primary chat turn.
  '/api/agents/:slug/chat',
  // createInvokeRoutes mounted at / — the streaming agent invoke.
  '/agents/:slug/invoke/stream',
  // createOrchestrationRoutes mounted at /api/orchestration — foreground chat
  // and its continuation, both of which stream model output back.
  '/api/orchestration/chat',
  '/api/orchestration/chat/:conversationId/continue',
];

/**
 * Authenticated read routes that stream a long-lived SSE response. These are
 * GETs, so they are `'unbudgeted'` purely because a GET is never a mutation
 * (no body, no mutation-rate accounting) — NOT because they appear here. The
 * classifier never consults this constant: unlike its sibling
 * `STREAMING_MUTATION_PREFIXES`, which gates the streaming rate bucket, this
 * list is documentary only. It exists so the unbudgeted SSE read surface stays
 * a reviewed, enumerable decision — and so the per-entry test can pin that
 * documenting a read does NOT exempt a mutating verb on the same path.
 */
export const DOCUMENTED_SSE_READ_SURFACES: readonly string[] = [
  '/events', // createEventRoutes — the primary SSE event stream
  '/api/orchestration/events', // createOrchestrationRoutes — orchestration SSE
  '/monitoring/events', // createMonitoringRoutes — live agent monitoring SSE
  '/scheduler/events', // createSchedulerRoutes — scheduler job output SSE
];

/**
 * Classifies a request for mutation-budget purposes.
 *
 * - `'unbudgeted'` — GET/HEAD/OPTIONS, or a public route. No body-size check,
 *   no rate check. This is where every SSE read surface lands; the
 *   {@link DOCUMENTED_SSE_READ_SURFACES} list above records each one
 *   explicitly (documentary — the classifier never consults it; GETs are
 *   unbudgeted by the non-mutation rule above).
 * - `'streaming'` — a mutating verb on an enumerated streaming surface. Gets
 *   its own rate bucket; body-size ceiling still applies.
 * - `'standard'` — every other mutating verb on a protected route. Body-size +
 *   per-principal rate budget.
 */
export function classifyMutationRoute(
  method: string,
  path: string,
): RuntimeMutationClass {
  if (!MUTATION_METHODS.has(method.toUpperCase())) return 'unbudgeted';
  // Public routes carry no authenticated principal and are never budgeted.
  if (isPublicRuntimeRoute(method, path)) return 'unbudgeted';
  if (matchesStreamingMutation(method.toUpperCase(), path)) return 'streaming';
  return 'standard';
}

function matchesStreamingMutation(method: string, path: string): boolean {
  if (!MUTATION_METHODS.has(method)) return false;
  for (const pattern of STREAMING_MUTATION_PREFIXES) {
    if (pathMatchesRoutePattern(path, pattern)) return true;
  }
  return false;
}

/** Structural segment match: a `:param` segment matches any single path segment. */
function pathMatchesRoutePattern(path: string, pattern: string): boolean {
  const pathSegments = path.split('/').filter(Boolean);
  const patternSegments = pattern.split('/').filter(Boolean);
  return (
    pathSegments.length === patternSegments.length &&
    patternSegments.every(
      (segment, index) =>
        segment.startsWith(':') || segment === pathSegments[index],
    )
  );
}

/** Budget principal source — which verified credential mode derived the key. */
export type BudgetPrincipalSource = 'bearer' | 'session' | 'loopback';

export const BUDGET_PRINCIPAL_VAR = 'stationBudgetPrincipal';

export interface BudgetPrincipal {
  key: string;
  source: BudgetPrincipalSource;
}

/**
 * Derives a budget principal from a server-established authenticated identity.
 * The key is NEVER derived from a caller-supplied header, body field, or query
 * parameter — only from a bearer/device-session credential the middleware has
 * already verified, or from Station's exact per-boot internal proxy token.
 *
 * The raw credential is never used as a key directly: it is SHA-256 hashed and
 * truncated so a budget entry never holds the secret itself.
 *
 * The key follows the CREDENTIAL VALUE, never the transport it arrived on. A
 * bearer token and a device-session cookie holding the same secret resolve to
 * the same budget key, so one credential cannot double its mutation quota by
 * choosing a transport (omitting `Authorization` and sending the cookie
 * instead). `source` is retained on {@link BudgetPrincipal} for telemetry and
 * debug only; it MUST NOT participate in the key — the integration negative
 * control in `runtime/__tests__/runtime-mutation-budget.test.ts` pins that
 * property end to end.
 */
export function deriveBudgetPrincipal(
  source: BudgetPrincipalSource,
  credential?: string,
): BudgetPrincipal {
  // `loopback` names the Station-owned internal caller credential's budget
  // bucket. It never represents an arbitrary credential-less loopback peer.
  if (source === 'loopback') return { key: 'loopback', source };
  if (!credential) {
    // Unreachable given current callers — bearer and session callers reach
    // this only after successful verification. If a future auth mode reaches
    // here without one, fail closed visibly rather than silently merging an
    // unattributable caller into Station's internal-token budget bucket.
    throw new Error(
      `deriveBudgetPrincipal: ${source} source requires a verified credential`,
    );
  }
  // 16 hex chars (64 bits) — more than enough for a budget key with a bounded
  // principal Map, without retaining the credential itself in memory. The
  // `principal:` prefix is transport-neutral: bearer and session share it so
  // the same secret is the same budget however it arrives (see the doc above).
  const digest = createHash('sha256').update(credential).digest('hex');
  return { key: `principal:${digest.slice(0, 16)}`, source };
}

export function setBudgetPrincipal(
  store: { set(key: string, value: unknown): void },
  principal: BudgetPrincipal,
): void {
  store.set(BUDGET_PRINCIPAL_VAR, principal);
}

export function getBudgetPrincipal(store: {
  get(key: string): unknown;
}): BudgetPrincipal | undefined {
  const value = store.get(BUDGET_PRINCIPAL_VAR);
  if (
    typeof value === 'object' &&
    value !== null &&
    'key' in value &&
    typeof (value as BudgetPrincipal).key === 'string'
  ) {
    return value as BudgetPrincipal;
  }
  return undefined;
}

interface MutationWindow {
  standard: number;
  streaming: number;
  performanceDiagnostic: number;
  expiresAt: number;
}

/**
 * Per-principal mutation budget: tracks body-size decisions (stateless) and
 * mutation counts (stateful, LRU-bounded) for both the standard and streaming
 * rate buckets. Mirrors `RuntimeAuthFailureLimiter`'s shape — a private `Map`
 * with an LRU bound, a time window, an injectable `now` for deterministic
 * tests, `#prune` on write, and `retryAfterSeconds` returning `undefined` when
 * under budget.
 */
export class RuntimeMutationBudget {
  readonly #entries = new Map<string, MutationWindow>();
  readonly #now: () => number;
  readonly #maxStandard: number;
  readonly #maxStreaming: number;
  readonly #maxPerformanceDiagnostic: number;
  readonly #windowMs: number;
  readonly #maxPrincipals: number;
  readonly #maxStandardBodyBytes: number;
  readonly #maxStreamingBodyBytes: number;

  constructor(
    options: {
      now?: () => number;
      maxMutationsPerWindow?: number;
      maxStreamingPerWindow?: number;
      maxPerformanceDiagnosticPerWindow?: number;
      mutationWindowMs?: number;
      maxBudgetPrincipals?: number;
      maxMutationBodyBytes?: number;
      maxStreamingBodyBytes?: number;
    } = {},
  ) {
    this.#now = options.now ?? Date.now;
    this.#maxStandard = Math.max(1, options.maxMutationsPerWindow ?? 300);
    this.#maxStreaming = Math.max(1, options.maxStreamingPerWindow ?? 60);
    this.#maxPerformanceDiagnostic = Math.max(
      1,
      // The v3 reference sampling floor drives at most 630 Task-room
      // mutations (typing, cursor, edit-plan, and batch) in one run. Keep a
      // reviewed per-principal ceiling above that fixture, not an exemption.
      options.maxPerformanceDiagnosticPerWindow ?? 768,
    );
    this.#windowMs = Math.max(1, options.mutationWindowMs ?? 60_000);
    this.#maxPrincipals = Math.max(1, options.maxBudgetPrincipals ?? 1_024);
    this.#maxStandardBodyBytes = Math.max(
      1,
      options.maxMutationBodyBytes ?? 1_048_576,
    );
    // archive#1885: the streaming mutation surface is enumerated above, and
    // every entry is a chat/invoke route whose relay body carries
    // base64-expanded attachment data URLs. The contracts layer models the
    // maximum encoded JSON command body — including base64 expansion and
    // metadata across the full attachment allowance — as
    // CHAT_ATTACHMENT_MAX_COMMAND_JSON_BYTES. The streaming body ceiling
    // MUST accommodate that or it rejects bodies the attachment validator
    // already accepted: a ~1.5 MB phone screenshot expands past the former
    // 2 MiB hardcoded default and 413'd mid-flight, in the size range this
    // feature was supposed to fix. Deriving the ceiling from the contract
    // (rather than choosing an independent constant that must agree by
    // coincidence) is what stops the two from drifting again. The
    // relationship is additionally pinned by a test in
    // security/__tests__/runtime-mutation-budget.test.ts.
    this.#maxStreamingBodyBytes = Math.max(
      1,
      options.maxStreamingBodyBytes ?? CHAT_ATTACHMENT_MAX_COMMAND_JSON_BYTES,
    );
  }

  bodyByteCeiling(mutationClass: RuntimeMutationClass): number {
    return mutationClass === 'streaming'
      ? this.#maxStreamingBodyBytes
      : this.#maxStandardBodyBytes;
  }

  /**
   * Returns `Retry-After` seconds if the principal is over budget for the
   * given class, or `undefined` when under budget. The rate check is
   * route-class-scoped: a principal hitting the standard ceiling cannot evade
   * by spreading across protected routes, because the key is the principal
   * (not the route). The streaming bucket is separate and deliberately so —
   * see {@link STREAMING_MUTATION_PREFIXES}.
   */
  retryAfterSeconds(
    principalKey: string,
    mutationClass: RuntimeMutationClass,
  ): number | undefined {
    if (
      mutationClass !== 'standard' &&
      mutationClass !== 'streaming' &&
      mutationClass !== 'performance-diagnostic'
    )
      return undefined;
    const now = this.#now();
    const entry = this.#entries.get(principalKey);
    if (!entry || entry.expiresAt <= now) return undefined;
    const count =
      mutationClass === 'streaming'
        ? entry.streaming
        : mutationClass === 'performance-diagnostic'
          ? entry.performanceDiagnostic
          : entry.standard;
    const max =
      mutationClass === 'streaming'
        ? this.#maxStreaming
        : mutationClass === 'performance-diagnostic'
          ? this.#maxPerformanceDiagnostic
          : this.#maxStandard;
    if (count < max) return undefined;
    return Math.max(1, Math.ceil((entry.expiresAt - now) / 1_000));
  }

  /**
   * Records a mutation attempt against the principal's budget for the given
   * class. Called BEFORE body-size enforcement so that body-size-rejected
   * requests still count toward the rate budget — a flood of oversized POSTs
   * must trip the limiter, not bypass it.
   */
  recordMutation(
    principalKey: string,
    mutationClass: RuntimeMutationClass,
  ): void {
    if (
      mutationClass !== 'standard' &&
      mutationClass !== 'streaming' &&
      mutationClass !== 'performance-diagnostic'
    )
      return;
    const now = this.#now();
    this.#prune(now);
    const current = this.#entries.get(principalKey);
    if (current && current.expiresAt > now) {
      if (mutationClass === 'streaming') current.streaming += 1;
      else if (mutationClass === 'performance-diagnostic')
        current.performanceDiagnostic += 1;
      else current.standard += 1;
      this.#entries.delete(principalKey);
      this.#entries.set(principalKey, current);
      return;
    }
    while (this.#entries.size >= this.#maxPrincipals) {
      const oldest = this.#entries.keys().next().value;
      if (oldest === undefined) break;
      this.#entries.delete(oldest);
    }
    const fresh: MutationWindow = {
      standard: mutationClass === 'standard' ? 1 : 0,
      streaming: mutationClass === 'streaming' ? 1 : 0,
      performanceDiagnostic: mutationClass === 'performance-diagnostic' ? 1 : 0,
      expiresAt: now + this.#windowMs,
    };
    this.#entries.set(principalKey, fresh);
  }

  clearBudget(principalKey: string): void {
    this.#entries.delete(principalKey);
  }

  #prune(now: number): void {
    for (const [key, entry] of this.#entries) {
      if (entry.expiresAt <= now) this.#entries.delete(key);
    }
  }
}

import { createHash } from 'node:crypto';
import { CHAT_ATTACHMENT_MAX_COMMAND_JSON_BYTES } from '@kontourai/station-contracts/chat-attachment';
import type { TenantRequestContext } from '@kontourai/station-contracts/tenancy';
import {
  INTERNAL_API_TOKEN_HEADER,
  INTERNAL_PROXY_CALLER_HEADER,
  INTERNAL_PROXY_FORWARDED_HOST_HEADER,
  INTERNAL_PROXY_PEER_HEADER,
  isTrustedInternalApiToken,
} from '../utils/internal-api-token.js';
import { requiredExternalSurfaceCapability } from './pairing-route-scopes.js';

export interface CurrentRuntimeRequestPrincipalSecurity {
  authorizeCredential(
    credential: string,
    request: { method: string; path: string },
  ): boolean;
  resolveGrantedScope(credential: string): string | undefined;
}

export function isRuntimeRequestPrincipalCurrent(
  request: Request,
  security: CurrentRuntimeRequestPrincipalSecurity,
): boolean {
  const principal = getRuntimeAuthenticatedRequestPrincipal(request);
  if (!principal) return false;
  if (principal.kind === 'internal')
    return isTrustedInternalApiToken(
      request.headers.get(INTERNAL_API_TOKEN_HEADER) ?? undefined,
    );
  const path = new URL(request.url).pathname;
  if (
    !security.authorizeCredential(principal.credential, {
      method: request.method,
      path,
    })
  ) {
    return false;
  }
  // Match ingress exactly: an unmapped capability or a no-longer-granted
  // pairing scope both fail closed at the delayed publication boundary.
  const capability = requiredExternalSurfaceCapability(
    'http',
    request.method,
    path,
  );
  if (capability?.capability !== 'pairing-scope' || !capability.scope)
    return false;
  const grantedScope = security.resolveGrantedScope(principal.credential);
  return (
    grantedScope !== undefined &&
    pairingScopeIncludes(grantedScope, capability.scope)
  );
}
