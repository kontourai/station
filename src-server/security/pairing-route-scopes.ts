/**
 * Scoped pairing (archive#1098): the single route -> required-scope table.
 *
 * Every HTTP mount `configureRuntimeRoutes` registers behind the runtime
 * auth boundary (`runtime-http.ts`), plus the terminal and voice WebSocket
 * upgrade paths, is listed here exactly once. `requiredPairingScope` is the
 * only function anything calls to answer "what scope does this route
 * need?" — never re-derive it ad hoc in a route handler.
 *
 * Fail-closed by design: a method/path this table does not recognize
 * resolves to `undefined`, and every caller (the HTTP middleware, the two
 * WebSocket auth wrappers) treats `undefined` as DENY, not as "no scope
 * required." `src-server/security/__tests__/pairing-route-scopes.test.ts`
 * scans `runtime-routes.ts`'s actual `context.app.route(...)` mounts and
 * asserts every one resolves to a defined scope, so a new authenticated
 * mount that forgets to register here turns that test red. That scan only
 * matches literal `context.app.route('...', ...)` string-literal calls — a
 * future mount registered through a computed/variable base path would not
 * be discovered by it and would need its own explicit coverage assertion.
 *
 * The scope vocabulary is deliberately small — four scopes at archive#1098,
 * a fifth (`inference:invoke`) added by archive#1398 (see
 * `packages/contracts/src/environment-security.ts`) — so the table
 * classifies at route-FAMILY granularity (one entry per mount prefix, split
 * only by read vs. mutate), not per individual endpoint. A new endpoint
 * added under an already-covered prefix inherits that family's tier
 * automatically, the same way an OAuth scope like `repo` covers every
 * endpoint under it without being listed one by one.
 *
 * Family-granularity inheritance is a limitation, not just a convenience:
 * an endpoint can be materially more sensitive than the rest of its family
 * and still silently inherit the family's (lower) tier if nothing overrides
 * it. `requiredPairingScope`'s matcher is longest-prefix-wins, so a leaf
 * entry with a longer, more specific `prefix` than the family's always
 * takes precedence over it for paths under that leaf — see the
 * `GET /api/environments/ssh/sessions` entries below for the worked
 * example: the rest of the `/api/environments/ssh` family (this Station's
 * own SSH profile/connection metadata) stays `orchestration:read`, but that
 * one endpoint aggregates OTHER stations' session titles/projectSlugs/
 * agents/models over SSH transport with a stored outbound peer bearer, so it
 * needs `orchestration:operate` instead —
 * see `docs/security/remote-access-threat-model.md`'s "Cross-station
 * reads" section for the full writeup.
 *
 * archive#1131 closed the coverage gap that made the endpoint above a
 * near-miss instead of a caught bug on the first try: the base-level scan
 * above only proves every mount BASE resolves, so a new LEAF added under an
 * already-covered base was invisible to it. `pairing-route-leaf-scan.ts`
 * now walks every registered leaf (not just mount bases), and
 * `isLeafScopeDeclared` requires each one to resolve through either an
 * `origin: 'explicit'` rule (a human consciously scoped that exact
 * path/family) or a {@link PAIRING_SCOPE_FAMILY_INHERITED_LEAVES} entry (a
 * human looked at that exact leaf and confirmed the family default is
 * fine). See `pairing-route-scopes.test.ts`'s "leaf-level coverage"
 * describe block and `pairing-route-leaf-scan.ts`'s own docblock.
 */
import type { PairingScope } from '@kontourai/station-contracts';
import {
  PAIRING_SCOPE_ACCESS_MANAGE,
  PAIRING_SCOPE_CONSENT_DECIDE,
  PAIRING_SCOPE_HOME_TRANSFER,
  PAIRING_SCOPE_INFERENCE_INVOKE,
  PAIRING_SCOPE_ORCHESTRATION_OPERATE,
  PAIRING_SCOPE_ORCHESTRATION_READ,
  PAIRING_SCOPE_TERMINAL_OPERATE,
  pairingScopeIncludes,
} from '@kontourai/station-contracts';
import { PUBLIC_ANSWER_SHARE_VIEW_PATH } from '@kontourai/station-contracts/answer-share';
import {
  PUBLIC_DEVICE_PAIRING_ACCESS_REQUEST_PATH,
  PUBLIC_DEVICE_PAIRING_API_DOCS_LAUNCH_PATH,
  PUBLIC_DEVICE_PAIRING_EXCHANGE_PATH,
  PUBLIC_DEVICE_PAIRING_LOCAL_GRANT_PATH,
  PUBLIC_DEVICE_PAIRING_LOCAL_GRANT_STARTUP_PROOF_PATH,
  PUBLIC_DEVICE_PAIRING_REQUEST_PATH,
  PUBLIC_DEVICE_PAIRING_UI_BOOTSTRAP_MINT_PATH,
  PUBLIC_DEVICE_PAIRING_UI_BOOTSTRAP_PATH,
  PUBLIC_STATION_HANDSHAKE_PATH,
  PUBLIC_STATION_PROOF_PATH,
} from '@kontourai/station-contracts/environment-security';
import { FLEET_INFERENCE_ROUTE_PREFIX } from '@kontourai/station-contracts/fleet-inference';

const READ_METHODS = ['GET', 'HEAD'] as const;
const MUTATING_METHODS = ['POST', 'PUT', 'PATCH', 'DELETE'] as const;

export interface PairingScopeRouteRule {
  readonly id: string;
  readonly method: 'GET' | 'HEAD' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | '*';
  /** Exact path, or an ancestor of it (`path === prefix || path.startsWith(prefix + '/')`). */
  readonly prefix: string;
  /** Match this parameterized path only; nested future leaves use their family rule. */
  readonly exact?: boolean;
  readonly scope: PairingScope;
  /**
   * archive#1131: `'family'` for a rule generated by the generic
   * read/mutate split over {@link PAIRING_SCOPE_DOMAIN_PREFIXES} — every
   * leaf under it inherits the family's tier by default, without anyone
   * having looked at that specific leaf. `'explicit'` for a rule a human
   * hand-wrote for a specific prefix (the `/api/pairing` single-tier rule,
   * the `/api/environments/ssh/sessions` leaf override below) — any leaf
   * reached through one of these was consciously scoped, whatever it is.
   * `pairing-route-leaf-scan.ts`'s leaf-coverage guard uses this to decide
   * whether a discovered leaf needs its own entry in
   * {@link PAIRING_SCOPE_FAMILY_INHERITED_LEAVES}.
   */
  readonly origin: 'family' | 'explicit';
}

/**
 * One entry per authenticated route-family mount prefix in
 * `configureRuntimeRoutes` (`src-server/runtime/routes/runtime-routes.ts`).
 * Keep this list in sync with that function's `context.app.route(...)`
 * calls — the coverage test enforces it automatically. Public
 * (`/.well-known/station/v1/**`, `/api/system/liveness`) and the terminal /
 * voice WebSocket paths are NOT listed here: the former never reach this
 * table (classified `public` before any scope check), the latter are HTTP
 * upgrades handled by {@link PAIRING_WS_SCOPES} instead.
 */
const PAIRING_SCOPE_DOMAIN_PREFIXES: readonly string[] = [
  '/api/search',
  '/api/models',
  '/api/system',
  '/api/analytics',
  '/api/telemetry',
  '/api/diagnostics',
  '/api/proposed-changes',
  '/api/auth',
  '/api/users',
  '/api/plugins',
  '/api/fs',
  '/api/registry',
  '/agents',
  '/api/skills',
  '/integrations',
  '/events',
  '/api/ui',
  '/api/tasks',
  // Starter Work correlates exact Task, Session, approval, and receipt owners.
  // Catalog/candidate/observation reads inherit read; launch/bind/clear operate.
  '/api/starter-work',
  // Personal spatial-board reads need read; every revisioned mutation needs
  // operate. Hosted execution does not mount this family.
  '/api/spatial-board',
  '/api/orchestration',
  // archive#3677 PR 3: the native consent broker. The FAMILY sits on the
  // ordinary tiers so the local-grant-minted desktop credential (whose scope
  // is the frozen default) can reach it — the routes' REAL gate is
  // `isBoundLocalGrantMintedOperator`, which requires the mint-time
  // `home-possession` stamp AND the `local-grant` mint kind, checked inside
  // each handler and pinned by consent-native-routes.test.ts. Naming the
  // weaker locality-only predicate here would understate what is enforced
  // (review round 2): that one also admits the UI-bootstrap mint, whose
  // credential lives in host-browser JS. A scope above the default tier
  // would refuse the exact caller the surface exists for, while adding no
  // security a remote device does not already lack (its mint never touched
  // the host's filesystem, so it fails the gate whatever its scope).
  '/api/consent',
  // The inbound leaf below has a bespoke HMAC-token authentication contract,
  // but the family still belongs in the pairing-scope inventory. Its explicit
  // external-surface override is narrower and wins for POST /inbound.
  '/api/webhooks',
  '/api/agents',
  '/acp',
  // createInvokeRoutes mounts at '/' with absolute leaf paths — '/invoke'
  // and '/tool-approval' are the two that do not already fall under
  // another listed prefix (their sibling `/agents/:slug/invoke` and
  // `/agents/:slug/tools/:toolName` are already covered by the `/agents`
  // prefix above). archive#1131's leaf-level scan found `/tool-approval`
  // had NO entry at all here — unlike a family-inheritance near-miss, this
  // was a straight coverage gap: every remote-paired credential (including
  // a full-scope operator one) got a fail-closed 403 on
  // `POST /tool-approval/:approvalId` because `requiredPairingScope`
  // resolved `undefined`. archive#2051 requires ordinary protected callers,
  // including direct loopback, to present an explicit credential and run this
  // table. An unmapped route is a loud `route_scope_unmapped` audit line,
  // never a silent bypass.
  '/invoke',
  '/tool-approval',
  '/api/projects',
  '/api/review-evidence',
  '/api/providers',
  '/api/connections',
  '/api/environments/ssh',
  '/api/survey-flow-reviews',
  '/api/diff-comments',
  '/api/knowledge',
  '/api/feature-previews',
  '/api/coding',
  '/api/templates',
  '/config',
  '/bedrock',
  '/api/branding',
  // Best-effort aggregate of existing authenticated boot reads.
  '/api/boot',
  '/monitoring',
  // createOtlpReceiverRoutes mounts at '' with absolute `/v1/*` leaf paths.
  '/v1',
  '/api/conversations',
  '/scheduler',
  '/api/runs',
  '/notifications',
  '/api/attention',
  '/api/action-operations',
  '/api/live-activity',
  '/api/feedback',
  '/api/insights',
  '/api/voice',
  // VoltAgent's framework-owned HTTP/RPC surface. These mount after
  // Station's routes during full-app composition, so they are classified by
  // the same table before the runtime enumeration guard accepts startup.
  '/tools',
  '/workflows',
  '/api/logs',
  '/updates',
  '/api/memory',
  '/observability',
  '/setup-observability',
  '/triggers',
  '/mcp',
  '/a2a',
  '/doc',
  '/ui',
];

/**
 * Bases mounted with `context.app.route('', ...)` or `context.app.route('/', ...)`
 * in `runtime-routes.ts`. Both delegate to sub-routers with their own
 * absolute leaf paths (`/invoke`, `/v1/*`) rather than adding everything
 * under the bare base itself. The root landing route is an explicit rule
 * below; neither base belongs in {@link PAIRING_SCOPE_DOMAIN_PREFIXES}
 * because a generic root family would defeat the fail-closed default.
 */
export const PAIRING_SCOPE_CATCH_ALL_MOUNT_EXCEPTIONS: readonly string[] = [
  '',
  '/',
];

export const PAIRING_SCOPE_ROUTE_TABLE: readonly PairingScopeRouteRule[] = [
  ...[
    '/api/home-authority/channels/:channelId/bindings',
    '/api/home-authority/channels/:channelId/bindings/:controllerDeviceId/inspect',
  ].map(
    (prefix): PairingScopeRouteRule => ({
      id: `${prefix}:administration`,
      method: 'POST',
      prefix,
      exact: true,
      scope: PAIRING_SCOPE_ACCESS_MANAGE,
      origin: 'explicit',
    }),
  ),

  {
    id: '/api/home-authority/channels/:channelId/owner:administration',
    method: 'POST',
    prefix: '/api/home-authority/channels/:channelId/owner',
    exact: true,
    scope: PAIRING_SCOPE_ACCESS_MANAGE,
    origin: 'explicit',
  },
  // Home-authority preparation and transfer participation is a separate,
  // explicitly granted capability. Every present and future method beneath
  // this family stays on that one tier; it does not inherit ordinary
  // orchestration read/operate authority or pairing-management authority.
  {
    id: '/api/home-authority:home-transfer',
    method: '*',
    prefix: '/api/home-authority',
    scope: PAIRING_SCOPE_HOME_TRANSFER,
    origin: 'explicit',
  },
  // Body-shaped reads, including fresh open resolution, have no navigation or mutation effect.
  ...[
    '/api/search',
    '/api/search/resolve-open',
    '/api/search/read-message',
  ].map(
    (prefix): PairingScopeRouteRule => ({
      id: `${prefix}:query`,
      method: 'POST',
      prefix,
      exact: true,
      scope: PAIRING_SCOPE_ORCHESTRATION_READ,
      origin: 'explicit',
    }),
  ),
  ...PAIRING_SCOPE_DOMAIN_PREFIXES.flatMap((prefix) => [
    ...READ_METHODS.map(
      (method): PairingScopeRouteRule => ({
        id: `${prefix}:read`,
        method,
        prefix,
        scope: PAIRING_SCOPE_ORCHESTRATION_READ,
        origin: 'family',
      }),
    ),
    ...MUTATING_METHODS.map(
      (method): PairingScopeRouteRule => ({
        id: `${prefix}:operate`,
        method,
        prefix,
        scope: PAIRING_SCOPE_ORCHESTRATION_OPERATE,
        origin: 'family',
      }),
    ),
  ]),
  // VoltAgent's landing document is a concrete root endpoint, not a catch-all
  // family. Keep it method-specific so an added root mutation remains
  // unclassified until deliberately reviewed.
  {
    id: '/:landing-read',
    method: 'GET',
    prefix: '/',
    scope: PAIRING_SCOPE_ORCHESTRATION_READ,
    origin: 'explicit',
  },
  // The disclosure itself is a read of this Station's published inventory, so
  // a read-only paired device may inspect it. Acknowledging it is different:
  // it authorizes telemetry to leave the operator's machine, so it requires
  // `access:manage`.
  //
  // Be precise about who that is, because archive#1887 documents that this
  // token's holder population is inherited rather than chosen: `access:manage`
  // sits in the frozen `DEFAULT_GRANT_PAIRING_SCOPE` and in NO preset. So the
  // acknowledgement is reachable by the operator credential AND by every
  // default-grant credential — the same-origin continuity browser (which is
  // the first-run surface this disclosure is rendered in, so it must be) and
  // migrated pre-scoping credentials. It is NOT reachable by a device paired
  // through the scoped QR/manual-code flow: neither `read-only` nor `standard`
  // carries the token, so a paired phone cannot consent to egress on the
  // operator's behalf. That is the line this scope is drawn to hold.
  {
    id: '/api/usage-telemetry:disclosure-read',
    method: 'GET',
    prefix: '/api/usage-telemetry',
    scope: PAIRING_SCOPE_ORCHESTRATION_READ,
    origin: 'explicit',
  },
  {
    id: '/api/usage-telemetry/disclosure/acknowledgements:manage',
    method: 'POST',
    prefix: '/api/usage-telemetry/disclosure/acknowledgements',
    scope: PAIRING_SCOPE_ACCESS_MANAGE,
    origin: 'explicit',
  },
  // The preview request uses POST only so the selected file path and line
  // range stay out of URLs and proxies. It is nevertheless a bounded,
  // project-owned read: no mutation, caller-supplied root, or cross-project
  // lookup is available. Override the generic project POST family so a
  // remote read-only paired client can use it without mutation authority.
  {
    id: '/api/projects/:slug/file-preview:read',
    method: 'POST',
    prefix: '/api/projects/:slug/file-preview',
    scope: PAIRING_SCOPE_ORCHESTRATION_READ,
    origin: 'explicit',
  },
  // The attachment handoff is a distinct leaf with an intentionally bounded
  // JSON POST body. Keep its read authority explicit instead of letting a
  // future path or method change silently inherit the preview-family rule.
  {
    id: '/api/projects/:slug/file-preview/download:read',
    method: 'POST',
    prefix: '/api/projects/:slug/file-preview/download',
    scope: PAIRING_SCOPE_ORCHESTRATION_READ,
    origin: 'explicit',
  },
  // Inspection reads a single already-addressed session output. Its event ID
  // is part of the URL and the route requires a strict empty body; it does
  // not mutate owner state. Match only this leaf so any future nested POST
  // remains at the orchestration family operate tier until reviewed.
  {
    id: '/api/orchestration/sessions/:threadId/outputs/:eventId/inspect:read',
    method: 'POST',
    prefix: '/api/orchestration/sessions/:threadId/outputs/:eventId/inspect',
    exact: true,
    scope: PAIRING_SCOPE_ORCHESTRATION_READ,
    origin: 'explicit',
  },
  // Terminal termination kills a PTY process. It must match the dedicated
  // terminal WebSocket's `terminal:operate` authority rather than silently
  // inheriting the broader project mutation tier.
  {
    id: '/api/projects/:slug/terminals/:terminalId:terminal-operate',
    method: 'DELETE',
    prefix: '/api/projects/:slug/terminals/:terminalId',
    scope: PAIRING_SCOPE_TERMINAL_OPERATE,
    origin: 'explicit',
  },
  // A full integration definition can contain command configuration and secret
  // environment variables. The route now omits `env` entirely, but remains at
  // operate as defense in depth: read-only devices use the metadata list and
  // cannot fetch configuration-shaped detail. More-specific read rules keep
  // icons and passive MCP-UI resource resolution available at the family read
  // tier. The embedded dialect is different: fetching it CALLS the selected
  // MCP tool, so method spelling does not make it a read and it requires
  // operate explicitly.
  {
    id: '/integrations/:id:detail-operate',
    method: 'GET',
    prefix: '/integrations/:id',
    scope: PAIRING_SCOPE_ORCHESTRATION_OPERATE,
    origin: 'explicit',
  },
  {
    id: '/integrations/:id/icon:read',
    method: 'GET',
    prefix: '/integrations/:id/icon',
    scope: PAIRING_SCOPE_ORCHESTRATION_READ,
    origin: 'explicit',
  },
  {
    id: '/integrations/:serverId/ui/:toolName:read',
    method: 'GET',
    prefix: '/integrations/:serverId/ui/:toolName',
    scope: PAIRING_SCOPE_ORCHESTRATION_READ,
    origin: 'explicit',
  },
  {
    id: '/integrations/:serverId/ui/:toolName/resource:read',
    method: 'GET',
    prefix: '/integrations/:serverId/ui/:toolName/resource',
    scope: PAIRING_SCOPE_ORCHESTRATION_READ,
    origin: 'explicit',
  },
  {
    id: '/integrations/:serverId/ui/:toolName/embedded:operate',
    method: 'GET',
    prefix: '/integrations/:serverId/ui/:toolName/embedded',
    scope: PAIRING_SCOPE_ORCHESTRATION_OPERATE,
    origin: 'explicit',
  },
  {
    id: '/integrations/:serverId/ui/:toolName/embedded:head-operate',
    method: 'HEAD',
    prefix: '/integrations/:serverId/ui/:toolName/embedded',
    scope: PAIRING_SCOPE_ORCHESTRATION_OPERATE,
    origin: 'explicit',
  },
  // Pairing/device management (archive#1098's access:manage) — every method,
  // one tier. Registered by `configureDevicePairingHostRoutes`, not via
  // `context.app.route`, so it is not in the prefix list above.
  {
    id: '/api/pairing:manage',
    method: '*',
    prefix: '/api/pairing',
    scope: PAIRING_SCOPE_ACCESS_MANAGE,
    origin: 'explicit',
  },
  {
    id: '/api/client-presence/summary:read',
    method: 'GET',
    prefix: '/api/client-presence/summary',
    scope: PAIRING_SCOPE_ORCHESTRATION_READ,
    origin: 'explicit',
  },
  // #944: provider routing mutates an external engine's LLM destination and
  // may spend Station-held credentials in the protocol-required headers.
  // That is credential-management authority, not an ordinary ACP connection
  // mutation: no standard paired-device `orchestration:operate` credential
  // may redirect an engine or cause a stored secret to cross into it.
  ...(['set', 'disable'] as const).map(
    (action): PairingScopeRouteRule => ({
      id: `/acp/connections/:id/providers/${action}:manage`,
      method: 'POST',
      prefix: `/acp/connections/:id/providers/${action}`,
      exact: true,
      scope: PAIRING_SCOPE_ACCESS_MANAGE,
      origin: 'explicit',
    }),
  ),
  // archive#1097 review round 2 (HIGH), owner decision "tighten now, loosen
  // later if wanted": GET /api/environments/ssh/sessions aggregates OTHER
  // connected stations' orchestration session titles/projectSlugs/agents/
  // models across SSH transport. The server presents the stored outbound
  // peer bearer to every protected remote read; a missing/rejected bearer is
  // returned as an actionable authentication-required state — a
  // Read-only-preset device on THIS station has no standing to see that,
  // even though it can read this station's own `/api/orchestration/**`.
  // A longer, more specific `prefix` than the `/api/environments/ssh`
  // family entry above wins under `requiredPairingScope`'s longest-prefix
  // matcher (see the module docblock's "Family-granularity inheritance"
  // note) — this is the leaf override that raises just this endpoint to
  // `orchestration:operate` while the rest of the family stays
  // `orchestration:read`. See
  // `docs/security/remote-access-threat-model.md`'s "Cross-station reads".
  ...READ_METHODS.map(
    (method): PairingScopeRouteRule => ({
      id: `/api/environments/ssh/sessions:${method}`,
      method,
      prefix: '/api/environments/ssh/sessions',
      scope: PAIRING_SCOPE_ORCHESTRATION_OPERATE,
      origin: 'explicit',
    }),
  ),
  // The usage rollup normally reads this Station's own receipts, but its
  // default path also queries configured peer Stations with their stored
  // bearer credentials and returns their environment identities, models, and
  // usage. That is a paired-environment relationship fact, not ordinary local
  // analytics: a standard paired device must not learn which Stations the
  // operator has connected merely because it can read local analytics. Match
  // the fleet receipt leaves below and require the scope that owns peer
  // relationship disclosure. `localOnly=1` is a request option, not a second
  // route capability, so it cannot lower the route's pairing floor.
  {
    id: '/api/analytics/usage-rollup:manage',
    method: 'GET',
    prefix: '/api/analytics/usage-rollup',
    scope: PAIRING_SCOPE_ACCESS_MANAGE,
    origin: 'explicit',
  },
  // archive#3385: the attachment blob route is a single GET leaf, declared
  // explicitly rather than by adding an `/api/attachments` domain prefix. A
  // prefix would classify any future sibling — including a mutating one — at
  // whatever tier the generic read/mutate split produced, with nobody having
  // looked at it. Read tier is right for this one: it is the same tier as the
  // event window that hands the caller the reference in the first place, and
  // the route additionally requires the caller to be able to read a session
  // that references the blob.
  {
    id: '/api/attachments:GET',
    method: 'GET',
    prefix: '/api/attachments',
    scope: PAIRING_SCOPE_ORCHESTRATION_READ,
    origin: 'explicit',
  },
  // archive#4079: the board face (createBoardRoutes, routes/board.ts).
  // Declared as four exact leaves, not an `/api/board` domain prefix — a
  // prefix would give every leaf the SAME family-default tier, hiding that
  // GET and the three mutations are deliberately split. `routes/board.ts`'s
  // own `authorizeReference` gates all four leaves through the identical
  // `canReadSession`/`taskExists` reference check (there is no separate
  // per-session operate-tier authority anywhere in this codebase; see that
  // file's doc comment) — that check stays IN ADDITION to, not replaced by,
  // the pairing-scope tier below.
  //
  // archive#4181 raised the three mutation leaves to `orchestration:operate`
  // to match the sibling `/api/spatial-board` family's mutation leaves,
  // which inherit `orchestration:operate` from the family default (see
  // `PAIRING_SCOPE_DOMAIN_PREFIXES` above). Before this, a paired device
  // holding only a read-scoped credential could reach
  // POST /api/board/pin|unpin|move for any session it could read — a
  // read-only preset device could mutate a board, unlike spatial-board's
  // mutations (archive#4079's honest declaration of `authorizeReference`'s
  // enforcement made that divergence visible rather than causing it). The
  // pairing-scope tier below IS the enforcement — this table drives the HTTP
  // middleware's scope check directly (`runtime-http.ts`'s
  // `configureRuntimeSecurity`, via `EXTERNAL_SURFACE_CAPABILITY_TABLE` and
  // `pairingScopeIncludes`), so raising the declaration here is what makes a
  // read-scoped credential's POST fail closed with 403 `insufficient_scope`
  // before the route handler — and `canReadSession`/`taskExists` — ever run.
  // GET stays `orchestration:read`: it is not the sibling's divergence and
  // this issue does not touch it.
  {
    id: '/api/board:read',
    method: 'GET',
    prefix: '/api/board',
    scope: PAIRING_SCOPE_ORCHESTRATION_READ,
    origin: 'explicit',
  },
  {
    id: '/api/board/pin:operate',
    method: 'POST',
    prefix: '/api/board/pin',
    scope: PAIRING_SCOPE_ORCHESTRATION_OPERATE,
    origin: 'explicit',
  },
  {
    id: '/api/board/unpin:operate',
    method: 'POST',
    prefix: '/api/board/unpin',
    scope: PAIRING_SCOPE_ORCHESTRATION_OPERATE,
    origin: 'explicit',
  },
  {
    id: '/api/board/move:operate',
    method: 'POST',
    prefix: '/api/board/move',
    scope: PAIRING_SCOPE_ORCHESTRATION_OPERATE,
    origin: 'explicit',
  },
  // archive#1398: the two fleet receipt leaves under `/monitoring`
  // serve records that NAME OTHER STATIONS — peer environmentIds, their
  // operator-facing labels, the ids of the models they contribute, and (on
  // the serve side) the fingerprints of the peers that called in. The rest of
  // the `/monitoring` family is this Station talking about itself, so these
  // leaves disclose strictly more than their family and must not inherit its
  // `orchestration:read` tier.
  //
  // Raised to `access:manage`, not `orchestration:operate` (archive#1398
  // security review, M-4). The first cut used the
  // `/api/environments/ssh/sessions` cross-station-read precedent, but that
  // reasoning does not stop where it stopped: the source of this data is the
  // outbound peer registry, and `/api/environments/peers` is gated at
  // `access:manage` precisely because knowing WHICH machines the owner has
  // paired is a relationship fact, not an operational one. At
  // `orchestration:operate` a `standard` or `delegation` preset device — the
  // default pairing preset — could read the fleet's topology here while being
  // refused it at the source, which makes the lower tier the effective one
  // and the higher gate decorative. Fleet membership is disclosed at the tier
  // that owns fleet membership.
  //
  // The receipts themselves are LOCAL-ONLY (§10 OQ-4) and are never served on
  // the peer-facing `/api/inference/**` family. Local UI and CLI callers use
  // their device session or bearer credential, whose grant carries
  // `access:manage`, so raising the tier costs supported local surfaces
  // nothing.
  ...READ_METHODS.flatMap((method): PairingScopeRouteRule[] =>
    [
      '/monitoring/fleet-routing-receipts',
      '/monitoring/fleet-serve-receipts',
    ].map((prefix) => ({
      id: `${prefix}:${method}`,
      method,
      prefix,
      scope: PAIRING_SCOPE_ACCESS_MANAGE,
      origin: 'explicit' as const,
    })),
  ),
  // archive#1423: the operator's answer-share management family. Every
  // method, one tier, the same `access:manage` ceiling `/api/pairing` uses —
  // and for the same reason, stated in one line: minting a share MINTS A
  // CREDENTIAL. It hands a third party durable read access to one of this
  // operator's answers, which is an access-granting act, not an operational
  // one.
  //
  // `access:manage` is the one scope `PAIRING_SCOPE_PRESETS` never grants to
  // any paired device (see that file's preset doc comment: "a paired device,
  // however broadly scoped, can never manage other devices or pairing offers
  // itself"). At the `/api/orchestration` family's `orchestration:operate`
  // tier instead, every `standard`- or `delegation`-preset device — the
  // DEFAULT pairing preset — could mint permanent, third-party-readable links
  // to the operator's answers, and revoke the operator's own. Reading an
  // answer and republishing it to an unbounded audience are not the same
  // authority, and the tier has to say so.
  //
  // GET is not split down to `orchestration:read`: the list names which of
  // this operator's answers have been published and to how many live links.
  // That is the same class of relationship fact `/api/environments/peers`
  // is gated at `access:manage` for, and a read/mutate split here would make
  // the higher gate on the mutation decorative (archive#1398 security review,
  // M-4).
  //
  // The share VIEW route is deliberately absent from this table: it carries
  // no pairing credential at all, is classified `public` in
  // `runtime-request-security.ts`, and authenticates its caller against the
  // share store instead.
  {
    id: '/api/shares:manage',
    method: '*',
    prefix: '/api/shares',
    scope: PAIRING_SCOPE_ACCESS_MANAGE,
    origin: 'explicit',
  },
  // Secret bindings are operator-managed references to credentials. Listing
  // names the available secret backends and grants; binding changes what an
  // MCP child may receive. Every declared leaf therefore has the same
  // access-management ceiling, never the integrations' normal operate tier.
  ...(
    [
      ['GET', '/api/secret-bindings'],
      ['GET', '/api/secret-bindings/integrations/:integrationId'],
      ['GET', '/api/secret-bindings/:id'],
      ['POST', '/api/secret-bindings'],
      ['PUT', '/api/secret-bindings/:id'],
      ['POST', '/api/secret-bindings/:id/revoke'],
      ['POST', '/api/secret-bindings/:id/bind'],
      ['POST', '/api/secret-bindings/:id/unbind'],
      [
        'POST',
        '/api/secret-bindings/integrations/:integrationId/migrate-stored-env',
      ],
      // Compatibility alias; new callers use the unambiguous integration path.
      ['POST', '/api/secret-bindings/:integrationId/migrate-stored-env'],
    ] as const
  ).map(
    ([method, prefix]): PairingScopeRouteRule => ({
      id: `${prefix}:${method}:manage`,
      method,
      prefix,
      scope: PAIRING_SCOPE_ACCESS_MANAGE,
      origin: 'explicit',
    }),
  ),
  // archive#2037: an exact unattended-tool grant changes what a principal may
  // do without a live operator. It is management authority, not ordinary
  // agent execution, so every grant, revoke, and audit-list leaf is raised
  // above the surrounding `/api/agents` family.
  {
    id: '/api/agents/unattended-grants:manage',
    method: '*',
    prefix: '/api/agents/unattended-grants',
    scope: PAIRING_SCOPE_ACCESS_MANAGE,
    origin: 'explicit',
  },
  // Setup import reads a server-owned Codex home and writes the server's
  // local Skill namespace. It is personal configuration authority, never an
  // ordinary paired-device orchestration operation.
  {
    id: '/api/setup-imports:manage',
    method: '*',
    prefix: '/api/setup-imports',
    scope: PAIRING_SCOPE_ACCESS_MANAGE,
    origin: 'explicit',
  },
  {
    id: '/api/pull-requests:read',
    method: 'GET',
    prefix: '/api/pull-requests',
    scope: PAIRING_SCOPE_ORCHESTRATION_READ,
    origin: 'explicit',
  },
  {
    id: '/api/pull-requests:head-read',
    method: 'HEAD',
    prefix: '/api/pull-requests',
    scope: PAIRING_SCOPE_ORCHESTRATION_READ,
    origin: 'explicit',
  },
  {
    id: '/api/pull-requests:manage',
    method: 'POST',
    prefix: '/api/pull-requests',
    scope: PAIRING_SCOPE_ACCESS_MANAGE,
    origin: 'explicit',
  },
  // archive#1131 review round 1 (HIGH, own-audit finding beyond what the
  // reviewer named): `registerPluginHostApprovalRoutes`
  // (`plugin-host-approval-routes.ts`) exists specifically so a 'trusted'
  // -tier plugin permission (e.g. `plugin.server`) can ONLY be granted
  // through what its own sibling handler's error message calls "an
  // isolated host approval channel" — `POST /api/plugins/:name/grant`
  // explicitly 403s any attempt to grant a trusted permission there.
  // Before this entry, `/api/plugins/host-approvals/**` had no override,
  // so it silently inherited the `/api/plugins` family's ordinary mutate
  // tier (`orchestration:operate`) — a tier `PAIRING_SCOPE_PRESETS.standard`
  // (the DEFAULT pairing preset, per
  // `packages/contracts/src/environment-security.ts`) already grants every
  // paired device. That means a merely `standard`-scoped remote device
  // could `POST /api/plugins/host-approvals` to open a trusted-permission
  // request and then `POST .../approve` it itself — self-granting a
  // plugin trusted capability with zero actual host-side (operator)
  // involvement, exactly undoing the isolation `/grant`'s own error
  // message promises. `access:manage` is the one scope
  // `PAIRING_SCOPE_PRESETS` never grants to ANY paired device (see that
  // file's "Read-only"/"Standard" preset doc comment: "a paired device,
  // however broadly scoped, can never manage other devices or pairing
  // offers itself") — reusing it here for the WHOLE `host-approvals`
  // sub-family (not just `/approve`) keeps every leaf under it, including
  // the two GETs, no more reachable than the operator's own local/full
  // credential, matching "isolated" literally. The local approval flow uses
  // an explicit device session or bearer credential and follows this same
  // scope check.
  {
    id: '/api/plugins/host-approvals:manage',
    method: '*',
    prefix: '/api/plugins/host-approvals',
    scope: PAIRING_SCOPE_ACCESS_MANAGE,
    origin: 'explicit',
  },
  // archive#3677 PR 2 review (BLOCKING): the Home role request family is the
  // same shape as host-approvals and needs the same override for the same
  // reason. Without it, `POST /api/plugins/home-role/requests` inherited the
  // family's ordinary mutate tier (`orchestration:operate`, in the standard
  // pairing preset) — and creating a request RETURNS the transaction-bound
  // decision-session cookie, whose entire purpose is to let its bearer
  // decide. Fetch-metadata headers only constrain browsers, so a merely
  // standard-scoped raw HTTP client could mint the cookie, forge the
  // navigation headers against the consent listener, and grant ITSELF the
  // Home role with zero operator involvement. `access:manage` is the one
  // scope no pairing preset ever grants a paired device; the sibling's
  // whole-sub-family treatment applies here identically (the status GET
  // under the prefix rides along — it reveals only pending/decided, but
  // there is no reason a standard device needs even that).
  {
    id: '/api/plugins/home-role/requests:manage',
    method: '*',
    prefix: '/api/plugins/home-role/requests',
    scope: PAIRING_SCOPE_ACCESS_MANAGE,
    origin: 'explicit',
  },
  // archive#1123: `/api/environments/peers/**` reads and writes the
  // outbound peer-credential store — bearer credentials this Station
  // presents to OTHER Stations, plus the leaf that returns one in the
  // clear to an internal caller (see `peer-credential-routes.ts`). Every
  // method, one tier, the same access:manage ceiling `/api/pairing` uses:
  // this is provisioning/admin surface, not something any merely-paired
  // remote device — however broadly scoped — should ever reach. archive#2051
  // sends every ordinary protected caller, including direct loopback and SSH,
  // through this table after credential verification. The only no-scope path
  // is Station's exact internal-token attestation, not an address-derived
  // compatibility exception.
  {
    id: '/api/environments/peers:manage',
    method: '*',
    prefix: '/api/environments/peers',
    scope: PAIRING_SCOPE_ACCESS_MANAGE,
    origin: 'explicit',
  },
  // Credential-profile management can select/import account-scoped app-home
  // material and dispatch a billable verification turn. It is deliberately
  // stricter than the surrounding `/api/connections` family: no paired
  // remote credential, including the standard operate preset, may list,
  // enroll, import, enable automatic recovery, or apply a profile. The
  // `:id` segment is a route parameter, matched structurally below rather
  // than treated as a literal pathname component.
  {
    id: '/api/connections/agent/:id/credential-recovery:manage',
    method: '*',
    prefix: '/api/connections/agent/:id/credential-recovery',
    scope: PAIRING_SCOPE_ACCESS_MANAGE,
    origin: 'explicit',
  },
  // archive#3552: per-account quota. Deliberately the SAME tier as
  // credential-recovery above rather than the surrounding `/api/connections`
  // read tier, for three reasons the family default would have gotten wrong:
  //
  //  1. It ENUMERATES this Station's accounts — the same profile refs and
  //     labels credential-recovery returns, and that rule exists precisely so
  //     no paired remote credential may LIST them. A second reader of the same
  //     store at a weaker scope is a way around that control, not a new
  //     feature.
  //  2. It USES each stored credential to authenticate an outbound request.
  //     `app-home` GET, which does inherit the family tier, only stats a
  //     directory; this one spends the credential.
  //  3. It causes one outbound provider call per account, so a remote caller
  //     could use it to probe or to generate load against the user's accounts.
  //
  // It returns no token and mutates nothing, which is why it is access:manage
  // rather than something stricter still.
  {
    id: '/api/connections/agent/:id/credential-usage:manage',
    method: '*',
    prefix: '/api/connections/agent/:id/credential-usage',
    scope: PAIRING_SCOPE_ACCESS_MANAGE,
    origin: 'explicit',
  },
  // archive#3549: enrolment. Same tier as its two neighbours above, and for a
  // sharper reason than either: it names a filesystem path inside Station's
  // profile store and the exact command that will write a credential into it.
  // That is a recipe for provisioning an account on this host, which no paired
  // remote credential should be able to read — the fact that Station returns
  // the command rather than running it makes the response MORE useful to a
  // remote caller, not less.
  {
    id: '/api/connections/agent/:id/enrolment:manage',
    method: '*',
    prefix: '/api/connections/agent/:id/enrolment',
    scope: PAIRING_SCOPE_ACCESS_MANAGE,
    origin: 'explicit',
  },
  // archive#1398 (docs/design/inference-fleet.md §3.3): the fleet
  // inference family. A NEW TOP-LEVEL PREFIX rather than a leaf under
  // `/api/connections` — deliberately, and the design doc says why: this
  // table classifies at route-FAMILY granularity, so a future endpoint added
  // under a covered prefix silently inherits its family's tier. Hanging
  // inference off `/api/connections` would mean the next `/api/connections`
  // endpoint someone adds inherits `inference:invoke`, or (worse) a future
  // inference endpoint inherits `orchestration:read`. Its own prefix makes
  // "what does this family cost" answerable in one line.
  //
  // Every method, one tier: there is no read/mutate split here because the
  // read (which models does this Station contribute) and the write (generate
  // tokens on one of them) are the SAME disclosure decision — §5.2 rule 2
  // treats a model name as a meaningful signal about hardware class, spend,
  // and what the owner works on, so it is not a lower tier than invoking.
  //
  // `inference:invoke` appears in no preset except `inference` and is absent
  // from `DEFAULT_GRANT_PAIRING_SCOPE`, so no unscoped grant, no migrated
  // pre-scoping credential, and not even the operator bootstrap credential
  // reaches this family without a grant minted for it.
  {
    id: '/api/inference:invoke',
    method: '*',
    prefix: FLEET_INFERENCE_ROUTE_PREFIX,
    scope: PAIRING_SCOPE_INFERENCE_INVOKE,
    origin: 'explicit',
  },
  // archive#1398 §10 OQ-2 / §5.3: raise `GET /api/connections/model-inventory`
  // above its family's `orchestration:read` to `inference:invoke`. Same
  // longest-prefix leaf-override mechanism as the `/api/environments/ssh/
  // sessions` entry above, and the same recorded reasoning: this endpoint
  // enumerates every model this Station can launch, archive#1398 turns that list
  // into a ROUTING INPUT, and "who may enumerate my models" deserves a
  // deliberate answer rather than an inherited one. Tightening now is
  // reversible; discovering the exposure later is not.
  //
  // The PAYLOAD is narrowed in the same change, and that is not optional:
  // raising the tier alone hands the full launchable enumeration to exactly
  // the fleet-peer class the completion route's `model-not-contributed`
  // parity exists to keep from learning what this Station withheld. The leaf
  // now serves the contributed-subset projection
  // (`routes/connections/connections.ts`), the same body as
  // `GET /api/inference/manifest`. Half of §5.3 shipped would have been
  // worse than none of it.
  //
  // Blast radius, enumerated (the §12 item that gated this): the only
  // in-repo HTTP consumers were the SDK's two inventory functions
  // (`packages/sdk/src/query-domains/workspaceConnections.ts`), which had
  // ZERO call sites in this repo — no UI view, no CLI command, no MCP tool,
  // no Playwright spec, no plugin. They are renamed to
  // `fetchContributedModelManifest`/`useContributedModelManifestQuery` so
  // the payload change cannot land as a silent re-type. Local UI follows this
  // same table with its explicit credential. What the raise bites is an
  // out-of-repo SDK embedder holding a `read-only`/`standard`/`delegation`
  // credential; `docs/reference/api.md` records both changes for them.
  //
  // GET/HEAD only, mirroring the ssh/sessions override: an unanticipated
  // mutating method on this path still falls through to the family's own
  // mutate rule (a real scope), never to `undefined`.
  ...READ_METHODS.map(
    (method): PairingScopeRouteRule => ({
      id: `/api/connections/model-inventory:${method}`,
      method,
      prefix: '/api/connections/model-inventory',
      scope: PAIRING_SCOPE_INFERENCE_INVOKE,
      origin: 'explicit',
    }),
  ),
  // Portable Kit discovery exposes only Station's read-only projection, so
  // it deliberately takes the ordinary orchestration read tier. Lifecycle
  // transitions and declared operator actions change host-owned state and
  // therefore require the operate tier. These leaves are explicit rather
  // than silently inheriting `/api/registry`: paired clients must retain
  // access to the new surface, and the split stays reviewable with the
  // contract that makes mutations opt-in and host-approved.
  {
    id: '/api/registry/kits:read',
    method: 'GET',
    prefix: '/api/registry/kits',
    scope: PAIRING_SCOPE_ORCHESTRATION_READ,
    origin: 'explicit',
  },
  {
    id: '/api/registry/kits/:id/layout:read',
    method: 'GET',
    prefix: '/api/registry/kits/:id/layout',
    scope: PAIRING_SCOPE_ORCHESTRATION_READ,
    origin: 'explicit',
  },
  ...['disable', 'enable', 'actions'].map(
    (action): PairingScopeRouteRule => ({
      id: `/api/registry/kits/:id/${action}:operate`,
      method: 'POST',
      prefix: `/api/registry/kits/:id/${action}`,
      scope: PAIRING_SCOPE_ORCHESTRATION_OPERATE,
      origin: 'explicit',
    }),
  ),
];

/**
 * Context key carrying the scope string of the credential a request actually
 * presented, published by `runtime-http.ts`'s auth middleware once it has
 * verified the credential and satisfied the route's own tier.
 *
 * It exists for the narrow class of rule the route TABLE cannot express: a
 * decision that depends on the request BODY as well as the caller's scope
 * (see `PUT /config/app`'s fleet-contribution guard in
 * `routes/system/config.ts`). The middleware must not parse bodies — it would
 * consume the stream and would have to know every route's shape — so the
 * scope travels to the handler instead.
 *
 * **Absent means this handler did not receive a pairing-scoped credential.**
 * The HTTP boundary rejects protected requests before handlers when no bearer,
 * device-session, or exact attested internal credential is present. A rule
 * reading this key can only narrow what an already authenticated caller may
 * do; it must never treat absence as authority.
 */
export const GRANTED_PAIRING_SCOPE_VAR = 'stationGrantedPairingScope';

/**
 * The minimal Hono-context shape the two accessors below need. Declared
 * structurally so this security-layer module never imports Hono's `Context`
 * generics, and so the middleware and the handler agree on one key instead of
 * both spelling a magic string.
 */
export interface PairingScopeContextStore {
  set(key: string, value: unknown): void;
  get(key: string): unknown;
}

export function setGrantedPairingScope(
  context: PairingScopeContextStore,
  scope: string,
): void {
  context.set(GRANTED_PAIRING_SCOPE_VAR, scope);
}

/** The presented credential's scope string, or `undefined` if none was presented. */
export function grantedPairingScope(
  context: PairingScopeContextStore,
): string | undefined {
  const value = context.get(GRANTED_PAIRING_SCOPE_VAR);
  return typeof value === 'string' ? value : undefined;
}

/**
 * The two methods a WebSocket auth wrapper needs, kept structural (not the
 * concrete `EnvironmentSecurityService` type) so this security-layer module
 * never depends on the services layer.
 */
export interface PairingScopeCredentialResolver {
  verifyCredential(credential: string): boolean | Promise<boolean>;
  resolveGrantedScope(
    credential: string,
  ): string | undefined | Promise<string | undefined>;
}

/**
 * Shared by the terminal and voice WebSocket first-frame auth wrappers
 * (`runtime-service-bootstrap.ts`, `runtime-initialize.ts`): a credential
 * must both be valid AND carry `requiredScope` — an invalid credential is
 * rejected before `resolveGrantedScope` is even called (fail fast, and
 * never lets an unresolvable credential probe scope side channels).
 */
export async function credentialAuthorizedForScope(
  resolver: PairingScopeCredentialResolver,
  requiredScope: PairingScope,
  credential: string,
): Promise<boolean> {
  if (!(await resolver.verifyCredential(credential))) return false;
  const scope = await resolver.resolveGrantedScope(credential);
  return scope !== undefined && pairingScopeIncludes(scope, requiredScope);
}

/**
 * Structural resolver for the consent listener's credential check
 * (archive#3677) — the two `EnvironmentSecurityService` methods it needs,
 * kept as an interface so the security layer never depends on the services
 * layer (same posture as {@link PairingScopeCredentialResolver}).
 */
export interface ConsentDecisionCredentialResolver {
  verifyOperatorCredential(candidate: string): boolean;
  identifyDevice(candidate: string): { scope?: string } | null;
}

export type ConsentCredentialAuthority =
  | 'operator-credential'
  | 'device-consent-scope';

/**
 * Who may decide a {@link ConsentTransaction} with a device-session
 * credential (owner decision 1, archive#3677):
 *
 *  - the OPERATOR/local principal — proven by credential identity, NOT by a
 *    scope string. The operator bootstrap credential resolves to the frozen
 *    `DEFAULT_GRANT_PAIRING_SCOPE`, which deliberately never gains
 *    `consent:decide` (widening it would grant consent authority to every
 *    migrated/scope-omitting/continuity credential at once), so a plain
 *    `credentialAuthorizedForScope(..., 'consent:decide', ...)` would refuse
 *    the operator. This is the same enforcement shape `access:approve` uses
 *    in `environment-security-service.ts`'s `authorizeCredential`.
 *  - a paired device whose grant EXPLICITLY carries `consent:decide` —
 *    obtainable only by operator promotion (`PAIRING_SCOPE_GRANT_PATHS`); in
 *    no preset and never inherited.
 *
 * `null` refuses. Transaction-bound consent sessions (`station-consent`) are
 * a third authority verified against the transaction itself, not here.
 */
export function consentDecisionAuthority(
  resolver: ConsentDecisionCredentialResolver,
  credential: string,
): ConsentCredentialAuthority | null {
  if (resolver.verifyOperatorCredential(credential)) {
    return 'operator-credential';
  }
  const scope = resolver.identifyDevice(credential)?.scope;
  if (
    scope !== undefined &&
    pairingScopeIncludes(scope, PAIRING_SCOPE_CONSENT_DECIDE)
  ) {
    return 'device-consent-scope';
  }
  return null;
}

function pathMatchesPrefix(path: string, prefix: string): boolean {
  if (prefix === '') return false;
  if (prefix.includes('/:')) {
    const prefixSegments = prefix.split('/').filter(Boolean);
    const pathSegments = path.split('/').filter(Boolean);
    return (
      pathSegments.length >= prefixSegments.length &&
      prefixSegments.every(
        (segment, index) =>
          segment.startsWith(':') || segment === pathSegments[index],
      )
    );
  }
  return path === prefix || path.startsWith(`${prefix}/`);
}

function pathMatchesExact(path: string, prefix: string): boolean {
  if (prefix.includes('/:')) {
    const prefixSegments = prefix.split('/').filter(Boolean);
    const pathSegments = path.split('/').filter(Boolean);
    return (
      pathSegments.length === prefixSegments.length &&
      prefixSegments.every(
        (segment, index) =>
          segment.startsWith(':') || segment === pathSegments[index],
      )
    );
  }
  return path === prefix;
}

/**
 * archive#2000: the one authoritative classification for every externally
 * reachable Station surface. HTTP entries include ordinary REST, SSE and
 * VoltAgent RPC routes; the two dedicated WebSocket listeners and the
 * token-authenticated station-control MCP endpoint are deliberately visible
 * here too, rather than being undocumented bypasses of the pairing table.
 *
 * `pairing-scope` is enforced by the regular HTTP boundary (or the dedicated
 * WebSocket first-frame check). `public`, `mcp-token`, and `stage-grant` are deliberate
 * alternate authentication contracts, not an absent scope decision.
 * `middleware` records the Hono registrations that are not endpoints; it is
 * intentionally exact so a future `app.all('/new/*', ...)` cannot disappear
 * behind a broad middleware exception in the runtime coverage guard.
 */
export type ExternalSurfaceTransport =
  | 'http'
  | 'terminal-ws'
  | 'voice-ws'
  | 'consent-http';
export type ExternalSurfaceCapability =
  | 'pairing-scope'
  | 'public'
  | 'mcp-token'
  | 'webhook-token'
  | 'stage-grant'
  | 'middleware';

export interface ExternalSurfaceCapabilityRule {
  readonly id: string;
  readonly transport: ExternalSurfaceTransport;
  readonly method:
    | 'GET'
    | 'HEAD'
    | 'POST'
    | 'PUT'
    | 'PATCH'
    | 'DELETE'
    | 'CONNECT'
    | '*';
  readonly prefix: string;
  readonly match: 'exact' | 'prefix';
  readonly capability: ExternalSurfaceCapability;
  readonly scope?: PairingScope;
  /** A concise disclosure for an intentionally unscoped/bespoke surface. */
  readonly reason?: string;
}

const STATION_CONTROL_MCP_ENDPOINT_PATH = '/mcp/station-control';

export const EXTERNAL_SURFACE_CAPABILITY_TABLE: readonly ExternalSurfaceCapabilityRule[] =
  [
    ...PAIRING_SCOPE_ROUTE_TABLE.map((rule) => ({
      ...rule,
      transport: 'http' as const,
      match: rule.exact ? ('exact' as const) : ('prefix' as const),
      capability: 'pairing-scope' as const,
    })),
    // These routes are unauthenticated at the pairing boundary, but each has
    // its own narrow proof, rate limit, loopback-secret, or share-token
    // contract. Keep every exception method-specific and exact.
    {
      id: 'public:station-handshake',
      transport: 'http',
      method: 'GET',
      prefix: PUBLIC_STATION_HANDSHAKE_PATH,
      match: 'exact',
      capability: 'public',
      reason: 'public discovery document',
    },
    {
      id: 'public:station-handshake-head',
      transport: 'http',
      method: 'HEAD',
      prefix: PUBLIC_STATION_HANDSHAKE_PATH,
      match: 'exact',
      capability: 'public',
      reason: 'explicit HEAD semantics for public discovery document',
    },
    {
      id: 'public:station-proof',
      transport: 'http',
      method: 'POST',
      prefix: PUBLIC_STATION_PROOF_PATH,
      match: 'exact',
      capability: 'public',
      reason: 'public challenge proof',
    },
    {
      id: 'public:pairing-local-grant',
      transport: 'http',
      method: 'POST',
      prefix: PUBLIC_DEVICE_PAIRING_LOCAL_GRANT_PATH,
      match: 'exact',
      capability: 'public',
      reason: 'loopback owner-secret pairing grant',
    },
    {
      id: 'public:pairing-local-grant-startup-proof',
      transport: 'http',
      method: 'POST',
      prefix: PUBLIC_DEVICE_PAIRING_LOCAL_GRANT_STARTUP_PROOF_PATH,
      match: 'exact',
      capability: 'public',
      reason: 'loopback owner-secret sidecar startup proof',
    },
    {
      id: 'public:pairing-ui-bootstrap',
      transport: 'http',
      method: 'POST',
      prefix: PUBLIC_DEVICE_PAIRING_UI_BOOTSTRAP_PATH,
      match: 'exact',
      capability: 'public',
      reason: 'single-use launcher UI bootstrap capability',
    },
    {
      id: 'public:pairing-api-docs-launch',
      transport: 'http',
      method: 'GET',
      prefix: PUBLIC_DEVICE_PAIRING_API_DOCS_LAUNCH_PATH,
      match: 'exact',
      capability: 'public',
      reason:
        'direct-loopback launcher page carrying no credential; the capability arrives in its URL fragment',
    },
    {
      id: 'public:pairing-ui-bootstrap-mint',
      transport: 'http',
      method: 'POST',
      prefix: PUBLIC_DEVICE_PAIRING_UI_BOOTSTRAP_MINT_PATH,
      match: 'exact',
      capability: 'public',
      reason: 'direct-loopback owner-secret UI bootstrap capability mint',
    },
    {
      id: 'public:pairing-access-request',
      transport: 'http',
      method: 'POST',
      prefix: PUBLIC_DEVICE_PAIRING_ACCESS_REQUEST_PATH,
      match: 'exact',
      capability: 'public',
      reason: 'browser-origin-bound pairing request',
    },
    {
      id: 'public:pairing-request',
      transport: 'http',
      method: 'POST',
      prefix: PUBLIC_DEVICE_PAIRING_REQUEST_PATH,
      match: 'exact',
      capability: 'public',
      reason: 'public pairing offer request',
    },
    {
      id: 'public:pairing-exchange',
      transport: 'http',
      method: 'POST',
      prefix: PUBLIC_DEVICE_PAIRING_EXCHANGE_PATH,
      match: 'exact',
      capability: 'public',
      reason: 'challenge-bound pairing exchange',
    },
    {
      id: 'public:answer-share-view',
      transport: 'http',
      method: 'POST',
      prefix: PUBLIC_ANSWER_SHARE_VIEW_PATH,
      match: 'exact',
      capability: 'public',
      reason: 'share-token authenticated answer view',
    },
    {
      id: 'public:liveness',
      transport: 'http',
      method: 'GET',
      prefix: '/api/system/liveness',
      match: 'exact',
      capability: 'public',
      reason: 'unauthenticated process liveness probe',
    },
    {
      id: 'public:liveness-head',
      transport: 'http',
      method: 'HEAD',
      prefix: '/api/system/liveness',
      match: 'exact',
      capability: 'public',
      reason: 'explicit HEAD semantics for public liveness probe',
    },
    {
      id: 'mcp-token:station-control',
      transport: 'http',
      method: '*',
      prefix: STATION_CONTROL_MCP_ENDPOINT_PATH,
      match: 'exact',
      capability: 'mcp-token',
      reason: 'per-session station-control MCP token',
    },
    {
      // Do not make an external CI/deploy system a paired device merely to
      // deliver one bounded event. The route itself verifies a named HMAC
      // token, timestamp, and nonce; this explicit leaf overrides the
      // `/api/webhooks` pairing family above by longest prefix.
      id: 'webhook-token:inbound',
      transport: 'http',
      method: 'POST',
      prefix: '/api/webhooks/inbound',
      match: 'exact',
      capability: 'webhook-token',
      reason: 'named HMAC inbound webhook token',
    },
    {
      // The stage grant is complete authority for exactly one short-lived
      // upload. This leaf deliberately bypasses durable Station credentials;
      // its handler validates the stage/method/expiry-bound bearer itself.
      id: 'stage-grant:attachment-upload',
      transport: 'http',
      method: 'PUT',
      prefix: '/api/orchestration/attachment-staging/:stageId',
      match: 'exact',
      capability: 'stage-grant',
      reason: 'single-use attachment stage bearer capability',
    },
    // Hono records middleware in `app.routes` alongside externally reachable
    // endpoints. Classify the exact registrations so the guard can enumerate
    // the real runtime without giving an unknown endpoint a wildcard pass.
    {
      id: 'middleware:runtime-global',
      transport: 'http',
      method: '*',
      prefix: '/*',
      match: 'exact',
      capability: 'middleware',
      reason: 'Hono global middleware registration',
    },
    {
      id: 'middleware:public-cors-wildcard',
      transport: 'http',
      method: '*',
      prefix: '/.well-known/station/v1/*',
      match: 'exact',
      capability: 'middleware',
      reason: 'public discovery CORS middleware registration',
    },
    {
      id: 'middleware:public-cors-root',
      transport: 'http',
      method: '*',
      prefix: '/.well-known/station/v1',
      match: 'exact',
      capability: 'middleware',
      reason: 'public discovery CORS middleware registration',
    },
    {
      id: 'terminal-ws:session',
      transport: 'terminal-ws',
      method: 'CONNECT',
      prefix: '/',
      match: 'exact',
      capability: 'pairing-scope',
      scope: PAIRING_SCOPE_TERMINAL_OPERATE,
    },
    {
      id: 'terminal-ws:health',
      transport: 'terminal-ws',
      method: 'CONNECT',
      prefix: '/__station/health',
      match: 'exact',
      capability: 'public',
      reason: 'listener health close handshake',
    },
    {
      id: 'voice-ws:session',
      transport: 'voice-ws',
      method: 'CONNECT',
      prefix: '/',
      match: 'exact',
      capability: 'pairing-scope',
      scope: PAIRING_SCOPE_ORCHESTRATION_OPERATE,
    },
    {
      id: 'voice-ws:health',
      transport: 'voice-ws',
      method: 'CONNECT',
      prefix: '/__station/health',
      match: 'exact',
      capability: 'public',
      reason: 'listener health close handshake',
    },
    // archive#3677: the distinct-origin consent listener. A separate port,
    // never mounted on the runtime app, so `assertRuntimeHttpRouteCoverage`
    // cannot see it — it is declared here (like the terminal/voice WS
    // listeners) so the consent surface is a documented classification
    // rather than an undocumented bypass, and the listener runs its own
    // coverage assertion against these entries
    // (`src-server/runtime/consent/consent-listener.ts`).
    //
    // Both leaves carry `consent:decide`, but the scope table is only HALF
    // of the listener's authorization: the operator bootstrap credential
    // resolves to the frozen DEFAULT_GRANT_PAIRING_SCOPE (which must never
    // grow), so the listener authorizes the operator by credential identity
    // via {@link consentDecisionAuthority}, mirroring the `access:approve`
    // enforcement precedent in `environment-security-service.ts`.
    {
      id: 'consent-http:review',
      transport: 'consent-http',
      method: 'GET',
      prefix: '/consent/:id',
      match: 'prefix',
      capability: 'pairing-scope',
      scope: PAIRING_SCOPE_CONSENT_DECIDE,
    },
    {
      id: 'consent-http:decide',
      transport: 'consent-http',
      method: 'POST',
      prefix: '/consent/:id/decide',
      match: 'prefix',
      capability: 'pairing-scope',
      scope: PAIRING_SCOPE_CONSENT_DECIDE,
    },
    {
      id: 'consent-http:not-found',
      transport: 'consent-http',
      method: '*',
      prefix: '*',
      match: 'exact',
      capability: 'public',
      reason: 'uniform 404 for undeclared consent-listener paths',
    },
    {
      id: 'consent-http:middleware',
      transport: 'consent-http',
      method: '*',
      prefix: '/*',
      match: 'exact',
      capability: 'middleware',
      reason: 'consent-listener security-header middleware registration',
    },
  ];

function ruleMatchesExternalSurface(
  rule: ExternalSurfaceCapabilityRule,
  method: string,
  path: string,
): boolean {
  if (rule.method !== '*' && rule.method !== method.toUpperCase()) return false;
  return rule.match === 'exact'
    ? exactRoutePathMatches(rule.prefix, path)
    : pathMatchesPrefix(path, rule.prefix);
}

/** Hono's route inventory uses `:param`; live requests contain its value. */
function exactRoutePathMatches(pattern: string, path: string): boolean {
  if (pattern === path) return true;
  const expected = pattern.split('/');
  const actual = path.split('/');
  return (
    expected.length === actual.length &&
    expected.every(
      (segment, index) => segment.startsWith(':') || segment === actual[index],
    )
  );
}

/**
 * Resolves an external route registration or request to its declared
 * capability. `undefined` means there is no approved classification and is
 * always a fail-closed result for callers.
 */
export function requiredExternalSurfaceCapability(
  transport: ExternalSurfaceTransport,
  method: string,
  path: string,
): ExternalSurfaceCapabilityRule | undefined {
  let best: ExternalSurfaceCapabilityRule | undefined;
  for (const rule of EXTERNAL_SURFACE_CAPABILITY_TABLE) {
    if (rule.transport !== transport) continue;
    if (!ruleMatchesExternalSurface(rule, method, path)) continue;
    if (
      !best ||
      rule.prefix.length > best.prefix.length ||
      (rule.prefix.length === best.prefix.length &&
        best.method === '*' &&
        rule.method !== '*')
    ) {
      best = rule;
    }
  }
  return best;
}

function requiredExternalPairingScope(
  transport: ExternalSurfaceTransport,
  method: string,
  path: string,
): PairingScope {
  const rule = requiredExternalSurfaceCapability(transport, method, path);
  if (rule?.capability !== 'pairing-scope' || !rule.scope) {
    throw new Error(
      `Missing pairing-scope classification for ${transport} ${method} ${path}`,
    );
  }
  return rule.scope;
}

/** The dedicated WebSocket servers derive their scopes from the same table. */
export const PAIRING_WS_SCOPES = {
  terminal: requiredExternalPairingScope('terminal-ws', 'CONNECT', '/'),
  voice: requiredExternalPairingScope('voice-ws', 'CONNECT', '/'),
} as const satisfies Record<string, PairingScope>;

export interface RuntimeHttpRouteRegistration {
  readonly method: string;
  readonly path: string;
}

// `app.all()` accepts extension verbs too. The startup guard enumerates the
// standard HTTP methods; runtime-http resolves every actual request method
// before dispatch and rejects an undeclared extension verb (for example,
// PROPFIND) instead of treating `ALL` as a broad authorization grant.
const HonoAllMethods = ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'];

/** Returns every registered Hono route method that lacks a table entry. */
export function findUnclassifiedRuntimeHttpRoutes(
  routes: readonly RuntimeHttpRouteRegistration[],
): string[] {
  const uncovered = new Set<string>();
  for (const route of routes) {
    const methods =
      route.method.toUpperCase() === 'ALL'
        ? HonoAllMethods
        : [route.method.toUpperCase()];
    for (const method of methods) {
      if (!requiredExternalSurfaceCapability('http', method, route.path)) {
        uncovered.add(`${method} ${route.path}`);
      }
    }
  }
  return [...uncovered].sort();
}

/** Startup guard: any new Hono endpoint must be deliberately classified. */
export function assertRuntimeHttpRouteCoverage(
  routes: readonly RuntimeHttpRouteRegistration[],
): void {
  const uncovered = findUnclassifiedRuntimeHttpRoutes(routes);
  if (uncovered.length > 0) {
    throw new Error(
      `Unclassified externally reachable HTTP route(s): ${uncovered.join(', ')}`,
    );
  }
}

/**
 * archive#3677: the consent listener's own coverage guard. The listener is a
 * separate Hono app on its own port, never mounted on the runtime app, so
 * {@link assertRuntimeHttpRouteCoverage} cannot see it — this is its
 * equivalent, run at listener construction against the `consent-http`
 * entries of {@link EXTERNAL_SURFACE_CAPABILITY_TABLE}.
 */
export function assertConsentListenerRouteCoverage(
  routes: readonly RuntimeHttpRouteRegistration[],
): void {
  const uncovered = new Set<string>();
  for (const route of routes) {
    const methods =
      route.method.toUpperCase() === 'ALL'
        ? HonoAllMethods
        : [route.method.toUpperCase()];
    for (const method of methods) {
      if (
        !requiredExternalSurfaceCapability('consent-http', method, route.path)
      ) {
        uncovered.add(`${method} ${route.path}`);
      }
    }
  }
  if (uncovered.size > 0) {
    throw new Error(
      `Unclassified consent-listener route(s): ${[...uncovered].sort().join(', ')}`,
    );
  }
}

/**
 * The rule that would answer a request, or `undefined` when no rule in the
 * table matches — callers MUST treat `undefined` as deny (fail-closed),
 * never as "no scope required." Longest matching prefix wins; ties prefer
 * an exact method match over a `'*'` rule. Exposed (not just the resolved
 * scope) so the leaf-coverage guard (archive#1131) can tell whether the
 * winning rule was hand-written for this path/family (`origin: 'explicit'`)
 * or is a generic family-tier default (`origin: 'family'`) — see
 * {@link PairingScopeRouteRule.origin}.
 */
export function matchPairingScopeRule(
  method: string,
  path: string,
): PairingScopeRouteRule | undefined {
  const normalizedMethod = method.toUpperCase();
  let best: PairingScopeRouteRule | undefined;
  for (const rule of PAIRING_SCOPE_ROUTE_TABLE) {
    if (rule.method !== '*' && rule.method !== normalizedMethod) continue;
    if (
      !(rule.exact
        ? pathMatchesExact(path, rule.prefix)
        : pathMatchesPrefix(path, rule.prefix))
    )
      continue;
    if (
      !best ||
      rule.prefix.length > best.prefix.length ||
      (rule.prefix.length === best.prefix.length &&
        best.method === '*' &&
        rule.method !== '*')
    ) {
      best = rule;
    }
  }
  return best;
}

/**
 * The scope a request needs, or `undefined` when no rule in the table
 * matches — callers MUST treat `undefined` as deny (fail-closed), never as
 * "no scope required."
 */
export function requiredPairingScope(
  method: string,
  path: string,
): PairingScope | undefined {
  return matchPairingScopeRule(method, path)?.scope;
}

/**
 * archive#1131: every leaf `pairing-route-leaf-scan.ts` discovers under an
 * already-covered family prefix (a route reached only through the generic
 * {@link PAIRING_SCOPE_DOMAIN_PREFIXES} read/mutate split, `origin:
 * 'family'`) must appear here — a deliberate, one-line-per-leaf record that
 * a human looked at this exact endpoint and confirmed it is fine to take
 * its family's tier. Seeded 2026-07-28 from the full leaf surface as it
 * existed then (see PR for archive#1131's audit notes on what was checked
 * before seeding); a leaf that is MORE sensitive than its family — e.g. it
 * returns another environment's or another Station's data — needs its own
 * `PairingScopeRouteRule` override instead (see the
 * `/api/environments/ssh/sessions` entry above for the worked example),
 * not an entry here.
 *
 * A leaf reached through an `origin: 'explicit'` rule (a hand-written
 * single-purpose rule, e.g. `/api/pairing`, or the `ssh/sessions` override
 * itself) does NOT need an entry here — that rule is already the deliberate
 * decision.
 */
export interface PairingScopeFamilyInheritedLeaf {
  readonly method: 'GET' | 'HEAD' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  readonly path: string;
}

export const PAIRING_SCOPE_FAMILY_INHERITED_LEAVES: readonly PairingScopeFamilyInheritedLeaf[] =
  [
    // The staging control leaves require the authenticated current owner and
    // expose only that owner's opaque stage metadata. The PUT leaf is NOT in
    // this family list: it has the explicit stage-grant capability above.
    { method: 'GET', path: '/api/orchestration/attachment-staging/capability' },
    { method: 'POST', path: '/api/orchestration/attachment-staging/prepare' },
    { method: 'POST', path: '/api/orchestration/attachment-staging/reconcile' },
    {
      method: 'DELETE',
      path: '/api/orchestration/attachment-staging/:stageId',
    },
    // archive#4075 stage 3 slice 2: the session-agnostic presence roster.
    // It DOES disclose which principal ids currently hold an open
    // `/events` stream (bounded, no session/thread enumeration) — but the
    // family's own `/events` stream, already at this same read tier, is
    // strictly MORE disclosing to the identical caller: personal-mode
    // session reads are `ownerlessSessionAccess: 'single-user-compat'`
    // (`SessionAuthorization.canReadSession`), so any orchestration:read
    // credential already sees full session/turn content for effectively
    // every session on this Station. A roster of who is currently
    // connected is a strict subset of what that same credential already
    // reads, so this takes the family default rather than a raised tier.
    { method: 'GET', path: '/api/orchestration/presence/summary' },
    // Personal task-room reads disclose only the already-paired operator's
    // own task projection. Mutations are closed room commands and inherit
    // orchestration:operate from /api/tasks.
    { method: 'GET', path: '/api/tasks/:taskId/room' },
    { method: 'GET', path: '/api/tasks/:taskId/room/history' },
    { method: 'GET', path: '/api/tasks/:taskId/room/document' },
    { method: 'GET', path: '/api/tasks/:taskId/room/events' },
    // Task Output bytes remain the paired operator's local Task projection;
    // reads use the family read tier and promotion/deletion use operate.
    { method: 'GET', path: '/api/tasks/:taskId/outputs' },
    { method: 'GET', path: '/api/tasks/:taskId/outputs/:outputId' },
    { method: 'GET', path: '/api/tasks/:taskId/outputs/:outputId/content' },
    // An inert, reauthorized terminal-result projection. It omits the
    // protected Session/event tuple and has no greater sensitivity than the
    // Task read family it is mounted under.
    { method: 'GET', path: '/api/tasks/:taskId/tool-result-references' },
    { method: 'GET', path: '/api/tasks/:taskId/gate-evaluation-references' },
    { method: 'POST', path: '/api/tasks/:taskId/outputs' },
    { method: 'DELETE', path: '/api/tasks/:taskId/outputs/:outputId' },
    {
      method: 'POST',
      path: '/api/tasks/:taskId/declared-outputs/:sessionId/:eventId/keep',
    },
    // A Task Basis App open/revoke creates or invalidates a caller-bound
    // occurrence token. It never widens the Task's data scope, but both are
    // mutations and deliberately retain the task family's operate tier.
    { method: 'POST', path: '/api/tasks/:taskId/basis/app-read' },
    { method: 'DELETE', path: '/api/tasks/:taskId/basis/app-read' },
    // The personal Activity roster composes only current, visibility-filtered
    // room publications and an identity-free connected-client aggregate.
    { method: 'GET', path: '/api/live-activity' },
    { method: 'POST', path: '/api/tasks/:taskId/room/messages' },
    { method: 'POST', path: '/api/tasks/:taskId/room/live' },
    // These mutate only the exact task document resolved from the paired
    // caller's request. They mint no cross-environment authority and expose
    // no atom graph, so the normal task operate tier is the intended scope.
    { method: 'POST', path: '/api/tasks/:taskId/room/edit-plan' },
    { method: 'POST', path: '/api/tasks/:taskId/room/batches' },
    // Session output and narrative projections remain bound to the paired
    // caller's own Session. Their GET leaves inherit read; narrative and
    // assessment replacement/removal are owner mutations and inherit operate.
    { method: 'GET', path: '/api/orchestration/sessions/:threadId/outputs' },
    {
      method: 'GET',
      path: '/api/orchestration/sessions/:threadId/turns/:turnId/narrative/target',
    },
    {
      method: 'PUT',
      path: '/api/orchestration/sessions/:threadId/turns/:turnId/narrative',
    },
    {
      method: 'DELETE',
      path: '/api/orchestration/sessions/:threadId/turns/:turnId/narrative',
    },
    {
      method: 'PUT',
      path: '/api/orchestration/sessions/:threadId/turns/:turnId/assessment',
    },
    {
      method: 'DELETE',
      path: '/api/orchestration/sessions/:threadId/turns/:turnId/assessment',
    },
    {
      method: 'GET',
      path: '/api/orchestration/sessions/:threadId/turns/:turnId/assessment/target',
    },
    {
      method: 'GET',
      path: '/api/projects/:slug/flow/runs/:runId/gates/:gateId/evaluations/:evaluationId',
    },
    // prettier-ignore
    { method: 'GET', path: '/acp/connections' },
    { method: 'POST', path: '/acp/connections' },
    { method: 'DELETE', path: '/acp/connections/:id' },
    { method: 'PUT', path: '/acp/connections/:id' },
    { method: 'POST', path: '/acp/connections/:id/reconnect' },
    { method: 'GET', path: '/acp/registry' },
    { method: 'POST', path: '/acp/registry/:id/install' },
    { method: 'GET', path: '/acp/status' },
    { method: 'GET', path: '/agents' },
    { method: 'POST', path: '/agents' },
    // Find-or-create the ONE Agent definition bound to a locally-detected
    // engine connection. It mutates, so it takes the family's operate tier
    // rather than its read tier — and it is strictly LESS powerful than the
    // `POST /agents` immediately above, which already inherits: this one
    // accepts no spec at all, only an `engineId`, and the service refuses any
    // id no registry identity already claims (`UnknownEngineIdentityError`),
    // so a caller cannot mint an arbitrary Agent or name through it. It reads
    // and writes only this Station's own home; it returns no other
    // Environment's or Station's data and crosses no such boundary. Nothing
    // here is more sensitive than the rest of the agent family, so an
    // explicit override would only restate the family decision.
    { method: 'POST', path: '/agents/materialize-engine' },
    { method: 'DELETE', path: '/agents/:slug' },
    { method: 'PUT', path: '/agents/:slug' },
    { method: 'GET', path: '/agents/:slug/conversations' },
    { method: 'DELETE', path: '/agents/:slug/conversations/:conversationId' },
    { method: 'PATCH', path: '/agents/:slug/conversations/:conversationId' },
    // Regeneration reads and writes the same local conversation metadata as
    // PATCH, then asks this Station's configured title generator for a title.
    // It neither grants credentials nor crosses an Environment or Station
    // boundary, so it is no more sensitive than the surrounding conversation
    // mutations and deliberately inherits the agent family's operate scope.
    {
      method: 'POST',
      path: '/agents/:slug/conversations/:conversationId/regenerate-title',
    },
    // A summary is separately stored derived output for a transcript the
    // caller already has access to. Generation uses this Station's configured
    // structure model and does not cross an Environment or Station boundary,
    // so the read/operate family split remains the appropriate scope.
    {
      method: 'GET',
      path: '/agents/:slug/conversations/:conversationId/summary',
    },
    {
      method: 'POST',
      path: '/agents/:slug/conversations/:conversationId/summary',
    },
    {
      method: 'DELETE',
      path: '/agents/:slug/conversations/:conversationId/summary',
    },
    // These toggle local visibility/cache state for the same caller-authorized
    // summary. They are mutation leaves, not a wider conversation disclosure.
    {
      method: 'POST',
      path: '/agents/:slug/conversations/:conversationId/summary/dismiss',
    },
    {
      method: 'POST',
      path: '/agents/:slug/conversations/:conversationId/summary/show',
    },
    {
      method: 'POST',
      path: '/agents/:slug/conversations/:conversationId/context',
    },
    // archive#2463 (fork-and-continue) shipped this leaf without declaring it,
    // leaving the coverage gate red on main. It sits with its family: forking
    // creates a conversation from one this caller can already read, on an agent
    // in the same environment, and returns no other environment's or Station's
    // data — the same sensitivity as PATCH/DELETE and POST /context above.
    {
      method: 'POST',
      path: '/agents/:slug/conversations/:conversationId/fork',
    },
    {
      method: 'GET',
      path: '/agents/:slug/conversations/:conversationId/messages',
    },
    {
      method: 'GET',
      path: '/agents/:slug/conversations/:conversationId/export',
    },
    {
      method: 'GET',
      path: '/agents/:slug/conversations/:conversationId/stats',
    },
    { method: 'GET', path: '/agents/:slug/health' },
    { method: 'POST', path: '/agents/:slug/invoke' },
    { method: 'POST', path: '/agents/:slug/invoke/stream' },
    { method: 'GET', path: '/agents/:slug/tools' },
    { method: 'POST', path: '/agents/:slug/tools' },
    { method: 'DELETE', path: '/agents/:slug/tools/:toolId' },
    { method: 'POST', path: '/agents/:slug/tools/:toolName' },
    { method: 'PUT', path: '/agents/:slug/tools/allowed' },
    { method: 'POST', path: '/agents/:slug/workflows' },
    { method: 'DELETE', path: '/agents/:slug/workflows/:workflowId' },
    { method: 'GET', path: '/agents/:slug/workflows/:workflowId' },
    { method: 'PUT', path: '/agents/:slug/workflows/:workflowId' },
    { method: 'GET', path: '/agents/:slug/workflows/files' },
    { method: 'GET', path: '/api/agents' },
    { method: 'GET', path: '/api/agents/:slug' },
    // Read-only execution-binding metadata for a local agent (slug ->
    // connection/engine id, archive#977's CLI classification lookup): no
    // other environment's or Station's data, no mutation — strictly less
    // sensitive than the sibling reads inherited here. (Merge-gap
    // fix-forward: archive#1142's leaf gate and archive#977's route each landed
    // green on their own base; main is red on the pair.)
    { method: 'GET', path: '/api/agents/:slug/binding' },
    { method: 'POST', path: '/api/agents/:slug/chat' },
    { method: 'GET', path: '/api/analytics/achievements' },
    { method: 'POST', path: '/api/analytics/rescan' },
    { method: 'DELETE', path: '/api/analytics/usage' },
    { method: 'GET', path: '/api/analytics/usage' },
    { method: 'GET', path: '/api/attention' },
    // Action operations are a visibility-filtered status envelope. Creation
    // and settlement remain with the owning domain mutation; cancel inherits
    // the ordinary operation scope.
    { method: 'GET', path: '/api/action-operations' },
    { method: 'GET', path: '/api/action-operations/watch' },
    { method: 'GET', path: '/api/action-operations/:id' },
    { method: 'POST', path: '/api/action-operations/:id/cancel' },
    // Acknowledges an item in this Station's own attention inbox — a mutation
    // on local state with no cross-environment read, so the family default
    // (POST → orchestration:operate) is exactly right.
    { method: 'POST', path: '/api/attention/:id/ack' },
    { method: 'GET', path: '/api/auth/badge-photo/:id' },
    { method: 'POST', path: '/api/auth/renew' },
    // A server-bound, read-only authority fact. The desktop uses an explicit
    // false result to decide whether its own owner-only local-grant exchange
    // should supersede a legacy credential; it does not infer locality.
    { method: 'GET', path: '/api/auth/local-grant-eligibility' },
    { method: 'GET', path: '/api/auth/status' },
    { method: 'POST', path: '/api/auth/terminal' },
    { method: 'GET', path: '/api/branding' },
    { method: 'POST', path: '/api/coding/exec' },
    { method: 'GET', path: '/api/coding/files' },
    { method: 'GET', path: '/api/coding/files/content' },
    { method: 'POST', path: '/api/coding/files/create' },
    { method: 'POST', path: '/api/coding/files/delete' },
    { method: 'POST', path: '/api/coding/files/rename' },
    { method: 'GET', path: '/api/coding/files/search' },
    { method: 'GET', path: '/api/coding/git/branches' },
    { method: 'POST', path: '/api/coding/git/checkout' },
    { method: 'POST', path: '/api/coding/git/commit' },
    { method: 'GET', path: '/api/coding/git/diff' },
    { method: 'GET', path: '/api/coding/git/log' },
    { method: 'POST', path: '/api/coding/git/push' },
    { method: 'GET', path: '/api/coding/git/status' },
    { method: 'GET', path: '/api/coding/repos' },
    { method: 'GET', path: '/api/connections' },
    { method: 'POST', path: '/api/connections' },
    { method: 'DELETE', path: '/api/connections/:id' },
    { method: 'GET', path: '/api/connections/:id' },
    { method: 'GET', path: '/api/connections/:id/quota' },
    { method: 'PUT', path: '/api/connections/:id' },
    { method: 'POST', path: '/api/connections/:id/smoke' },
    { method: 'POST', path: '/api/connections/:id/test' },
    { method: 'DELETE', path: '/api/connections/agent/:id/app-home' },
    { method: 'GET', path: '/api/connections/agent/:id/app-home' },
    { method: 'POST', path: '/api/connections/agent/:id/app-home/import' },
    { method: 'GET', path: '/api/connections/agents' },
    // Read-only catalog of this Station's configured and discoverable runtime
    // adapters. It does not cross an Environment boundary or mutate adapter
    // state, so it inherits the connections family's orchestration:read scope.
    { method: 'GET', path: '/api/connections/agents/catalog' },
    // `GET /api/connections/model-inventory` used to sit here as a
    // family-inherited leaf. Station#1398 §10 OQ-2 gave it an explicit
    // `inference:invoke` override above, and `isLeafScopeDeclared` resolves
    // an `origin: 'explicit'` rule without consulting this list — leaving the
    // entry would assert "a human confirmed the family default is fine for
    // this leaf", which is now the opposite of the decision on record.
    { method: 'GET', path: '/api/connections/models' },
    // Read-only inventory of this Station user's file-backed and
    // orchestration-backed conversations across local agents. It widens the
    // already-classified per-agent conversation list, but does not cross an
    // environment/Station boundary and performs no mutation.
    { method: 'GET', path: '/api/conversations' },
    // Search stays inside this Station and is constrained by the same
    // per-session transcript ACL as the inventory/read routes, so its
    // sensitivity is no greater than the surrounding orchestration-read
    // family.
    { method: 'GET', path: '/api/conversations/search' },
    { method: 'GET', path: '/api/conversations/:id' },
    // Authoritative conversation admission: it reads the same current-session
    // and transcript facts as the ordinary conversation surface and performs
    // no mutation, so it inherits `orchestration:read`.
    { method: 'GET', path: '/api/conversations/:id/open' },
    // Records the caller's own rendered conversation version. It does not
    // expose another Station's data, so the conversations family's normal
    // mutating `orchestration:operate` scope applies.
    { method: 'POST', path: '/api/conversations/:id/acknowledgement' },
    { method: 'GET', path: '/api/diagnostics/bundle' },
    // archive#1896 logging slice 2: server log entries are redacted on
    // egress unless the caller's credential was minted with home-possession
    // (`locality: 'home-possession'` — local-grant secret, or UI-bootstrap
    // exchanged on direct loopback with no proxy). Same pairing-scope
    // tier, never weaker — locality changes redaction, not who may hit
    // the route.
    { method: 'GET', path: '/api/diagnostics/logs' },
    { method: 'GET', path: '/api/diff-comments' },
    { method: 'GET', path: '/api/environments/ssh' },
    { method: 'POST', path: '/api/environments/ssh' },
    { method: 'DELETE', path: '/api/environments/ssh/:id' },
    { method: 'GET', path: '/api/environments/ssh/:id' },
    { method: 'POST', path: '/api/environments/ssh/:id/connect' },
    { method: 'POST', path: '/api/environments/ssh/:id/disconnect' },
    { method: 'GET', path: '/api/environments/ssh/hosts' },
    // Read-only reachability test for a prospective computer: it writes no
    // profile and accepts no host key, but it does make an outbound SSH
    // attempt from this Station, so it stays in the family's operate tier.
    { method: 'POST', path: '/api/environments/ssh/probe' },
    { method: 'POST', path: '/api/feedback/analyze' },
    { method: 'POST', path: '/api/feedback/clear-analysis' },
    { method: 'GET', path: '/api/feedback/guidelines' },
    { method: 'DELETE', path: '/api/feedback/rate' },
    { method: 'POST', path: '/api/feedback/rate' },
    { method: 'GET', path: '/api/feedback/ratings' },
    { method: 'GET', path: '/api/feedback/status' },
    { method: 'POST', path: '/api/feedback/test' },
    { method: 'GET', path: '/api/fs/browse' },
    { method: 'GET', path: '/api/insights' },
    // Integration listing is metadata-only (`requiresEnvSecrets` is a boolean,
    // never the values). CRUD/reconnect, MCP-UI calls, and render-permission
    // changes mutate or execute within this Station and inherit operate.
    // Detail and GET-shaped MCP-UI decisions are explicit rules above.
    { method: 'GET', path: '/integrations' },
    { method: 'POST', path: '/integrations' },
    { method: 'DELETE', path: '/integrations/:id' },
    { method: 'PUT', path: '/integrations/:id' },
    // These lifecycle leaves mutate only this Station's integration definition
    // and live tool projection. They do not read another Environment/Station or
    // reveal secret environment values, so they inherit integration operate.
    { method: 'POST', path: '/integrations/:id/enabled' },
    { method: 'POST', path: '/integrations/:id/oauth/authorize' },
    { method: 'POST', path: '/integrations/:id/oauth/callback' },
    { method: 'POST', path: '/integrations/:id/reconnect' },
    { method: 'POST', path: '/integrations/:id/tools/apply' },
    { method: 'POST', path: '/integrations/:serverId/ui/call' },
    { method: 'POST', path: '/integrations/:serverId/ui/permissions' },
    // Initial App data has no caller-selected arguments and admits only a
    // readOnlyHint tool, but it is still a POST MCP invocation. Preserve the
    // integration family's existing operate tier rather than treating its
    // method spelling as a read-tier override.
    {
      method: 'POST',
      path: '/integrations/:serverId/ui/:toolName/initial-result',
    },
    { method: 'GET', path: '/api/knowledge/adapters' },
    { method: 'POST', path: '/api/knowledge/index/rebuild' },
    { method: 'POST', path: '/api/knowledge/index/search' },
    { method: 'POST', path: '/api/knowledge/migrate' },
    { method: 'GET', path: '/api/knowledge/roots' },
    { method: 'POST', path: '/api/knowledge/roots' },
    { method: 'DELETE', path: '/api/knowledge/roots/:id' },
    {
      method: 'GET',
      path: '/api/knowledge/roots/:rootId/records/:id/source-observation',
    },
    { method: 'GET', path: '/api/knowledge/roots/:rootId/graph' },
    { method: 'GET', path: '/api/knowledge/roots/:rootId/graph/neo4j' },
    { method: 'POST', path: '/api/knowledge/roots/:rootId/graph/neo4j-sync' },
    {
      method: 'GET',
      path: '/api/knowledge/roots/:rootId/graph/neo4j/shortest-path',
    },
    { method: 'GET', path: '/api/knowledge/roots/:rootId/records' },
    { method: 'POST', path: '/api/knowledge/roots/:rootId/records' },
    { method: 'GET', path: '/api/knowledge/roots/:rootId/records/:id' },
    { method: 'POST', path: '/api/knowledge/roots/:rootId/records/:id/links' },
    { method: 'POST', path: '/api/knowledge/roots/validate' },
    { method: 'GET', path: '/api/models' },
    { method: 'GET', path: '/api/models/aws-profiles' },
    { method: 'GET', path: '/api/models/capabilities' },
    { method: 'GET', path: '/api/models/pricing/:modelId' },
    { method: 'POST', path: '/api/orchestration/commands' },
    { method: 'GET', path: '/api/orchestration/commands/receipts' },
    { method: 'GET', path: '/api/orchestration/commands/receipts/:commandId' },
    // Foreground execution has the same authority boundary as durable
    // delegation: both can resolve a target Environment and run an Agent.
    // POST therefore inherits the orchestration family's operate scope.
    { method: 'POST', path: '/api/orchestration/chat' },
    { method: 'POST', path: '/api/orchestration/chat/delegated' },
    { method: 'POST', path: '/api/orchestration/chat/background' },
    {
      method: 'POST',
      path: '/api/orchestration/chat/:conversationId/continue',
    },
    // Conversation handoffs and their receipts/window are confined to this
    // Station's own conversation authority. Starting a handoff mutates that
    // state, so it takes orchestration:operate; the two GET leaves only read
    // the same local handoff/transcript state, so they retain the family's
    // orchestration:read tier. None resolves another Environment or Station.
    {
      method: 'POST',
      path: '/api/orchestration/conversations/:conversationId/handoff',
    },
    {
      method: 'GET',
      path: '/api/orchestration/conversations/:conversationId/handoffs/:idempotencyKey',
    },
    {
      method: 'GET',
      path: '/api/orchestration/conversations/:conversationId/event-window',
    },
    // Context-boundary reservations operate only on the current Station's
    // conversation authority. They neither resolve a peer environment nor
    // expose another Station's data: POST/DELETE mutate the local reservation;
    // GET reads that same tenant-scoped receipt.
    {
      method: 'POST',
      path: '/api/orchestration/conversations/:conversationId/context-boundary',
    },
    {
      method: 'GET',
      path: '/api/orchestration/conversations/:conversationId/context-boundary/:idempotencyKey',
    },
    {
      method: 'DELETE',
      path: '/api/orchestration/conversations/:conversationId/context-boundary/:idempotencyKey',
    },
    { method: 'GET', path: '/api/orchestration/delegations' },
    { method: 'POST', path: '/api/orchestration/delegations' },
    { method: 'GET', path: '/api/orchestration/delegations/:taskId' },
    { method: 'POST', path: '/api/orchestration/delegations/:taskId/continue' },
    { method: 'GET', path: '/api/orchestration/delegations/:taskId/events' },
    {
      method: 'POST',
      path: '/api/orchestration/delegations/:taskId/interrupt',
    },
    { method: 'POST', path: '/api/orchestration/delegations/:taskId/respond' },
    { method: 'POST', path: '/api/orchestration/delegations/options' },
    { method: 'GET', path: '/api/orchestration/events' },
    { method: 'GET', path: '/api/orchestration/processes/terminals' },
    {
      method: 'DELETE',
      path: '/api/orchestration/processes/terminals/:sessionId',
    },
    {
      method: 'GET',
      path: '/api/orchestration/processes/terminals/:sessionId',
    },
    { method: 'GET', path: '/api/orchestration/providers' },
    { method: 'GET', path: '/api/orchestration/providers/:provider/commands' },
    { method: 'GET', path: '/api/orchestration/providers/:provider/models' },
    { method: 'GET', path: '/api/orchestration/runs' },
    { method: 'GET', path: '/api/orchestration/runs/:runId' },
    {
      method: 'GET',
      path: '/api/orchestration/session-board/projects/:projectSlug',
    },
    { method: 'GET', path: '/api/orchestration/sessions' },
    { method: 'GET', path: '/api/orchestration/sessions/:threadId' },
    {
      method: 'GET',
      path: '/api/orchestration/sessions/:threadId/requests/:requestId',
    },
    {
      method: 'GET',
      path: '/api/orchestration/sessions/:threadId/builder-run',
    },
    { method: 'GET', path: '/api/orchestration/sessions/:threadId/event-page' },
    {
      method: 'GET',
      path: '/api/orchestration/sessions/:threadId/event-window',
    },
    { method: 'GET', path: '/api/orchestration/sessions/:threadId/events' },
    { method: 'GET', path: '/api/orchestration/sessions/:threadId/flow-run' },
    // archive#2802: a thread's recorded turn-checkpoint outcomes. Deliberate
    // family inheritance, considered: the records do carry the bound
    // repository's absolute `repoRoot`, but that is STRICTLY LESS path
    // disclosure than the sibling `messages` route at this same tier — a
    // conversation's tool outputs routinely embed arbitrary absolute paths
    // — and `/api/projects` reads already return project workingDirectory
    // paths under their own family read tier. The leaf reads only this
    // Station's own home index (no other environment's or Station's data),
    // never mutates, and is session-read-gated exactly like the siblings
    // above, so `orchestration:read` (the GET family split) is the right
    // tier rather than an override.
    {
      method: 'GET',
      path: '/api/orchestration/sessions/:threadId/checkpoints',
    },
    {
      method: 'POST',
      path: '/api/orchestration/sessions/:threadId/checkpoints/:turnId/restore',
    },
    {
      method: 'GET',
      path: '/api/orchestration/sessions/:threadId/checkpoint-restores',
    },
    { method: 'POST', path: '/api/orchestration/sessions/:threadId/lifecycle' },
    { method: 'GET', path: '/api/orchestration/sessions/:threadId/messages' },
    // Metadata-only Session inventory and each bounded group page retain the
    // exact Session ACL at their route seam. The task-qualified projection
    // and group page also require a Task/Session relation, so all four are
    // consciously reviewed read leaves rather than accidental inheritance:
    // they disclose no transcript, tool arguments/output, reasoning, or data
    // outside the already-authorized Task and Session.
    {
      method: 'GET',
      path: '/api/orchestration/sessions/:threadId/inventory',
    },
    {
      method: 'GET',
      path: '/api/orchestration/sessions/:threadId/inventory/groups/:groupId',
    },
    // Session inventory App open/page/revoke mints and invalidates a
    // caller-bound occurrence. It preserves the same Session ACL at the
    // route seam, while POST/DELETE deliberately retain this family's operate
    // tier rather than treating a capability lifecycle as a cached GET.
    {
      method: 'POST',
      path: '/api/orchestration/sessions/:threadId/inventory/app-read',
    },
    {
      method: 'DELETE',
      path: '/api/orchestration/sessions/:threadId/inventory/app-read',
    },
    // Exact terminal tool output is a bounded, reauthorized orchestration
    // read. Its handler denies hosted fallback and strips owner metadata.
    {
      method: 'GET',
      path: '/api/orchestration/sessions/:threadId/tool-results/:eventId',
    },
    {
      method: 'GET',
      path: '/api/orchestration/sessions/:threadId/turns/:turnId/basis',
    },
    { method: 'GET', path: '/api/orchestration/sessions/loaded' },
    { method: 'GET', path: '/api/orchestration/sessions/read-model' },
    { method: 'GET', path: '/api/projects' },
    { method: 'POST', path: '/api/projects' },
    // Reorders this Station's own project list and returns it. A mutation
    // within its family and no more sensitive than the rest of it: it reads
    // and writes nothing beyond the local ordering, and discloses no peer or
    // other-environment data. It was reachable but undeclared, which the
    // leaf-coverage gate had been failing on.
    { method: 'PUT', path: '/api/projects/order' },
    { method: 'DELETE', path: '/api/projects/:slug' },
    { method: 'GET', path: '/api/projects/:slug' },
    { method: 'PUT', path: '/api/projects/:slug' },
    // archive#1502 — the resolution surface. BOTH of its leaves take
    // the `/api/projects` family tier (read for `resolution`, operate for
    // `bind`) as a RECORDED decision, not by omission.
    //
    // `POST /:slug/bind` is the one worth arguing about: it accepts an
    // arbitrary host path, and its refusals disclose (a) whether that path
    // exists on this machine — 400 `path-not-found` vs a 409 — and (b) the
    // git remote URLs of an arbitrary directory, in the
    // `remotes-do-not-intersect` reason. That is a real disclosure surface.
    // It is NOT a new capability at this tier: `PUT /api/projects/:slug`, the
    // same family and the same `orchestration:operate` scope, already accepts
    // `workingDirectory` as an arbitrary string, and `GET /:slug/resolution`
    // (or any of the pre-existing project reads) then discloses the same two
    // facts about it through the resolver's `missing` and `drifted` reasons.
    // A caller holding this family's operate scope can already perform the
    // probe; these leaves give it a shorter spelling, not new reach.
    //
    // Neither leaf returns another environment's or another Station's data:
    // both answer strictly about THIS Station's own manifest, binding store,
    // and project record. If either ever grew a cross-Station or cross-member
    // answer (archive#1392's membership model is the obvious way), that is the point
    // at which it needs its own `PairingScopeRouteRule` override instead of
    // this entry.
    { method: 'POST', path: '/api/projects/:slug/bind' },
    { method: 'GET', path: '/api/projects/:slug/conversations' },
    { method: 'GET', path: '/api/projects/:slug/diff-comments' },
    { method: 'POST', path: '/api/projects/:slug/diff-comments' },
    { method: 'DELETE', path: '/api/projects/:slug/diff-comments/:id' },
    { method: 'GET', path: '/api/projects/:slug/reviews' },
    { method: 'POST', path: '/api/projects/:slug/reviews' },
    {
      method: 'GET',
      path: '/api/projects/:slug/reviews/requests/:requestId',
    },
    { method: 'GET', path: '/api/projects/:slug/reviews/:receiptId' },
    { method: 'GET', path: '/api/projects/:slug/flow/definitions' },
    { method: 'POST', path: '/api/projects/:slug/flow/init' },
    { method: 'GET', path: '/api/projects/:slug/flow/reviews' },
    { method: 'GET', path: '/api/projects/:slug/flow/runs' },
    { method: 'POST', path: '/api/projects/:slug/flow/runs' },
    { method: 'GET', path: '/api/projects/:slug/flow/runs/:runId' },
    { method: 'GET', path: '/api/projects/:slug/flow/runs/:runId/console' },
    { method: 'POST', path: '/api/projects/:slug/flow/runs/:runId/evaluate' },
    { method: 'POST', path: '/api/projects/:slug/flow/runs/:runId/evidence' },
    {
      method: 'POST',
      path: '/api/projects/:slug/flow/runs/:runId/evidence/command',
    },
    {
      method: 'POST',
      path: '/api/projects/:slug/flow/runs/:runId/evidence/readiness',
    },
    { method: 'POST', path: '/api/projects/:slug/flow/runs/:runId/exception' },
    { method: 'GET', path: '/api/projects/:slug/flow/runs/:runId/report' },
    {
      method: 'POST',
      path: '/api/projects/:slug/flow/runs/:runId/reviews/continue',
    },
    {
      method: 'POST',
      path: '/api/projects/:slug/flow/runs/:runId/reviews/discover',
    },
    { method: 'DELETE', path: '/api/projects/:slug/knowledge' },
    { method: 'GET', path: '/api/projects/:slug/knowledge' },
    { method: 'DELETE', path: '/api/projects/:slug/knowledge/:docId' },
    { method: 'PUT', path: '/api/projects/:slug/knowledge/:docId' },
    { method: 'GET', path: '/api/projects/:slug/knowledge/:docId/content' },
    { method: 'POST', path: '/api/projects/:slug/knowledge/bulk-delete' },
    { method: 'GET', path: '/api/projects/:slug/knowledge/namespaces' },
    { method: 'POST', path: '/api/projects/:slug/knowledge/namespaces' },
    {
      method: 'DELETE',
      path: '/api/projects/:slug/knowledge/namespaces/:nsId',
    },
    { method: 'PUT', path: '/api/projects/:slug/knowledge/namespaces/:nsId' },
    { method: 'DELETE', path: '/api/projects/:slug/knowledge/ns/:namespace' },
    { method: 'GET', path: '/api/projects/:slug/knowledge/ns/:namespace' },
    {
      method: 'DELETE',
      path: '/api/projects/:slug/knowledge/ns/:namespace/:docId',
    },
    {
      method: 'PUT',
      path: '/api/projects/:slug/knowledge/ns/:namespace/:docId',
    },
    {
      method: 'GET',
      path: '/api/projects/:slug/knowledge/ns/:namespace/:docId/content',
    },
    {
      method: 'POST',
      path: '/api/projects/:slug/knowledge/ns/:namespace/bulk-delete',
    },
    {
      method: 'POST',
      path: '/api/projects/:slug/knowledge/ns/:namespace/scan',
    },
    {
      method: 'POST',
      path: '/api/projects/:slug/knowledge/ns/:namespace/search',
    },
    {
      method: 'GET',
      path: '/api/projects/:slug/knowledge/ns/:namespace/status',
    },
    { method: 'GET', path: '/api/projects/:slug/knowledge/ns/:namespace/tree' },
    {
      method: 'POST',
      path: '/api/projects/:slug/knowledge/ns/:namespace/upload',
    },
    { method: 'POST', path: '/api/projects/:slug/knowledge/scan' },
    { method: 'POST', path: '/api/projects/:slug/knowledge/search' },
    { method: 'GET', path: '/api/projects/:slug/knowledge/status' },
    { method: 'GET', path: '/api/projects/:slug/knowledge/tree' },
    { method: 'POST', path: '/api/projects/:slug/knowledge/upload' },
    { method: 'GET', path: '/api/projects/:slug/layouts' },
    // The Pane catalog is a read-only projection of this project's built-in,
    // plugin, and MCP layout inputs. It neither mutates state nor crosses a
    // project/environment boundary beyond the already family-scoped project
    // layout reads, so it deliberately inherits `orchestration:read`.
    { method: 'GET', path: '/api/projects/:slug/panes' },
    { method: 'POST', path: '/api/projects/:slug/layouts' },
    { method: 'DELETE', path: '/api/projects/:slug/layouts/:layoutSlug' },
    { method: 'GET', path: '/api/projects/:slug/layouts/:layoutSlug' },
    { method: 'PUT', path: '/api/projects/:slug/layouts/:layoutSlug' },
    { method: 'POST', path: '/api/projects/:slug/layouts/apply' },
    { method: 'POST', path: '/api/projects/:slug/layouts/from-plugin' },
    { method: 'GET', path: '/api/projects/:slug/operating-state' },
    // archive#3802: added by archive#3798 without a scope decision, which left the
    // leaf scan red for every lane. Classified deliberately rather than to
    // clear the gate: it is a GET returning ONE boolean (`hasBuilderRun`)
    // derived from the workspace the family already resolves from the slug,
    // it mutates nothing, and it refuses hosted callers through the same
    // `hostedRequest` guard as its sibling `GET /operating-state` — which
    // returns the whole derived operating state, so this leaf is strictly
    // less revealing than the family member directly above it.
    {
      method: 'GET',
      path: '/api/projects/:slug/operating-state/availability',
    },
    { method: 'POST', path: '/api/projects/:slug/operating-state/intent' },
    { method: 'GET', path: '/api/projects/:slug/readiness' },
    { method: 'POST', path: '/api/projects/:slug/readiness/init' },
    // archive#1502 — see the `POST /api/projects/:slug/bind` note
    // above for the recorded reasoning covering both leaves.
    { method: 'GET', path: '/api/projects/:slug/resolution' },
    { method: 'GET', path: '/api/projects/:slug/trust-bundles' },
    { method: 'GET', path: '/api/projects/:slug/trust-bundles/:id' },
    { method: 'GET', path: '/api/projects/:slug/work-items' },
    { method: 'GET', path: '/api/projects/:slug/work-items/claim' },
    { method: 'GET', path: '/api/projects/:slug/workflow/tasks' },
    { method: 'GET', path: '/api/projects/:slug/workflow/tasks/:taskSlug' },
    { method: 'GET', path: '/api/projects/icon-candidates' },
    { method: 'GET', path: '/api/projects/layouts/available' },
    { method: 'GET', path: '/api/proposed-changes' },
    { method: 'POST', path: '/api/proposed-changes' },
    { method: 'GET', path: '/api/proposed-changes/:id' },
    { method: 'POST', path: '/api/proposed-changes/:id/approve' },
    { method: 'POST', path: '/api/proposed-changes/:id/reject' },
    { method: 'POST', path: '/api/proposed-changes/bulk/approve' },
    { method: 'POST', path: '/api/proposed-changes/bulk/reject' },
    { method: 'GET', path: '/api/providers' },
    { method: 'POST', path: '/api/providers' },
    { method: 'DELETE', path: '/api/providers/:id' },
    { method: 'PUT', path: '/api/providers/:id' },
    { method: 'GET', path: '/api/providers/:id/health' },
    { method: 'GET', path: '/api/providers/:id/models' },
    { method: 'POST', path: '/api/providers/:id/test' },
    { method: 'POST', path: '/api/providers/:id/test-embedding' },
    { method: 'POST', path: '/api/providers/:id/test-vectordb' },
    { method: 'GET', path: '/api/registry/agents' },
    { method: 'DELETE', path: '/api/registry/agents/:id' },
    { method: 'POST', path: '/api/registry/agents/install' },
    { method: 'GET', path: '/api/registry/agents/installed' },
    { method: 'GET', path: '/api/registry/integrations' },
    { method: 'DELETE', path: '/api/registry/integrations/:id' },
    { method: 'POST', path: '/api/registry/integrations/install' },
    { method: 'GET', path: '/api/registry/integrations/installed' },
    { method: 'POST', path: '/api/registry/integrations/sync' },
    { method: 'GET', path: '/api/registry/layouts' },
    { method: 'DELETE', path: '/api/registry/layouts/:id' },
    { method: 'POST', path: '/api/registry/layouts/:id/disable' },
    { method: 'POST', path: '/api/registry/layouts/:id/enable' },
    { method: 'POST', path: '/api/registry/layouts/:id/install' },
    { method: 'GET', path: '/api/registry/layouts/installed' },
    { method: 'GET', path: '/api/registry/plugins' },
    { method: 'DELETE', path: '/api/registry/plugins/:id' },
    { method: 'POST', path: '/api/registry/plugins/install' },
    { method: 'GET', path: '/api/registry/plugins/installed' },
    { method: 'GET', path: '/api/registry/skills' },
    { method: 'DELETE', path: '/api/registry/skills/:id' },
    { method: 'GET', path: '/api/registry/skills/:id/content' },
    { method: 'POST', path: '/api/registry/skills/:id/update' },
    { method: 'POST', path: '/api/registry/skills/install' },
    { method: 'GET', path: '/api/registry/skills/installed' },
    { method: 'GET', path: '/api/runs' },
    { method: 'GET', path: '/api/runs/:runId' },
    { method: 'POST', path: '/api/runs/output' },
    // Bounded aggregate of this Station's Project-local review receipts. It
    // discloses no peer/environment data and cannot mutate evidence.
    { method: 'GET', path: '/api/review-evidence' },
    { method: 'GET', path: '/api/skills' },
    { method: 'POST', path: '/api/skills' },
    { method: 'DELETE', path: '/api/skills/:name' },
    { method: 'GET', path: '/api/skills/:name' },
    { method: 'PUT', path: '/api/skills/:name' },
    // Usage counters and markdown import for THIS Station's own skills. They
    // write `<home>/skills/.usage.json` and `<home>/skills/<name>/`
    // respectively — no other environment's data, no cross-Station read — so
    // the skills family's operate tier is the intended scope, same as the
    // sibling create/update leaves above.
    { method: 'POST', path: '/api/skills/:name/outcome' },
    { method: 'POST', path: '/api/skills/:name/run' },
    { method: 'POST', path: '/api/skills/import' },
    { method: 'POST', path: '/api/skills/local' },
    { method: 'GET', path: '/api/survey-flow-reviews' },
    { method: 'POST', path: '/api/system/build-updated' },
    { method: 'GET', path: '/api/system/capabilities' },
    { method: 'GET', path: '/api/system/boot-history' },
    { method: 'GET', path: '/api/boot' },
    { method: 'GET', path: '/api/system/core-update' },
    { method: 'GET', path: '/api/system/core-update/restart-status' },
    { method: 'POST', path: '/api/system/core-update' },
    { method: 'GET', path: '/api/system/discover' },
    { method: 'GET', path: '/api/system/identity' },
    { method: 'GET', path: '/api/system/instance' },
    { method: 'POST', path: '/api/system/push-subscribe' },
    { method: 'POST', path: '/api/system/push-unsubscribe' },
    // A diagnostic read of this Station's currently observed CPU utilization.
    // No other Environment's or Station's
    // data, no mutation — no more sensitive than the surrounding `/api/system`
    // reads it inherits the family tier from.
    { method: 'GET', path: '/api/system/resource-posture' },
    { method: 'GET', path: '/api/system/runtime' },
    { method: 'GET', path: '/api/system/skills' },
    { method: 'GET', path: '/api/system/status' },
    { method: 'GET', path: '/api/system/terminal-port' },
    { method: 'GET', path: '/api/system/vapid-public-key' },
    { method: 'POST', path: '/api/system/verify-bedrock' },
    { method: 'POST', path: '/api/system/verify-managed-runtime' },
    { method: 'GET', path: '/api/system/voice-port' },
    { method: 'GET', path: '/api/tasks' },
    { method: 'POST', path: '/api/tasks' },
    { method: 'GET', path: '/api/tasks/:taskId' },
    { method: 'GET', path: '/api/tasks/:taskId/claim' },
    { method: 'POST', path: '/api/tasks/:taskId/dispatch' },
    { method: 'GET', path: '/api/tasks/:taskId/graph' },
    { method: 'POST', path: '/api/tasks/:taskId/references' },
    // Reopens an authorized exact assistant answer. The route deliberately
    // rechecks source-session authority rather than trusting Task graph data.
    { method: 'GET', path: '/api/tasks/:taskId/turn-references' },
    // Basis is an inert composition of the same reauthorized Task/Session
    // facts. It neither mutates nor broadens the task read family's reach.
    { method: 'GET', path: '/api/tasks/:taskId/basis' },
    {
      method: 'GET',
      path: '/api/tasks/:taskId/sessions/:sessionId/inventory',
    },
    {
      method: 'GET',
      path: '/api/tasks/:taskId/sessions/:sessionId/inventory/groups/:groupId',
    },
    // Task-qualified inventory App occurrences are similarly bounded
    // capability lifecycle writes; the exact Task/Session relation is still
    // rechecked by the route and owner module for every read.
    {
      method: 'POST',
      path: '/api/tasks/:taskId/sessions/:sessionId/inventory/app-read',
    },
    {
      method: 'DELETE',
      path: '/api/tasks/:taskId/sessions/:sessionId/inventory/app-read',
    },
    // Reopens one authorized exact authored input; same Task-read tier as
    // answer candidates, with source-session authorization at the route.
    { method: 'GET', path: '/api/tasks/:taskId/user-input-references' },
    // Answer support is an explicit association to an already-authorized
    // answer. Candidate reads retain the Task read tier; mutations require
    // Task operate authority.
    {
      method: 'GET',
      path: '/api/tasks/:taskId/turn-references/:referenceId/support/bundles',
    },
    {
      method: 'GET',
      path: '/api/tasks/:taskId/turn-references/:referenceId/support/bundles/:bundleId/claims',
    },
    {
      method: 'POST',
      path: '/api/tasks/:taskId/turn-references/:referenceId/support',
    },
    {
      method: 'PUT',
      path: '/api/tasks/:taskId/turn-references/:referenceId/support',
    },
    {
      method: 'DELETE',
      path: '/api/tasks/:taskId/turn-references/:referenceId/support',
    },
    { method: 'PATCH', path: '/api/tasks/:taskId/status' },
    { method: 'GET', path: '/api/tasks/sessions/:sessionId/relations' },
    // Exact answer reopen is a bounded, reauthorized orchestration read.
    {
      method: 'GET',
      path: '/api/orchestration/sessions/:threadId/turns/:turnId',
    },
    { method: 'GET', path: '/api/starter-work' },
    { method: 'GET', path: '/api/starter-work/:starterId' },
    { method: 'GET', path: '/api/starter-work/:starterId/candidate' },
    { method: 'POST', path: '/api/starter-work/launch' },
    { method: 'GET', path: '/api/starter-work/:starterId/observation' },
    { method: 'POST', path: '/api/starter-work/bind' },
    { method: 'DELETE', path: '/api/starter-work/:starterId/binding' },
    { method: 'GET', path: '/api/spatial-board' },
    { method: 'GET', path: '/api/spatial-board/resolved' },
    { method: 'POST', path: '/api/spatial-board/pins' },
    { method: 'PUT', path: '/api/spatial-board/pins/:pinId' },
    { method: 'DELETE', path: '/api/spatial-board/pins/:pinId' },
    { method: 'PATCH', path: '/api/spatial-board/title' },
    { method: 'PATCH', path: '/api/spatial-board/camera' },
    { method: 'POST', path: '/api/spatial-board/cleanup' },
    { method: 'POST', path: '/api/spatial-board/undo' },
    { method: 'POST', path: '/api/telemetry/events' },
    { method: 'GET', path: '/api/templates' },
    { method: 'POST', path: '/api/templates' },
    { method: 'DELETE', path: '/api/templates/:id' },
    { method: 'GET', path: '/api/templates/:id' },
    { method: 'POST', path: '/api/ui' },
    { method: 'GET', path: '/api/users/:alias' },
    { method: 'GET', path: '/api/users/search' },
    { method: 'GET', path: '/api/voice/agent' },
    { method: 'POST', path: '/api/voice/sessions' },
    { method: 'DELETE', path: '/api/voice/sessions/:id' },
    { method: 'GET', path: '/api/voice/status' },
    { method: 'GET', path: '/api/feature-previews' },
    { method: 'PUT', path: '/api/feature-previews/:id' },
    { method: 'GET', path: '/bedrock/models' },
    { method: 'GET', path: '/bedrock/models/:modelId' },
    { method: 'GET', path: '/bedrock/models/:modelId/validate' },
    { method: 'GET', path: '/bedrock/pricing' },
    { method: 'GET', path: '/config/app' },
    { method: 'PUT', path: '/config/app' },
    { method: 'GET', path: '/config/app/log-level' },
    { method: 'PUT', path: '/config/app/log-level' },
    { method: 'POST', path: '/config/first-run' },
    { method: 'GET', path: '/events' },
    { method: 'POST', path: '/invoke' },
    { method: 'GET', path: '/monitoring/events' },
    { method: 'GET', path: '/monitoring/metrics' },
    { method: 'GET', path: '/monitoring/stats' },
    { method: 'DELETE', path: '/notifications' },
    { method: 'GET', path: '/notifications' },
    { method: 'POST', path: '/notifications' },
    { method: 'DELETE', path: '/notifications/:id' },
    { method: 'POST', path: '/notifications/:id/action/:actionId' },
    { method: 'POST', path: '/notifications/:id/snooze' },
    { method: 'DELETE', path: '/notifications/activity' },
    { method: 'GET', path: '/notifications/providers' },
    { method: 'GET', path: '/scheduler/events' },
    { method: 'GET', path: '/scheduler/jobs' },
    { method: 'POST', path: '/scheduler/jobs' },
    { method: 'DELETE', path: '/scheduler/jobs/:target' },
    { method: 'PUT', path: '/scheduler/jobs/:target' },
    { method: 'PUT', path: '/scheduler/jobs/:target/disable' },
    { method: 'PUT', path: '/scheduler/jobs/:target/enable' },
    { method: 'GET', path: '/scheduler/jobs/:target/logs' },
    { method: 'POST', path: '/scheduler/jobs/:target/run' },
    // Restarting or resolving a monitor changes this Station's scheduler
    // lifecycle/evidence state; neither crosses an Environment boundary, so
    // both retain the scheduler family's ordinary operate tier.
    { method: 'POST', path: '/scheduler/jobs/:target/monitor/restart' },
    { method: 'POST', path: '/scheduler/jobs/:target/monitor/resolve' },
    { method: 'GET', path: '/scheduler/jobs/preview-schedule' },
    { method: 'GET', path: '/scheduler/providers' },
    { method: 'GET', path: '/scheduler/stats' },
    { method: 'GET', path: '/scheduler/status' },
    { method: 'POST', path: '/scheduler/webhook' },
    { method: 'POST', path: '/tool-approval/:approvalId' },
    { method: 'POST', path: '/v1/agent-events' },
    { method: 'POST', path: '/v1/logs' },
    { method: 'POST', path: '/v1/traces' },
    // archive#1131 review round 1 (HIGH): `createPluginRoutes`
    // (`plugins.ts`) composes five sibling route files by handing each a
    // shared local `const app = new Hono()` — invisible to the scan until
    // this round extended it to follow that `register*Routes(app, deps)`
    // convention. These 24 are the resulting `/api/plugins/**` leaves that
    // are NOT covered by the new `/api/plugins/host-approvals` explicit
    // rule above. Ordinary CRUD/lifecycle leaves (list/install/preview/
    // reload/update/delete a plugin, read or write its settings/overrides/
    // permissions/changelog/providers, serve its bundle) are no more
    // sensitive than the rest of the family — plain family inheritance.
    // Two got individual scrutiny rather than a rubber stamp:
    { method: 'GET', path: '/api/plugins' },
    // archive#3677 PR 3: locality-gated in-handler (see the family comment
    // on PAIRING_SCOPE_DOMAIN_PREFIXES) — the scope tier is deliberately the
    // family default, and the home-possession check is the authority.
    { method: 'GET', path: '/api/consent/native-eligibility' },
    { method: 'POST', path: '/api/consent/requests/:id/native-review' },
    { method: 'POST', path: '/api/consent/requests/:id/native-decide' },
    // archive#3122 stage 3 / archive#3677 PR 2: the Home role's leaves. GET reads a
    // derived status projection (no authority minted); DELETE revokes the
    // role, which only ever returns the root route to the built-in Home —
    // the fail-closed direction — so the family's ordinary mutate tier
    // suffices (the revoke reachability defect is disclosed at the route:
    // archive#3673). The GRANT channel now exists: request creation and the
    // status poll live under `/api/plugins/home-role/requests` and carry the
    // explicit `access:manage` override above — creating a request returns
    // the transaction-bound decision cookie, so it is authority-bearing.
    // Candidates is a read-only eligibility listing (no authority minted,
    // reveals no more than the plugin list) on the family GET tier.
    { method: 'GET', path: '/api/plugins/home-role' },
    { method: 'DELETE', path: '/api/plugins/home-role' },
    { method: 'GET', path: '/api/plugins/home-role/candidates' },
    { method: 'POST', path: '/api/plugins/home-role/requests' },
    { method: 'GET', path: '/api/plugins/home-role/requests/:id' },
    { method: 'GET', path: '/api/plugins/:name/bundle.css' },
    { method: 'GET', path: '/api/plugins/:name/bundle.js' },
    { method: 'GET', path: '/api/plugins/:name/changelog' },
    // POST /api/plugins/:name/grant (plugin-public-routes.ts) grants a
    // plugin permissions — authority-bearing, but the handler itself
    // already refuses (403) any permission whose tier is 'trusted'
    // (`getPermissionTier`, `plugin-permissions.ts`); only 'passive'
    // (auto-grant-eligible) and 'active' ("prompt tier", e.g.
    // `network.fetch`) permissions can be granted here. The family's
    // ordinary mutate tier (`orchestration:operate`) is the SAME tier
    // already required for comparably consequential `standard`-preset
    // actions elsewhere (`POST /api/coding/exec` runs an arbitrary shell
    // command; `POST /api/coding/git/push` pushes to a remote) — granting
    // an already-installed, operator-approved plugin one more
    // non-trusted permission is not more sensitive than those. No
    // override; family-inherited is the considered call here.
    { method: 'POST', path: '/api/plugins/:name/grant' },
    // DELETE /api/plugins/:name/grant (archive#3815) WITHDRAWS permissions.
    // Family-inherited for a different and stronger reason than the POST
    // above: this verb can only narrow what a plugin may do. The question a
    // scope override answers is "could a caller at this tier do something
    // more consequential than the rest of the family?", and taking authority
    // away is the safe direction — a caller who can already operate this
    // Station gains nothing by revoking a plugin's grant. Holding withdrawal
    // to a HIGHER tier than granting would make the dangerous direction the
    // easier one.
    { method: 'DELETE', path: '/api/plugins/:name/grant' },
    { method: 'GET', path: '/api/plugins/:name/overrides' },
    { method: 'PUT', path: '/api/plugins/:name/overrides' },
    { method: 'GET', path: '/api/plugins/:name/permissions' },
    { method: 'GET', path: '/api/plugins/:name/providers' },
    { method: 'GET', path: '/api/plugins/:name/settings' },
    { method: 'PUT', path: '/api/plugins/:name/settings' },
    { method: 'POST', path: '/api/plugins/:name/update' },
    { method: 'GET', path: '/api/plugins/check-updates' },
    // POST /api/plugins/:name/fetch is currently a stub that always 403s
    // ("Plugin fetch proxy is disabled until plugin execution identity is
    // verifiable") — no live behavior to be more sensitive than its
    // family yet; revisit this line when that proxy is actually wired up.
    { method: 'POST', path: '/api/plugins/:name/fetch' },
    { method: 'POST', path: '/api/plugins/fetch' },
    { method: 'POST', path: '/api/plugins/install' },
    { method: 'POST', path: '/api/plugins/preview' },
    { method: 'POST', path: '/api/plugins/reload' },
    { method: 'DELETE', path: '/api/plugins/:name' },
    // app.all('/:name/*', ...) (plugin-public-routes.ts) forwards ANY
    // method into a plugin's OWN registered server module — genuinely
    // method-agnostic (Station's "GET is safe" assumption does not hold
    // for third-party code), so the discovered leaf is expanded to one
    // entry per concrete method (see pairing-route-leaf-scan.ts's
    // ALL_METHOD_EXPANSION) and each needs its own line here rather than
    // one shared verdict. Reasoned as follows rather than table-overridden:
    // a precise scope-table override isn't expressible — the varying
    // `:name` segment sits BEFORE the wildcard tail, so no literal prefix
    // can select "only requests that fall through to this catch-all"
    // without also raising (or missing) its literal-path siblings above
    // (`/:name/grant`, `/:name/settings`, etc., which share the exact same
    // `/api/plugins/<name>/...` shape). The real backstop lives one layer
    // in: reaching this handler at all requires the SAME plugin already
    // holds the 'trusted'-tier `plugin.server` permission
    // (`hasGrant(..., 'plugin.server')`), and 'trusted' permissions can
    // now ONLY be granted through `/api/plugins/host-approvals/**` (see
    // that entry's own comment above) — access:manage-gated, i.e. never
    // reachable by a merely-paired remote device after this PR. So a
    // remote device cannot cause a NEW plugin to become reachable through
    // this catch-all; only a plugin the operator's own local/full
    // credential already approved for server access is exposed here, at
    // the family's ordinary tier. Recommended follow-up (not done here):
    // either give the scope table param-aware/route-order-aware matching,
    // or add a defense-in-depth scope check inline in the handler itself
    // so this doesn't rely solely on the permission subsystem staying
    // correct.
    { method: 'GET', path: '/api/plugins/:name/*' },
    { method: 'HEAD', path: '/api/plugins/:name/*' },
    { method: 'POST', path: '/api/plugins/:name/*' },
    { method: 'PUT', path: '/api/plugins/:name/*' },
    { method: 'PATCH', path: '/api/plugins/:name/*' },
    { method: 'DELETE', path: '/api/plugins/:name/*' },
  ];

/**
 * Leaf-level explicit-declaration check (archive#1131): true when `method`
 * `path` resolves through an `origin: 'explicit'` rule (a human already
 * consciously scoped this exact path/family), or is listed in
 * {@link PAIRING_SCOPE_FAMILY_INHERITED_LEAVES} (a human already looked at
 * this exact leaf and confirmed the family default is fine for it). False
 * for an unmapped path (fail-closed — `matchPairingScopeRule` returned
 * `undefined`) or for a family-governed leaf nobody has declared yet.
 */
export function isLeafScopeDeclared(method: string, path: string): boolean {
  const externalCapability = requiredExternalSurfaceCapability(
    'http',
    method,
    path,
  );
  // Public and dedicated-token routes are deliberate declarations in the
  // central external-surface table, not pairing-scope leaves. Once AST
  // discovery sees them, count that explicit non-pairing classification
  // rather than forcing them into the pairing allowlist too.
  if (externalCapability && externalCapability.capability !== 'pairing-scope') {
    return true;
  }
  const match = matchPairingScopeRule(method, path);
  if (!match) return false;
  if (match.origin === 'explicit') return true;
  const normalizedMethod = method.toUpperCase();
  return PAIRING_SCOPE_FAMILY_INHERITED_LEAVES.some(
    (leaf) => leaf.method === normalizedMethod && leaf.path === path,
  );
}
