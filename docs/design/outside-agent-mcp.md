# Outside-agent MCP with OAuth sign-in

> **Status: design revision 3 (final), 2026-10-24; owner-delegated decisions recorded in section 12. Design only; no implementation or runtime qualification.**
> Owner: Station operator/identity and Station Control maintainers. This proposal
> builds on [operator device access](operator-device-access.md), S3 (#4102) and
> S4 (#4107), merged into main on 2026-10-24 and integrated in this revision
> with `git merge origin/main`. This remains a draft; never rebase it.

## 0. Outcome and boundaries

An agent that Station did not start can connect to a personal Station's HTTP
`/mcp` endpoint, use standard MCP OAuth discovery and sign in once. The operator
approves that client, selects a Project and access level, and can revoke it in
Connections. Read-only is the default; full permits the explicitly listed agent
work operations within that Project. Neither level delegates operator identity,
permission approval, host execution, credential management or another Station.

Approval is a privileged write. The host CLI lists pending requests with their
codes; the operator compares the code with their own browser and approves by
request ID. Alternatively, an existing device-bound operator passkey session requests
and completes S4 per-action step-up on the separate consent origin. Registration,
ordinary paired Devices, deployment login and an operator session alone cannot
approve a client. Revoke and access changes use the same authority boundary.

This is a new inbound OAuth resource. It preserves the internal
`/mcp/station-control` route and the outbound engine OAuth proxy (#4094/#4108).
It adds no deployment-account login, passkey enrollment mechanism or parallel
operator session. Hosted clients may connect to a personal Station; **hosted
Station tenants remain disabled under D11**.

## 1. Components and existing owners

Source was inspected on S4 head `ddee66821fdea2df42289df14f5dc138061371ed`.
Revision 2 rechecks the runtime bind, UI proxy/ingress seams and tool parameter
schemas at `4bd675a4f4c8eba8935949ebae35aeac74dc6bab`. These are source
observations, not executed authentication evidence.
Revision 3 rechecks the conversation message/list/reference-read owners and
request-authority predicate at `ed0e4e26961246b9a38c1b7c29a207144bd1651f`,
and incorporates the owner's third independent review: READY TO IMPLEMENT,
no blockers or majors, with the eight minors resolved below. That verdict is
supplied review evidence, not implementation authorization or runtime proof.
Revisions 1 and 2 incorporate independent reviews supplied by the owner. Their
**EXECUTED** findings used real Claude Code 2.1.308 and Codex 0.163.0 with a stub
OAuth/MCP server and isolated configurations, not Station. Those observations
are attributed evidence, not logins re-executed in this revision:

- Both discover `/.well-known/oauth-protected-resource/mcp`, then AS metadata,
  DCR with `token_endpoint_auth_method: none` and `application_type: native`,
  S256, and `resource` on authorize, code exchange and refresh. Both request
  both advertised scopes despite a read-only challenge.
- Claude Code registers `http://localhost:<ephemeral>/callback`, reuses its saved
  client ID and port until logout, and times out waiting for login at 301 s.
  Access lifetime 300 s caused 8 refreshes per 10 requests; 310 s caused none
  in that sample. The <5-minute refresh threshold motivates section 5.3.
- Codex registers `http://127.0.0.1:<port>/callback` and a new client on every
  login. Version 0.163.0 offers `--oauth-client-registration CIMD`.
- Both completed login using a plain-HTTP `127.0.0.1` issuer. This establishes
  CLI interoperability in that environment, not protocol conformance or safe
  remote exposure. Section 2 records the local-only security rationale and
  standards limitation.

The second review's **EXECUTED** isolated-config runs found three concurrent
Claude processes performing 12 strictly sequential refresh rotations without
re-presenting a predecessor, and three concurrent Codex startups performing
exactly one refresh using lock files. It also observed that `codex mcp add`
starts immediate login and opened a real browser; add has no `--no-browser`.
Both CLIs accepted pre-registered public clients (section 5.1). These are
reviewer-supplied results, not fresh execution or Station qualification here.

M1/M2/M6/M7 and the lost-response/replay consequences are **REASONED** threat or
integration findings; Station end-to-end OAuth remains **NOT_VERIFIED**. The
existing [operator guide](../guides/operator-passkeys.md#enroll) still documents
code-input approval for enrollment. T6/D5's comparison pattern motivates the
new ID-input design; this proposal does not claim that existing command already
implements it. No existing enrollment behavior changes in this design PR.

| Existing seam | Observation and proposed extension |
| --- | --- |
| [ConsentTransactionStore](../../src-server/services/consent/consent-transactions.ts) | Five-minute transactions, render nonces, revalidation and a guarded commit already exist. Add typed outside-client targets to the operator-action checks. |
| [Consent listener](../../src-server/runtime/consent/consent-listener.ts) | S4 checks exact trusted Host/Origin, same-origin Fetch Metadata, initiating session, nonce and a fresh assertion. Reuse its review and decision routes. |
| [Operator sessions](../../src-server/services/identity/operator-sessions.ts) and [operator guide](../guides/operator-passkeys.md) | Device/passkey-bound sessions, 15-minute idle and 12-hour absolute limits. Keep these limits; background status reads never renew activity. |
| [Station Control policy](../../src-server/tools/station-control-policy.ts) and [registry](../../src-server/tools/station-control-mcp-server.ts) | Shared tool implementations have assurance, role and operation policies. The outside catalog is an additional restriction, applied at listing and dispatch. |
| [HTTP MCP route](../../src-server/routes/mcp/station-control-mcp-route.ts) | Internal HTTP MCP has loopback and per-session token checks. Do not widen this route or reuse its credentials. Add a separate inbound router. |
| [Request authority](../../src-server/security/station-control-request-authority.ts) and [caller](../../src-server/runtime/mcp/station-control-caller.ts) | Existing callers derive ownership and Project from Station-started Session records. Add an explicit grant-derived caller variant; never invent an engine Session to obtain authority. |
| [Conversation discovery](../../src-server/routes/chat/conversation-work-search.ts), [conversation admission](../../src-server/routes/chat/conversation-reference-read.ts), [activity](../../src-server/routes/orchestration/session-project-activity.ts) | Discovery already filters by caller and admission before returning content. Extend those admission paths to grant callers, preserving partial/unavailable results. A `projectSlug` filter is not authority. |
| [Conversation message reader](../../src-server/routes/chat/conversation-message-reader.ts), [message/list routes](../../src-server/routes/chat/conversations.ts) and [agent tools](../../src-server/tools/station-control-agent-tools.ts) | `get_conversation_messages` reaches `/:slug/conversations/:conversationId/messages`; `list_conversations` reaches `/:slug/conversations`. The reader's `storeReadable` checks only owner for recognized principal-scoped agents and admits unrecognized callers; listing merges owner-scoped file/native history without a grant Project check. R4c must add stable-Project admission before either source is read/counts are projected, including every lineage Session. |
| [Request-authority predicate](../../src-server/security/station-control-request-authority.ts) and [reference-read admission](../../src-server/routes/chat/conversation-reference-read.ts) | `isPrincipalScopedAgentRequest` recognizes only existing internal caller kinds; the reference route passes no caller to admission for other kinds. Make the outside-caller variant exhaustive in the predicate and reference admission; unknown/missing outside authority refuses, never falls through to a person/operator read. Preserve existing authenticated person/server paths. |
| [Engine OAuth proxy](../../src-server/routes/mcp/engine-oauth-proxy-route.ts) | Station is an OAuth client/proxy for outbound tool access here. The proposed issuer, store, credentials and audience are separate. |
| [Connections guide](../guides/connections.md) and [module map](../architecture/module-map.md) | Add an Outside clients section within the existing Connections surface during implementation. Do not present inbound grants as outbound Engine accounts. |

New components, all proposed:

- **OutsideAgentOAuthService** owns immutable client registrations, pending
  authorization requests, codes, grants, refresh families and revocation state.
- **OutsideAgentMcpRouter** owns `/mcp`, discovery challenges and transport/session
  binding. It reuses Station Control registrations through a grant-aware adapter.
- **OutsideAgentConsentService** builds typed snapshots and commits through the
  same domain methods as the host CLI, under the same mutation lock.
- **OutsideAgentGrantStore** uses `openPrivateSqlite` under
  `<STATION_HOME>/authentication/outside-agent-oauth.sqlite`, mode 0600 in a 0700
  directory. Codes/tokens are verified by hashes only. No encrypted successor
  envelope, recovery key or recoverable token response is stored. No bearer
  appears in app configuration.
- **Connections projection and host commands** show grants and pending requests,
  with server-derived identity and before/after authority. They cannot decide
  from client metadata alone.

## 2. Exposure and origins

Enable explicitly per instance, only after R6's compiled release gate (section
11). Configure one canonical origin `O`, normally HTTPS. A separate explicit
same-machine HTTP opt-in requires a literal `127.0.0.1` or `[::1]` issuer.
The runtime currently defaults to `0.0.0.0` in
[index.ts](../../src-server/index.ts); binding alone cannot establish local-only
requests. For **every request** in the outside OAuth/MCP route family, including
metadata and preflight, loopback HTTP is admitted only if all conditions hold:

- The direct socket peer is exactly `127.0.0.1` or `::1` after IPv4-mapped
  normalization, never any other address in `127/8`; never derive this from headers.
- No `x-station-proxy-*` attestation header and no internal token header
  (`x-station-internal-token`) is present, even if empty or invalid.
- No `forwarded`, `x-forwarded-*`, `x-real-ip` or `tailscale-*` header is present,
  case-insensitively, even if empty.
- Host is present, even for HTTP/1.0, and compared byte-exactly to R's serialized
  authority (HTTP default port 80 means no port in Host). Refuse aliases,
  trailing dots, duplicate/conflicting Host values and alternative spellings.
  If HTTP/2 is ever served, `:authority` and Host must agree; refuse conflicting
  or duplicate values rather than selecting one.

Refuse failing requests before discovery, allocation or token verification.
The [UI proxy](../../packages/cli/src/commands/lifecycle.ts) connects from
loopback, rewrites Host to `127.0.0.1:<upstreamPort>` and adds internal/proxy
attestation; it must fail this predicate. **Forbid adding `/oauth`, `/mcp` or
outside-agent well-known paths to `UI_PROXY_BACKEND_PREFIXES`**, with a regression
test. The existing broad `/.well-known` prefix in
[ui-proxy-prefixes.ts](../../packages/cli/src/commands/ui-proxy-prefixes.ts)
already forwards discovery: add explicit outside-path exclusions before that
prefix matches, test them, and retain other discovery routes.

At startup and every 30 seconds, inspect `tailscale serve status --json` for
mappings to the runtime port; refuse enabling loopback HTTP at startup, or
close this route family and its active transports if a mapping appears later.
Reuse the bounded CLI invocation/status parsing in
[public-ingress-origin.ts](../../src-server/services/tailscale/public-ingress-origin.ts),
but inspect **all mappings**, including subpaths and TCP forwards. Its existing
root/MagicDNS origin resolver is insufficient as a negative exposure proof.
Distinguish an absent CLI from a failed/malformed status check; an installed
but unverifiable Serve configuration suspends loopback HTTP until verified.
This periodic check supplements the request predicate; it does not replace it.

Raw TCP forwarders such as `ssh -L` can preserve the exact Host and supply no
headers while arriving from loopback. They are undetectable here and remain an
explicit operator-chosen residual; do not claim the predicate proves physical
locality against such forwarding. Any configured non-loopback exposure requires
HTTPS. Reject inconsistent configuration at startup. These rules change neither
C nor the passkey requirements.

The exact resource identifier `R` is `O + /mcp`, with no query or fragment.
The issuer is exactly `O`. These are persisted configuration, never inferred
from Host, forwarded headers or tool arguments. Setup output prints exact R for
copying into either CLI. Claude rejects metadata whose `resource` differs from
the configured URL. A `localhost` Host in literal-loopback mode gets a precise
local refusal naming the configured R, never a redirect or metadata alias.
An origin/issuer change revokes existing grants and requires new registration
and approval. Do not silently retarget tokens or redirect bearer requests.

`C` is the existing `STATION_TRUSTED_CONSENT_ORIGIN`, a separate HTTPS origin
that reaches only the consent listener. It may share O's DNS name on a different
port, as in S3/S4; it must remain a different origin. Operator cookies reaching
both ports do not authorize ceremonies on O. Browser approval on C requires
the already paired Device and operator session used by S3. The OAuth client
itself does not become a paired Device.

| Station address | Serve `/mcp` and OAuth on O? | Approval channel |
| --- | --- | --- |
| Literal loopback HTTP, e.g. `http://127.0.0.1:43141` | Only with explicit same-machine opt-in, the complete per-request predicate and startup/periodic Serve checks above; raw forwarding remains an operator residual. | Host CLI; separately valid HTTPS C may enable the existing paired-browser passkey path. |
| Loopback reached through configured, trusted HTTPS | Yes, local-only TLS listener or explicit trusted TLS ingress, with exact configured Host. No hostname aliases. | Host CLI; optional separately configured valid C enables the existing passkey path. |
| LAN or tailnet IP over HTTP | No; no discovery, registration, token or MCP access. Return 404. Tailnet encryption does not make an HTTP browser origin a WebAuthn origin. | Host CLI can administer local grants, but cannot enable insecure remote OAuth. |
| Configured HTTPS DNS origin on LAN or Tailscale | Yes, through an explicitly trusted TLS ingress that strips untrusted forwarding headers. All other hosts are refused. | C with S4 step-up, or host CLI. |
| HTTPS IP literal, or HTTPS DNS origin without C | OAuth transport can be enabled with valid TLS, but D10 still forbids remote operator sign-in on an IP-only Station. | Host CLI only. No app-origin approval fallback. |
| Public HTTPS, single personal Station | Optional explicit exposure; same issuer, rate limits and operator gates. No public exposure enabled by default. | C with S4 step-up, or host CLI. |
| Station with a hosted tenant registry | No: fail startup configuration or return 404 for this feature's entire route family. | D11 requires a separate tenant-authority design before enabling it. |

**Loopback HTTP security rationale:** intended direct same-machine traffic
never leaves the host; provisioning TLS trusted by both CLIs for a local
literal-loopback issuer is impractical. This is the reason for the narrowly
checked local mode, not the fact that two clients accepted HTTP. Raw forwarding
breaks that same-host assumption at the operator's choice. The
[MCP communication-security requirement](https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization#communication-security)
still requires HTTPS for authorization-server endpoints; describe HTTP as a
local compatibility mode, without claiming full profile conformance. Remote
exposure requires configured trusted HTTPS.

The browser authorization landing/wait page is on O. It can display a code and
pending outcome; it cannot grant, revoke or change access. With no HTTPS C,
**host-CLI approval is the only approval path**, including for a browser on the
host. The host never pastes an operator credential into that page.

For browser MCP clients, validate any supplied Origin against an operator-set
exact allowlist, initially empty. **No wildcard or pattern**, including
subdomain patterns, at either this CORS Origin allowlist or the redirect-origin
allowlist. Edits to each require H or their own P ceremony, never an ordinary
operator session or Device. Removing a CORS origin terminates its browser
transports and refuses subsequent requests; native grants remain independently
authorized. Permit preflight only for
advertised MCP/OAuth methods and headers; never allow CORS on management or
consent writes. Native clients without Origin use bearer/PKCE checks. Reject
an untrusted Origin even when a bearer is valid. These rules supplement Host,
TLS and DNS-rebinding defenses; they do not confer operator authority.

For both allowlists, canonicalize an origin before review, storage and comparison:
parse an absolute HTTPS origin with no userinfo, query, fragment or non-root
path; convert IDN to validated ASCII punycode, lowercase the host, remove a
single DNS trailing dot, and omit the default `:443` port. Reject malformed IDN,
multiple trailing dots, port 0, single-label DNS hosts, opaque/`null` origins
and ambiguous authorities. Validate each `xn--` label by decoding it and
round-tripping to the same ASCII label; an undecodable label is refused.
**Decision:** canonical IPv4 and bracketed IPv6 literals remain accepted. Station
never fetches these allowlist origins; entries grant exact origin permission only.
Show the canonical ASCII origin in review. Compare scheme/host/effective port exactly;
canonical equivalence never permits subdomains. This origin normalization does
not normalize registered redirect URI bytes or relax the exact O Host check.

Redirect origins have a **separate**, initially empty operator-managed allowlist.
Non-loopback redirects are refused at DCR, authorize, approval decision, code
exchange and completion unless their exact HTTPS origin is currently allowed. Add/remove an
origin through host-secret-proved CLI administration or a distinct S4 per-action
passkey step-up target binding origin, expected allowlist revision and actor.
Device credentials and outside tokens cannot manage it. Removal cancels pending
requests and revokes affected grants atomically; the redirect-policy revision
is bound into review. Origin permission never relaxes byte-exact URI matching.
Every non-loopback review prominently says **“sends access to <origin>, a remote
site”** beside the actual callback, even for an allowed origin. A ticket in the
operator's own browser proves no ownership of that remote site; this closes the
attacker-registered HTTPS client/authorize-link phishing path by default.

## 3. Route and authority matrix

All paths below are proposed except the existing consent paths. O serves
protocol routes; C serves consent; runtime management APIs serve the app and
host CLI. Public OAuth routes deliberately bypass the ordinary Device pairing
admission, **only for these exact paths**, and install their own validators.
They must never become a blanket exemption for `/api`, `/mcp/*` or `/oauth/*`.

`/mcp` already belongs to VoltAgent's classified route family in
[pairing-route-scopes.ts](../../src-server/security/pairing-route-scopes.ts)
(the `/mcp` domain prefix, line 438 at the inspected base). Add a method plus
**exact pathname** capability rule for the outside `/mcp` leaf before prefix
classification; keep `/mcp/servers/*`, `/mcp/:serverId/mcp`, the outbound proxy
and `/mcp/station-control` under their existing authenticators. `/mcp/`, encoded
separators, dot segments, duplicated slashes and alternate spellings must never
fall through into another trust domain or redirect a bearer: reject ambiguous
raw paths before framework normalization. Route enumeration must prove the
composed VoltAgent handlers cannot shadow the exact outside leaf.

The [runtime composition](../../src-server/runtime/routes/runtime-routes.ts)
installs hosted-tenant middleware before runtime admission and currently has
specific internal MCP/proxy bypasses. Refuse configuration enabling outside OAuth
when a hosted registry or hosted execution requirement is present. An early
exact-route feature guard returns 404 for these outside protocol leaves in
hosted mode, before tenant middleware can turn them into account login or a
discovery challenge; do not add an outside bypass to the hosted tenant gate.
Existing internal/VoltAgent/proxy routes retain their hosted checks. Exercise the
full composed middleware, not only standalone routers, in section 10.

Authority abbreviations: **H** is host operator proof (section 4.3); **S** is a
live S3 operator session with its bound Device; **P** is that initiating session
plus a fresh S4 assertion on C; **B** is only the pending browser's random
authorization ticket; **A** is a valid outside access bearer. A Device, PAT,
launcher UI session, deployment account, internal token or raw remote operator
bearer grants no implicit access in this matrix.

| Origin / route | Exactly what it accepts | Effect / refusal |
| --- | --- | --- |
| O `GET /.well-known/oauth-protected-resource/mcp` and root `GET /.well-known/oauth-protected-resource` | Anonymous, exact configured host | Same RFC 9728 document: `resource: R`, `authorization_servers: [O]`, supported scopes, header bearer method. No private state. |
| O `GET /.well-known/oauth-authorization-server` | Anonymous | RFC 8414 issuer/endpoint metadata, section 5.1. |
| O `POST /oauth/register` | Anonymous JSON DCR body within section 5.2 limits | New **unapproved** public client; no credential or grant. 400 validation, 429 capacity/rate refusal. |
| O `GET /oauth/authorize` | Valid registered client, exact redirect, code response, state, S256 challenge, resource and scopes | Creates bounded pending request and B, displays code and review links; no grant. Invalid client/redirect stays on Station, never redirects. |
| O `GET /oauth/authorize/status` | B + request ID bound to B, same-origin fetch; no code or client ID as credential | Long-poll/SSE for that request’s pending/approved-awaiting-exchange/active/denied/expired status only; no grant inventory or tokens. No idle extension or timer-driven polling. |
| O `POST /oauth/authorize/complete` | B + one-use page nonce, exact O Origin/Host and same-origin Fetch Metadata | Automatically submitted by the waiting page after recorded approval intent, without another click; issues code once and 303 to the stored validated redirect with `code`, unchanged `state` and `iss`. Denial returns `access_denied` only to that validated redirect. |
| O `POST /oauth/token` | Form-encoded public client `client_id` and authorization code + verifier + exact redirect + `resource=R`; or refresh token + `client_id` + `resource=R` | Atomic code exchange / refresh rotation. Cookies, A and operator credentials cannot substitute. OAuth errors, never HTML login. |
| O `POST /mcp`, `GET /mcp`, `DELETE /mcp` | A in Authorization header only, audience R; each request rechecks grant/family/version and session ownership | Streamable HTTP; initialize/call, event stream/resume, close own session. Missing/invalid bearer: 401 with metadata challenge. An insufficient-level/uncatalogued tool call returns HTTP 200 with JSON-RPC “unknown tool”, never 403 `insufficient_scope`. No query/cookie bearer. |
| O `OPTIONS` for register/token/mcp | Anonymous exact-allowlisted browser Origin | Preflight only, zero authority; other methods return 405. |
| Runtime `GET /api/outside-agent/clients` | H or S | Sanitized approved/expired/revoked inventory and pending request metadata; H additionally sees displayed comparison codes; S inventory omits codes, but its passkey review displays the code for the same human to compare across devices. Neither sees tickets or tokens. All other callers refused. |
| Runtime `GET /api/outside-agent/requests/:id` | S | Sanitized snapshot for operator review; no authorization secret. Missing and foreign records are indistinguishable. |
| Runtime `POST /api/outside-agent/requests/:id/approval` | S + expected request/registration versions, selected permitted level/Project/expiry and selected superseded grant IDs/versions | 202 `step_up_required` and transaction owned by S; no grant yet. H uses the host confirmation route, not this route. |
| Runtime `POST /api/outside-agent/grants/:id/change` | H with host proof, or S; expected grant version and complete next grant | H applies directly with expected-state checks; S gets 202 and a new transaction. Cannot change client/redirect/resource in place. |
| Runtime `POST /api/outside-agent/grants/:id/revoke` | H with host proof, or S; expected grant version | H applies directly; S gets 202 and a new transaction. Neither A nor a paired admin Device can revoke grants. |
| Runtime `GET /api/outside-agent/transactions/:id` | The initiating S only | S4-style terminal status and non-secret effect; never a code or token. Background read does not renew S. |
| Host `POST /api/outside-agent/host/confirm` | H + request ID + expected request/client fingerprint and reviewed selection/supersessions | Records approval intent once through the shared commit service; activates nothing until code exchange. No code input, browser session or network-locality shortcut. |
| Host `POST /api/outside-agent/host/deny` | H + request ID + expected request/client fingerprint | Denies pending request once. No code input; no grant is created. |
| Runtime `GET /api/outside-agent/redirect-origins` and `GET /api/outside-agent/cors-origins` | H or S | Canonical origin inventory and policy revision; no mutation. |
| Runtime `POST /api/outside-agent/redirect-origins/change` and `POST /api/outside-agent/cors-origins/change` | H with host proof, or S + canonical add/remove selection and expected policy revision | H commits with expected-state checks; S gets 202 and a distinct typed P ceremony on C. No wildcard or pattern. Device/outside tokens refused. |
| Runtime `POST /api/outside-agent/requests/:id/denial` | S + expected request/client fingerprint | 202 and a distinct `outside-agent-denial` passkey review; confirming denies the pending OAuth request, while cancelling closes only the review. |
| C `GET /consent/:id` (existing) | Initiating S, matching WebAuthn transaction | Escaped review and fresh render nonce/challenge. No mutation. Other S gets 404. |
| C `POST /consent/:id/decide` (existing) | P + nonce + transaction-bound assertion for approval; initiating S + nonce for cancellation, as S4 | Only `operator-passkey` records approval intent or commits the separately reviewed management action; grant activation waits for code exchange. Exact C Origin/Host, same-origin Fetch Metadata, JSON body, UV and session freshness required. Generic consent authorities refused. |

Management requests use the same exact trusted app-origin/Fetch Metadata and
CSRF controls as S4 when using cookies. Host requests require the separate host
proof and are not enabled through CORS. Rate limiting and body limits apply
before store allocation. Error responses never include secrets. There is no
registration-update API, OAuth password/implicit/client-credentials grant,
token introspection, general API bearer admission or issuer-side callback route.
The callback belongs to the client. Client logout clears local credentials;
operator revocation ends the Station grant. A public token-revocation endpoint
is deferred so it cannot become an alternate grant-management authority.

## 4. Approval transactions and host confirmation

### 4.1 Typed targets and canonical fingerprints

Add `OutsideAgentApprovalTarget`, `OutsideAgentGrantChangeTarget` and
`OutsideAgentGrantRevocationTarget` as typed constructors, respectively using
target kinds `outside-agent-approval`, `outside-agent-grant-change` and
`outside-agent-grant-revocation`. Register all three alongside S4's restricted
operator targets. Add `OutsideAgentRedirectOriginChangeTarget` for the allowlist
action in section 2, plus `OutsideAgentCorsOriginChangeTarget`, with kinds
`outside-agent-redirect-origin-change` and `outside-agent-cors-origin-change`.
Both use the same restricted H/P authority and canonical fingerprints.
The browser targets require `ceremony: 'webauthn'`, `operatorSessionId`, and
approval authority **only `operator-passkey`**. Ordinary consent sessions,
`consent:decide`, device consent and raw operator bearers cannot decide them.
Cancellation uses S4's initiating-session denial path, which grants no access.

Canonical JSON uses the following field order, sorted unique scope arrays,
integer UTC millisecond timestamps, and explicit `null` for absent values.
Reject duplicate/unknown fields, invalid enum values and ambiguous URI forms
before constructing a snapshot. Hashes below are SHA-256 over canonical bytes;
fingerprints are the complete canonical JSON, as in S4.

```text
approval:
{kind, schemaVersion:1, stationId, tenantId:'local', issuer, resource,
 requestId, expectedRequestVersion, expectedRequestState:'pending',
 clientId, expectedRegistrationVersion, registrationDigest, redirectUri,
 expectedRedirectPolicyRevision,
 responseType:'code', codeChallengeMethod:'S256', codeChallenge, stateDigest,
 requestedScopes, requestedAccessLevel, selectedScopes, selectedAccessLevel,
 projectScope:{kind:'project',projectId}|{kind:'global'},
 delegatingPrincipalId, approverAuthorityRevision, expiresAt,
 supersededGrants:[{grantId, expectedVersion, expectedDigest}]}

grant change:
{kind, schemaVersion:1, stationId, tenantId:'local', issuer, resource,
 grantId, clientId, expectedRegistrationVersion, registrationDigest, redirectUri,
 expectedGrantVersion, expectedGrantState:'active', expectedGrantDigest,
 requestedAccessLevel, selectedAccessLevel, selectedScopes, projectScope,
 delegatingPrincipalId, approverAuthorityRevision, expiresAt}

revocation:
{kind, schemaVersion:1, stationId, tenantId:'local', issuer, resource,
 grantId, clientId, expectedRegistrationVersion, registrationDigest, redirectUri,
 expectedGrantVersion, expectedGrantState:'active', expectedGrantDigest,
 expectedAccessLevel, expectedScopes, projectScope, delegatingPrincipalId,
 approverAuthorityRevision, reason}

redirect-origin or CORS-origin change:
{kind, schemaVersion:1, stationId, tenantId:'local', issuer, resource,
 actorPrincipalId, approverAuthorityRevision, operation:'add'|'remove',
 canonicalOrigin:{scheme:'https', asciiHost, effectivePort, serializedOrigin},
 expectedPolicyRevision, expectedPolicyDigest, nextPolicyDigest}
```

`registrationDigest` binds **all** accepted registration metadata, including
the entire redirect list and displayed name. `expectedGrantDigest` binds the
validated grant's ID, version, state, terminal reason, client ID, registration
digest, exact redirect URI, issuer, resource, station ID, requested scopes,
refresh-family ID, creation time and absolute expiry, plus the full selection:
delegating principal, actor (kind, ID and authority revision), Project scope,
access level, selected scopes, selected expiry and redirect-policy revision.
It excludes `lastUsedAt`: refresh activity alone must not invalidate a reviewed
supersession. A revoke, version or other bound authority change still does.
The requested access level is derived from validated scopes, not a display string. Selection cannot exceed requested
scopes or the approver's current authority. Until the full slice ships, review
offers read-only only, even when both scopes were requested. Show the narrower
selection before assertion and returned explicitly in the token response. Editing a
selection requires a new snapshot/review, not rewriting the asserted action.
`supersededGrants` is sorted by grant ID and empty when none are selected.
Review lists the delegator's existing active grants in the same stable Project
scope (or the same explicit global scope) from apparently the same software.
Compare bounded `client_name`/`software_id` heuristics; show name, ID, callback,
level, last use and expiry, with an unverified-match label. Supersession is
**UNSELECTED by default**, including for an identical-looking new Codex DCR ID.
Two legitimate installations can look identical; lookalike metadata can induce
displacement. Require an explicit selection and show **“This will disconnect
`<client ID / installation details>` when the new login completes.”**
Metadata resemblance confers no authority and never revokes without the reviewed decision. Do not merge scopes
or carry old authority forward. Every selected grant must still belong to this
delegator, scope and resource at commit. Bind its ID/version/digest even when
its client ID differs; stale inventory requires renewed review. Activate the new
grant and revoke the selected grants/families in one transaction at the first
successful code exchange, not at approval. A revoked/expired grant is never
reactivated; activation creates a new ID. An access change cannot exceed the
original requested scopes; requesting additional scopes needs a new OAuth flow.

S4 supplies a random challenge bound to `(transactionId, renderNonce,
fingerprint)`, UV verification, atomic single-use consumption, five-minute TTL
and **no step-up window**. `guardDecision` and the grant store mutation lock
cover revalidation through domain mutation and terminal recording. Check current
request, registration, grant, Project identity, approver authority and operator
session again inside that span. A changed/deleted target closes as
`target_changed`; an ended session as `session_ended`. Restoring old values does
not reopen it. Failed assertion is not an approval. Use S4's pending-refusal
semantics where appropriate; never blindly retry an indeterminate write.

### 4.2 Commit, effect and crash boundaries

Approval records an immutable **approval intent**, actor (deciding passkey ID
or host actor), selected grant/scope/expiry and supersession IDs/versions/digests,
and audit-outbox row under a unique decision ID. It creates no active grant and
revokes nothing. Grant change/revoke and allowlist edits still commit their
reviewed effects immediately under expected-state checks and an atomic outbox.
Reconciliation reports the recorded decision; it cannot repeat a mutation.
Pending in-memory consent transactions expire on restart; they do not recreate
an approval or code.

At the **first successful code exchange**, under one mutation lock and SQLite
transaction, validate the code/verifier/client/redirect/R, request and approval
intent, code/grant expiry, current approver authority, Project, registration, policies and
every selected old grant's version/digest. Atomically consume the code, activate
a new grant/family and token hashes, revoke the selected supersessions and append
the activation outbox event. If anything changed, return `invalid_grant` with a
clean new-review/login instruction and leave the old grants untouched. A session
that ended before the approval decision cannot approve; ordinary session expiry
after that decision alone does not invalidate its bounded intent. Revoked
signing passkey/host/delegator authority does invalidate it. Never reuse or
reactivate an old grant ID.

Approval-time capacity checks are advisory only. Inside this same activation
transaction enforce both active-grant caps, counting the resulting active set
**after removing the selected supersessions**. Replacing one grant at a 5/5
per-client cap therefore succeeds. If two approved intents race for the last
slot, serialize activation: the loser gets `invalid_grant` with re-login/new
review guidance, creates no grant and revokes none of its selected old grants.

The consent response reports `approved-awaiting-exchange`, reviewed scope/expiry
and selected supersession IDs, without claiming activation or disconnection.
**No OAuth code, access token or refresh token is a consent effect.** The waiting
page uses long-poll or SSE to detect approval and automatically submit its
request-specific completion nonce, following the 303 without another click.
Do not depend on timers; background-tab timer throttling must not delay
completion. Phone approval on C wakes the original browser the same way; C
never holds B.

Pending requests last ten minutes; a code may be issued only within that bound
and lasts 60 seconds from issuance, even if the pending bound then passes.
An approved
intent whose code is not redeemed is void by pending TTL + code TTL at the
latest (eleven minutes after request creation), superseding nothing. A timed-out
client therefore leaves its previous working grant intact. A lost redirect or
unknown code-exchange outcome requires new login/approval, not plaintext response
recovery. If exchange committed before response loss, its activation and selected
revocations remain committed; show that durable outcome truthfully. Refresh
response loss likewise requires re-login under strict rotation (section 5.3).
**A lost refresh response or any replay ends the grant; the client must log in
again, which needs a fresh operator approval (host CLI or passkey).**

### 4.3 Host CLI alternative

Proposed commands under `station environment outside-clients` are `list`,
`approve <request-id> --project <slug> [--access read-only|full] [--expires-in 30d]`,
`deny <request-id>`, `change <grant-id> …` and `revoke <grant-id>`.

Host management has one 120/minute budget per host process. Only current
host-proof holders reach it, so sharing that budget is acceptable: all holders
already have the same host authority. It is not a distributed abuse limit.
The [host CLI channel](../../packages/cli/src/commands/outside-host-channel.ts)
uses a dedicated stable `clientInstanceId` per Station home so reminting supersedes
its own previous credential, independently of the desktop. When an OS keyring
is available it reuses that credential after the owner-secret eligibility route
confirms it is still live, preserving the desktop's shared 5/minute local-grant
mint budget. Without a keyring, it remints under the same stable identity and
remains subject to that budget; no bearer is stored in an ordinary file.

Global space needs an explicit `--global`; never infer it from an unknown slug.
`redirect-origins list|add <https-origin>|remove <https-origin>` manages section
2's redirect allowlist under H, with expected-revision checks;
`cors-origins list|add <https-origin>|remove <https-origin>` does the same for
the browser-MCP Origin policy. Both use section 4.1's canonical targets.
`register --name <label> --redirect-uri <exact-uri>` issues a stable public
client ID under H, subject to the same registration/redirect/capacity rules;
setup prints exact R and per-client instructions without initiating a login.

The browser and host-only pending listing display the same random six-digit
code, unique among live requests, with the request's ten-minute expiry. `list`
shows request ID, code, age, untrusted client name/software, exact client ID and
redirect, resource and requested scopes. The operator finds their own browser's
code in that list, compares the client details, then approves **by request ID**.
The CLI never accepts a code as an argument or prompt response. The displayed
code is a comparison cue, never a lookup credential or proof of authority.
Interactive review shows Project/access/expiry and selectable existing-grant
supersessions before confirmation. Noninteractive approval requires the exact
client ID, expected request fingerprint and explicit selected supersession
IDs/versions from the host channel; it must not silently apply heuristics.

Host approval records intent through a direct domain decision, like S4's host
alternative; it does **not** forge an `operator-passkey` ConsentTransaction decision. It uses the same
canonical target, expected-state rules, ceiling, lock, idempotency and audit
projection. New host routes require an existing host-possession local-grant
credential bound to the active instance/boot, minted through its private local
grant secret. Loopback position and a raw operator bearer alone are insufficient.
S4 does not finish S1b for old routes; these new routes must enforce host-secret
proof from their first release. Missing host proof is a prerequisite failure,
not a reason to introduce an approval-capable browser bearer.

## 5. OAuth contract, storage and limits

### 5.1 Discovery and authorization

Target the [MCP authorization profile, revision 2025-11-25](https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization).
Use authorization code with required PKCE S256; reject missing PKCE, `plain`,
implicit flow and any unknown grant. DCR is the default read-only delivery mechanism.
CIMD is an explicit follow-up slice immediately after the end-to-end read-only
milestone (section 11), rather than indefinite deferral. Until it ships, omit
`client_id_metadata_document_supported`; a CIMD-only client needs DCR or waits.
The CIMD slice must validate exact document/client ID and redirects, bound
fetch/cache size and time, prevent SSRF/DNS rebinding/redirect-to-private targets,
and bind reviewed metadata versions. It must not confer a trusted publisher
badge or bypass approval and redirect allowlists. Confidential-client
authentication remains a separate deferred design.

**Stable public pre-registration alternative:** the supplied real-client review
confirmed Claude accepts `--client-id` plus `--callback-port`, and Codex accepts
`--oauth-client-id`. A host-CLI-issued immutable public client registration per
installation can avoid DCR pile-up without CIMD; it is an identifier, not a
secret or approval. It must use the same redirect policy, entropy, capacity and
explicit authorization review. Build this bounded host command in R2 first
(recommended): it avoids network metadata fetching/SSRF and serves both CLIs.
Keep C1 as the next interoperability follow-up, with separately qualified real
client support. A stable client ID alone never silently supersedes grants or
transfers running work; F1's ownership criterion remains.
Never label a host-issued client ID in review as “your client”: the public ID
is an identifier, not proof of the requester's identity, even when familiar.

An unauthenticated request, including **GET `/mcp` before initialization**, returns 401 and
`WWW-Authenticate: Bearer resource_metadata="O/.well-known/oauth-protected-resource/mcp", scope="station-control:read"`.
The [RFC 9728 resource document](https://datatracker.ietf.org/doc/html/rfc9728)
identifies R and O. Both well-known resource paths return the same document.
The [RFC 8414 issuer document](https://datatracker.ietf.org/doc/html/rfc8414)
advertises `/oauth/authorize`, `/oauth/token`, `/oauth/register`,
`response_types_supported:["code"]`,
`grant_types_supported:["authorization_code","refresh_token"]`,
`token_endpoint_auth_methods_supported:["none"]`,
`code_challenge_methods_supported:["S256"]`,
`scopes_supported:["station-control:read","station-control:full"]`, and
`authorization_response_iss_parameter_supported:true`. Responses include the
configured issuer `iss` to resist issuer mix-up. Metadata does not claim OIDC,
ID tokens, confidential-client secrets or unsupported registration mechanisms.

Require one `resource=R` in authorization, code exchange and refresh; reject
missing, repeated, wildcard, another instance, another path or a different
origin with `invalid_target`. This proposal deliberately uses one audience per
grant, following [RFC 8707 resource indicators](https://datatracker.ietf.org/doc/html/rfc8707).
Store the resolved resource with the request, code, grant and every token row.

Authorization input is strictly bounded: registered `client_id`,
`response_type=code`, `redirect_uri`, `state` (1–1024 bytes), valid 43-character
S256 challenge, `code_challenge_method=S256`, resource and space-delimited
scopes. Unknown scopes get `invalid_scope`; omitted scope means read-only.
`station-control:full` requests both read and full. Both tested CLIs request
both scopes regardless of the challenge: treat this as normal, and always
preselect read-only in review even when full was requested. No silent full grant because a client
requested every advertised scope. The token response reports the actual scopes.

Redirect matching is byte-exact against the stored registration; no prefix,
wildcard, path normalization, subdomain or query flexibility. Reject userinfo,
fragments, controls and malformed/ambiguous encodings. Non-loopback redirects
require a currently operator-allowlisted HTTPS origin and an exact URI. HTTP is allowed only for native loopback redirects. A loopback redirect host
is exactly `127.0.0.1`, `[::1]` or `localhost`; no suffix, DNS alias or private
IP earns this exception. The sole
port exception is [RFC 8252 §7.3](https://www.rfc-editor.org/rfc/rfc8252#section-7.3):
literal `127.0.0.1` or `[::1]` may change port, with scheme, host, path and query
otherwise identical. Bind the **actual** redirect, including its port, into the
approval and code; token exchange must repeat it exactly. `localhost` is
accepted only with its exact registered port; it gains no port exception and is
not interchangeable with an IP literal. Private schemes are outside v1.

B is a 256-bit random authorization-browser ticket, hashed server-side, in a
host-only HttpOnly SameSite=Strict cookie scoped to `/oauth/authorize`, Secure
for HTTPS. Only the explicitly enabled literal-loopback HTTP mode omits Secure;
it retains exact Host/Origin and same-origin Fetch Metadata checks and never
intentionally shares the ticket. Cookies are **not port-isolated**: a sibling
service on the same loopback host can receive B on a matching path, even though
its port is a different origin. Record this local residual rather than claiming
origin isolation. Impact is limited: B cannot approve or redeem the PKCE-bound
code, and exact Origin/nonce checks still guard completion. Bind B to issuer
and up to **five** simultaneous pending request IDs, each with its own state, nonce and displayed
code. A new request under the **same B, same client and same exact actual redirect URI**
atomically replaces that ticket's older pending request, invalidating its code,
nonce and unactivated intent and releasing its capacity. It never affects an
active grant, a request under another B, or a different client/redirect,
including another CLI's login. Knowing a non-secret registered client ID and
redirect cannot cancel another browser's request or leave an attacker's request
as its replacement in review.
Other simultaneous tab requests remain independent. On capacity,
refuse the new request, preserving existing ones. The initial GET may be
cross-site; status/complete require B and the selected bound request ID, and
completion requires that request's one-use nonce. C's review link identifies
the request, not B. Its ID is not a status/complete credential.

Each pending request lasts **ten minutes**, never extended by status reads;
an issued code lasts **60 seconds** (section 4.2).
Keep B until the last bound request and any issued code reach a terminal state,
with a 30-minute absolute ticket cap; issue a fresh ticket only when no pending binding would be lost.
Do not start a request that cannot receive the full pending TTL plus code TTL
within that cap. S4's assertion transaction still has its own five-minute TTL; it does
not shorten or renew the OAuth pending lifetime. S3 sign-in occurs through its
existing page; a return URL grants no authority. Retain raw OAuth state only
in volatile request memory, digest in durable state; restart requires new flows.
Ten minutes of pending validity does **not** extend a client's callback window:
section 10 must time the whole journey and complete within the client's limit.

### 5.2 Dynamic registration and denial-of-service budget

[RFC 7591 DCR](https://www.rfc-editor.org/rfc/rfc7591) accepts JSON, at most
16 KiB. `redirect_uris` is required (1–5 URIs, at most 2048 bytes each).
Accept bounded optional `client_name` (128 characters), `client_uri`, `logo_uri`,
`policy_uri`, `tos_uri` (2048 bytes each), contacts (at most three short
addresses), `scope`, `grant_types`, `response_types` and
`token_endpoint_auth_method`, `application_type` (`native` or `web`) and
`software_id` (128 characters). Both tested CLIs send `application_type: native`;
accept it and bind it into the registration digest. Defaults are authorization-code/refresh-token,
code response and `none`; reject incompatible values. Unknown metadata is
ignored, never echoed/rendered or made authoritative. Return 201 with random
`client_id` with at least 128 bits of cryptographic randomness,
`client_id_issued_at` and accepted metadata; no client secret or
registration-management bearer. Registration is immutable; edits require a new
client ID and operator approval. Omit unsupported DCR management URLs.

Names and URLs are attacker assertions. Store accepted metadata as data, escape
text and display the exact client ID and redirect beside the name. Do not fetch
logos, client sites or policies, and do not render remote images or active links
in approval. Strip control/bidi characters from displayed labels while retaining
the reviewed raw metadata digest. No trusted badge inferred from a name/domain.

| Budget (initial defaults, operator-configurable downward) | Bound |
| --- | --- |
| DCR per effective peer | 5/minute, burst 5; 50/day |
| DCR instance-wide | 30/minute, burst 30; 500/day |
| Registrations without an active grant | 100 live instance-wide; expire after 24 hours |
| Active approved grants | 100 per instance, at most 5 per client; no automatic eviction |
| Pending authorization requests | 3/(ticket B, client), 5/ticket, 5/verifiable peer when available, 50/instance; ten-minute TTL |
| Authorization starts | 10/minute/peer, 30/minute/instance |
| Code exchange | 10/minute/client and verifiable peer; 60/minute/instance; at most 5 failed verifier attempts/code |
| Refresh (including rejected reuse attempts) | 6/minute/family, burst 3; 30/minute/client; 60/minute/verifiable peer when available; 120/minute/instance |
| Client-ID recovery tombstones | 30 days from client retirement; 20,000/instance hard cap, no live tombstone eviction to admit a registration |
| MCP transport | 5 sessions/grant, 10 calls in flight/grant; 1 MiB request and bounded response/stream queues |

Active-grant caps are enforced in the code-exchange activation transaction,
after selected supersessions are removed; approval checks are advisory only.
The last-slot race returns `invalid_grant` with re-login guidance to the loser,
without partially superseding old grants (section 4.2).

At 60-minute access lifetime, Claude's measured five-minute early-refresh
threshold predicts roughly one normal refresh per active family per 55 minutes,
not one per request. This cadence is **REASONED** from the supplied sample, not
a measured 60-minute soak. Six/minute/family with a burst of three permits a
small concurrency burst; lost-response recovery is a new login, never token retry; 100 grants could sustain normal refresh
without approaching the 120/minute global ceiling. Validate a multi-client soak
before tuning. Charge failed and replay attempts too; limits never weaken replay
checks and refresh retries never renew absolute grant expiry.

Derive rate-limit keys explicitly per ingress:

- Direct connections: use the transport socket peer, normalized IPv4/IPv6,
  never request-supplied forwarding headers.
- Trusted reverse proxy: use an original-peer value only when the isolated
  proxy path authenticates ingress and strips/replaces caller-supplied headers.
- Tailscale Serve: the socket peer is usually loopback, **not** a distinct user.
  Use its identity headers only on a verifiable Serve-only path that external
  callers cannot forge or bypass. Key by stable verified Tailscale principal,
  not a display name. Do not label the shared loopback peer as a user.
- Without verifiable original identity, key post-registration limits by validated
  client ID (plus family on refresh) and always enforce instance-wide ceilings.
  For anonymous DCR only the global ceiling and hard capacity limits are
  defensible; unregistered supplied client IDs cannot allocate limiter keys.

Verified peer budgets supplement rather than replace client/global limits.
Global budgets still apply to attackers with many addresses or fresh client IDs. Persist
daily counters/capacity accounting; restarting cannot erase the quota. Limit
limiter-key cardinality and evict expired keys, not quota evidence. Reject before
allocating records; return 429 with Retry-After. TTL cleanup runs on allocation
and a bounded periodic sweep. Never evict an approved client to admit spam.
Unapproved DCR alone does not generate operator notifications. Pending requests
appear as a bounded count; no modal or passkey prompt opens unsolicited.
Expired, denied or revoked client IDs retain a minimal recovery tombstone
for 30 days after retirement, alongside separately bounded audit history. Keep
client ID, safe software label, retirement reason and expiry, no redirects,
tickets, authorization state or tokens. Approved registrations remain while a
live grant references them; after 30 days without one, retire to a tombstone.
Denial/revocation retires a registration only when no other live grant or pending
request still needs it; IDs are never recycled. Reserve tombstone capacity when
admitting DCR, including live registrations that may retire; capacity pressure
refuses new registration instead of silently discarding recovery records.
Pin the sizing invariant: **500/day × 30 days = 15,000 < 20,000** tombstones.
The remaining capacity covers live-to-retired reservations; reserve on all
registration paths, including host pre-registration. Do not increase daily
admission/retention beyond that inequality without reviewing the hard cap.

An authorize request for a tombstoned or unknown client stays on Station and
never redirects, even if a redirect was supplied. A tombstone lets the page name
the recovery: `claude mcp logout <name>` or `codex mcp logout <name>`, then login
again. Explain that `<name>` is the user's configured MCP server name, which
Station cannot infer from untrusted `client_name`. Unknown/expired-tombstone
IDs get generic recovery instructions covering both commands; never echo an
unvalidated callback as a link. Claude's saved ID/port reuse makes this essential:
otherwise a correctly refused unknown client leaves it waiting about 300 s.
Station cannot terminate that CLI wait without a trusted callback; the page must
say to cancel the waiting login, logout and retry. Tombstones improve recovery,
not callback authority or automatic approval. These bounds permit denial of
service by quota exhaustion, but bound storage and operator interruption; availability is not an
approval bypass.

### 5.3 Token and grant records

| Artifact | Format and binding | Lifetime / consumption |
| --- | --- | --- |
| Authorization code | `oac_` + 32 random bytes, base64url; hash stored with client, actual redirect, S256 challenge, R, request/approval-intent version and exchanged family ID | 60 seconds; atomically consume after successful verifier and binding checks. Correctly bound reuse refuses and revokes the issued family/grant. |
| Access token | `oat_` + 32 random bytes, base64url; opaque, hash stored with issuer/station, R, grant ID/version, client, subject, family and scopes | 60 minutes (`expires_in: 3600` when not capped), capped by grant expiry; valid only as `/mcp` Authorization bearer. |
| Refresh token | `ort_` + 32 random bytes, base64url; hash with client/R/grant/family/sequence, issued/used timestamps | Rotate on first use; 7 days idle, capped by the grant's absolute expiry. Any reuse revokes its only family and grant (`refresh_replay`); idle expiry expires both (`idle`); no grace. |
| Grant | Random ID; active/revoked/expired (approval intent is separate); delegator, approval actor, immutable client/redirect/R, Project ID or explicit global, originally requested scopes, selected level/scopes, version, created/last-use/expiry | Default 30 days absolute, selectable shorter, maximum 30 days in v1. No automatic extension or refresh beyond expiry. |
| MCP session | Random opaque ID bound to grant, family, version, issuer and transport | At most 30 minutes idle and never beyond grant expiry; ID alone grants nothing. Reauthenticate each request. |

Hash all high-entropy secrets using domain-separated SHA-256; perform constant-time
comparison when comparing secret-derived bytes. Prefixes are format separation,
not authority. Keep token responses `Cache-Control: no-store`; tokens never
appear in URLs, logs, traces, analytics, audit or Connections. The client is
responsible for its own token custody. Store no verifier; retain only the S256
challenge and binding digests needed for exchange/replay checks as specified
below; purge unexchanged-code records after expiry. Redact browser state and authorization
query values from ingress logs. Persist audit/request digests rather than secrets.

The supplied Claude experiment rules out five-minute access: 300 s caused
8 refreshes per 10 requests, while 310 s caused none in that sample. Use 60
minutes to stay clear of its <5-minute early-refresh threshold. Cap all access
expiry at grant expiry. With **less than five minutes left**, refuse fresh code
activation/refresh with `invalid_grant` and a clean “grant ending; sign in again”
error; do not consume a current refresh token or issue another short-lived token.
Existing access remains valid only until its recorded expiry, subject to live
checks. Never issue refresh/access credentials beyond grant expiry or extend it
through retries. This avoids request-by-request refresh churn in the final
minutes. Section 10 must verify the pinned clients surface re-login cleanly.
Revocation speed is independent of access lifetime: section 8 requires a live
grant/family/version check on every request, dispatch and emission.

**Strict [RFC 9700 §4.14 rotation](https://datatracker.ietf.org/doc/html/rfc9700#section-4.14)
in v1:** serialize per family and atomically mark current `r[n]` consumed and
create the hash of a fresh `r[n+1]`, returning its plaintext only in that response.
After correct client/R binding, **any reuse** of a consumed refresh token revokes
the family, current access tokens, streams and descendants, including concurrent
presentations and immediate-predecessor retries. Recheck live grant/version,
family and idle/absolute expiry on every attempt. Retain consumed-token hashes
through grant expiry plus 60 minutes to identify replay. Unknown tokens get
`invalid_grant` without revoking another family; wrong client/resource cannot
redeem or trigger revocation of that family's tokens. All attempts count toward
budgets. Lost response or unknown refresh outcome means re-login, not retry.

Each grant has exactly one refresh family. Under the same mutation lock and
transaction, consumed-refresh replay revokes that family **and the grant** with
reason `refresh_replay`; seven-day idle expiry expires both with reason `idle`.
Both transitions bump the grant version and use section 8's token/stream/work
invalidation and audit path. Enforce idle expiry on admission/allocation and the
bounded sweep, so dead grants cannot occupy active-grant capacity or appear as
active supersession candidates in Connections/review. A lost refresh response
leaves an unknown committed rotation; the client abandons that unusable grant,
never recovers its response. The server cannot detect response loss alone:
a retry of the consumed token triggers `refresh_replay`; an unobserved loss
expires under `idle`.
**A lost refresh response or any replay ends the grant; the client must log in
again, which needs a fresh operator approval (host CLI or passkey).**

For authorization-code reuse, retain the consumed code hash, original binding
digests (including the S256 challenge) and issued family ID through grant expiry
plus 60 minutes. A reuse with the correct client, exact redirect, verifier and R
returns `invalid_grant` and atomically revokes the issued family and its grant
with reason `code_replay`, using the same lock/invalidation path. Unknown codes
or mismatched bindings cannot revoke another grant. This implements the
[OAuth 2.1 draft-16 §4.1.3 recommendation](https://datatracker.ietf.org/doc/html/draft-ietf-oauth-v2-1-16#section-4.1.3)
to revoke tokens issued from a reused code; never issue a second family or
recover a prior exchange response.

The revision-1 same-successor grace is removed. It reapplies at every rotation:
a thief with `r[n]` and the legitimate client can alternate refreshes and
co-tenant a family indefinitely without replay detection, not merely steal one
unused successor. Its AEAD envelope also needed a key beside SQLite in
`<STATION_HOME>/authentication/` and the same backups, defeating the claimed
hash-only custody. R1 stores neither that envelope nor a recovery key. The
reviewer's concurrent CLI executions in section 1 found no predecessor reuse;
they do not establish a response-loss soak, but provide no need for grace in v1.

**Possible future change, not v1:** only after soak evidence of real response
loss, review a hash-only fallback accepting the immediate predecessor once
within about 60 seconds per rotation. It would mint a **new** successor and
invalidate the unused original successor, never return a recoverable response.
If that old successor later appears, classify it as replay and revoke the
family. Track the one-use window atomically; evaluate theft, races and denial
of service before adopting it. This proposal does not authorize enabling it.

The outside access-token verifier is registered **only on `/mcp`**. General
runtime authentication, consent, pairing, internal MCP and engine-proxy routers
must reject these token formats. Refresh tokens and codes are accepted only as
form parameters at `/oauth/token`, never as route credentials. No token exchange,
passthrough to another server or conversion into Device/operator authority.
The store fails closed on corruption/unavailability. Reset/credential rotation
revokes grants; revocation of **the passkey that last decided** a grant ends
that grant. A later passkey decision replaces that binding; host decisions bind
to the host authority instead. Operator-session expiry alone does not end an intentionally durable grant. Revoked host
or delegator authority cannot keep a grant alive.

### 5.4 MCP transport and version negotiation

Implement Streamable HTTP at the exact `/mcp` resource, with JSON and SSE
responses, authenticated GET streams/resumption and DELETE session close.
Follow the [2025-06-18 transport](https://modelcontextprotocol.io/specification/2025-06-18/basic/transports)
and [2025-11-25 transport](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports)
contracts, negotiate either supported version at initialize, and validate
`MCP-Protocol-Version` on later requests. Reject unsupported versions precisely;
never report support based only on accepting initialize. MCP session IDs and
resume cursors remain grant/family/version-bound and never replace the bearer.
Authenticate before GET method/stream handling so anonymous GET always receives
401 with `resource_metadata`, even before initialize. Valid protocol requests
for unknown methods, including Claude's `server/discover`, get JSON-RPC
`-32601` method-not-found at HTTP 200 without breaking the session. Hidden or
insufficient-level tools get section 6.2's HTTP 200 unknown-tool error, not an
OAuth scope challenge. Malformed HTTP/protocol input follows the negotiated
transport's error rules. Apply section 8's live checks at each emission.

## 6. Caller identity, access levels and tool catalog

### 6.1 A grant-derived caller, not an invented internal Session

The new discriminated caller is `kind:'outside-agent'`, with `grantId`,
`clientId`, `familyId`, `grantVersion`, `delegatingPrincipalId`, and the immutable
approved Project scope. Its assurance is **bearer-exposed**, never bound or
delegated-custody. It has no Station-started Session/conversation, no private
Task-room role, and no inferred owner or operator elevation. All identity comes
from the verified token and live grant, not `sessionId`, headers, MCP client
information, roots, working directory or public tool arguments.

The operator selects exactly one existing Project by stable `ProjectConfig.id`,
or explicitly chooses global space (no Project). No default all-project grant.
The UI initially requires a selection. A missing/deleted Project refuses;
renaming/reusing its slug never retargets a grant. Multi-Project work requires
separate approvals/grants. A global grant cannot enter any Project implicitly.

Add a grant-aware branch to request/principal resolution and shared read/dispatch
admission. It acts within the delegating operator's current data authority,
intersected with the grant, **without setting `boundOperator`, home-possession
or an internal Session's `elevationEligible` bit**. The host operator and passkey
operator currently have the personal Station's operator ceiling; if additional
operator roles arrive, their live ceiling must be checked at request and commit.
No approver may select full without execute authority in the selected Project.
Read-only needs view authority. Recheck those rights on every call; authority
loss blocks existing tokens, not just new refreshes.

`search_conversations`, `list_active_work`, follow-up transcript reads and all
other allowed reads use this same principal-and-scope intersection. Admission
must happen **before reading snippets/content or counting/paginating results**.
An explicit `projectSlug` resolves to the approved stable ID or refuses;
omission means exactly the approved scope. Filter indexed hits, file-backed
conversations, native Sessions, titles, worktree paths and cursors consistently.
Existing person-reference exceptions cannot widen an outside grant. Unknown
ownership/Project records refuse, and out-of-scope IDs look absent. Bind cursors
and continuation capabilities to grant/family/version/scope. Preserve discovery's
`partial`/`unavailable` states; do not turn an unavailable index into no matches.

R4c must explicitly cover `conversation-message-reader.ts`'s owner-only
`storeReadable` branch, both the file and native fallback/lineage paths, and
`conversations.ts`'s `/:slug/conversations/:conversationId/messages` and
`/:slug/conversations` list route. These back `get_conversation_messages` and
`list_conversations`; neither owner equality nor a missing adapter proves
Project admission. Extend `isPrincipalScopedAgentRequest` exhaustively for the
outside-caller variant and refuse unknown/missing outside authority before
these reads. Also extend `conversation-reference-read.ts`'s caller selection
and admission: an outside variant must never become `undefined` and take the
unscoped person path. Admit each target and lineage Session against the live
grant's stable Project before reading, counting or projecting either source.

Keep the existing bearer-exposed exclusion for conversations/Sessions running
`host` in v1, including host history along a conversation's lineage. Outside
agents therefore cannot discover/read some of the operator's host-execution
work. Search and `list_active_work` must explicitly report
`incompleteSources:[{source:"station.work",state:"partial",reason:"host-execution-filtered",filteredCount:N}]`
(or an equivalent typed `filtered` reason/count), even when no admitted matches
remain. Count only host exclusions **after** live delegator and Project scope
filtering, before ordinary pagination/count projection; never count foreign
work or expose its identity/content. The count describes scoped candidate
records excluded from consideration, not claimed matching transcript hits;
never read host transcript content to compute it. If scan bounds prevent an exact count,
report an explicit lower bound and partial scan, not zero or an invented total.
Shared admission/projection contracts need this extension; it is planned work,
not a claim that current result types already carry the count. Section 12 keeps
owner visibility policy open with this recommendation and a later explicit
opt-in alternative.

### 6.2 Exact v1 tools

This is the complete proposed catalog. Full includes every read-only row plus
the full-only rows. **Every other tool is denied at listing and dispatch**,
including later additions until explicitly reviewed. This deliberately exposes
the work-coordination part of Station Control, rather than granting operator
administration merely because the level is called full.

| Level | Exact tool names | Additional scope rule |
| --- | --- | --- |
| Read-only and full: discovery | `search_conversations`, `list_active_work`, `list_conversations`, `get_conversation_messages`, `read_conversation`, `list_project_activity`, `get_session_digest`, `wait_session` | Selected Project/global, current delegator view; no own-session bypass. |
| Read-only and full: Project | `list_projects`, `get_project`, `list_project_layouts`, `board_read` | Project grant lists/reads only that Project; global returns no Project records. Board faces are filtered before projection. |
| Read-only and full: review/evidence | `get_review_request`, `list_review_receipts`, `get_review_receipt`, `get_answer_assessment_target`, `get_basis` | Resolve target Session/Task/receipt to the approved scope before reading; Task-room participation is not inferred. |
| Read-only and full: public catalogs | `list_agents`, `get_agent`, `list_models`, `list_skills`, `list_registry_skills`, `list_registry_integrations` | Sanitized catalog metadata only, never secrets or private profile configuration. |
| Full only: work execution | `send_message`, `delegate_task`, `continue_task`, `interrupt_task`, `send_to_session`, `interrupt_session`, `run_independent_review` | Current Station only, same approved scope and current Project execute rights; sandboxed execution only. Steering, continue and interrupt target only grant-created Sessions/conversations/tasks, with persisted lineage; neither `send_message` nor `delegate_task` accepts a supplied `navigate` parameter (even `false`). |
| Full only: work lookup conservatively classed as mutating today | `list_delegated_tasks`, `get_task`, `get_task_events` | Preserve their current mutating classification and dispatch scope; do not relabel for read-only. |
| Full only: conversation updates | `rename_session`, `publish_answer_assessment`, `remove_answer_assessment` | Only delegator-owned, in-scope targets; rename additionally requires grant-created Session/conversation lineage; retain user-title/runtime-managed protections. |

Read-only has 23 tools; full has 36. `delete_conversation` is excluded from v1
full. Persist `createdByOutsideGrantId` on created work and its lineage; a new
superseding grant does not implicitly inherit the old grant's creation ownership.
Before F1 ships, either C1 provides stable CIMD identity with reviewed grant/work
continuity semantics, or the supersession review must explicitly transfer
`createdByOutsideGrantId` for the enumerated running work to the new grant.
Show exactly which work moves, bind IDs/versions into the reviewed target and
activation transaction, and transfer provenance/cancellation ownership before
revoking the old grant. Otherwise supersession cancels the agent's running work
(section 8), especially when Codex re-registers at each login; F1 must refuse
shipping with that unresolved. Stable identity alone is not an automatic work
transfer or proof that this criterion is met. Existing
operator work can be read when admitted, but not renamed, interrupted or steered
by an outside grant. Tool arguments cannot supply or rewrite that provenance.
Project-specific tools refuse on global grants when their target requires a Project. Tool availability is not a promise
that every target is readable; domain membership and target checks still apply.
No tool in read-only may mutate user state, navigate the UI, launch code, create
an app-read continuation, or indirectly dispatch another tool. Audit and token
last-use bookkeeping are security metadata, not delegated work mutations.

**F1 entry criterion: parameter policy at dispatch, before schema stripping or
shared callback invocation**, across all 13 full-only tools and nested calls:

| Parameter whenever supplied | Required policy |
| --- | --- |
| `_userId`, `_delegation`, `_delegationAttestation`, any underscore-prefixed key | Reject whenever present, including null/empty values; derive caller and lineage only from the verified grant. |
| `environmentId` | Absent or the current Station's canonical ID only; no remote or saved environment. |
| `projectPath` | Resolve canonically (including symlinks/existing parent for new paths) inside the approved Project; otherwise refuse. Global grants cannot select a Project path. |
| `conversationId`, `sessionId`, `parentTaskId` on full tools | Grant-created provenance required, including explicitly reviewed transferred provenance where supported. |
| `navigate` | Refuse whenever present, even `false`; no UI navigation. |

The reviewer reported the 23 reads carry none of the full-tool override fields.
Source review confirms a necessary qualification: reads **do have read selectors**
`conversationId`/`sessionId` (for example `get_conversation_messages`,
`read_conversation`, `get_session_digest`, `wait_session` and
`get_answer_assessment_target`). Those retain section 6.1's view admission to
operator work; applying a grant-created-only rule to them would defeat the
read-only coordination journey. They do not gain caller/environment/creation
overrides. Reject underscore-prefixed input for either level before schema
stripping, and verify the read catalog schemas at R4/R6; do not claim all these
parameter names are absent from all 23 tools.

In particular, `navigate_to` is excluded despite its existing read-only label
because it changes UI state; `get_task_basis` and `get_session_inventory` are
excluded because their app-read routes allocate/release capabilities.
`search_sessions` is excluded until its broad search projection independently
supports the grant boundary. Knowledge, personal boards, jobs, notifications,
browser/device controls, work claims, HTML replies, Task memory and pull-request
declarations are excluded in v1 where they require additional ownership,
Session bindings or authority. Tools requiring bound assurance, operator roles,
person approval or credential storage remain excluded at both levels.

The grant gate runs before invoking the tool callback and again at the server
dispatch/domain seam. Effective permission is the intersection of this catalog,
level, current grant, existing Station Control policy and route-specific rules.
Return HTTP 200 JSON-RPC `-32602` “Unknown tool” for an uncatalogued or
insufficient-level `tools/call`, with no `insufficient_scope` challenge that
would induce a reauthorization loop. Reject aliases, unknown commands on shared
leaves, and out-of-scope target IDs before effects. The in-process adapter preserves the
outside authority across nested API calls; it never runs under unscoped server
authority or hands an internal bearer to the client. New caller variants require
exhaustive handling, not a fallback to today's internal principal.

Full cannot answer permission requests (`respond_to_task_request`), change
approval mode, set trust-all-tools, select host execution, change a scheduled
grant or forward to another Station. New dispatches and every continuation
inherit a persisted grant ceiling. Station-owned descendants must not acquire
the operator's bound authority merely because Station starts them. Sandbox and
tool permissions, subdelegation, parent grant ID/version and revocation apply
transitively. If a provider cannot enforce that ceiling, refuse dispatch before
starting it. A prompt telling the child to behave is not enforcement.

Bound child-work creation separately from transport concurrency: default at
most five active grant-created execution Sessions across the whole descendant
tree, at most two child edges below a root, and one in-flight creation per grant.
Reserve capacity atomically before launch; every child is charged to the same
root grant, never to a fresh internal allowance. A terminal child releases its
active slot but not provenance; resume/retry/independent review cannot bypass
limits. Refuse providers lacking enforceable lineage, ceilings or cancellation.
The full slice must test depth, width, concurrent reservation, restart and revoke
at real launch/continuation seams; read-only ships without child execution.

## 7. Sign-in journeys

These are **planned phase-two journeys, NOT_VERIFIED against Station**. Commands
follow the official [Claude Code MCP guide](https://code.claude.com/docs/en/mcp#authenticate-from-the-command-line)
and [Codex MCP guide](https://developers.openai.com/codex/mcp). Capture installed
CLI versions and their exact registration/redirect behavior during acceptance.
The supplied stub observations in section 1 do not qualify these Station journeys.

### 7.1 Claude Code

```bash
claude mcp add --transport http station https://station.example.com/mcp
claude mcp login station
```

1. In an isolated CLI profile, add the server and invoke login. Station's 401
   supplies resource metadata; the client discovers O and registers a public
   client, then starts code authorization with S256 and R.
2. The browser displays Station's identity, exact client ID, unverified client
   label, callback URI, requested level and a host confirmation code. Opening
   this URL or completing client login never itself approves a grant.
3. The host lists requests, compares the displayed code and approves the matching
   request ID with the CLI, or the operator opens
   review on C, signs in through S3 if needed, selects Project/access/expiry,
   and completes one S4 assertion. An unpaired approval browser must pair
   through the existing mechanism or use the host; OAuth is not pairing.
4. The bound requesting browser detects approval and automatically completes
   the code redirect, with no extra click. The client verifies state/issuer and exchanges with its
   verifier and R. It stores its tokens and connects to `/mcp`.
5. List tools, call `search_conversations` and `list_active_work`, then read an
   admitted conversation. A read-only attempt to call a full-only tool fails
   even if the client manually supplies its name.

Claude Code 2.1.308 registered `localhost` in the supplied execution; its URI
including port must match exactly. It reuses its saved client ID and port, so
section 5.2's tombstone page must explain logout/re-login if the ID is retired.
The browser receiving the redirect must be able to reach the client's callback.
Remote-shell login may need the client's documented no-browser workflow; never
send tokens or an operator credential through chat.

### 7.2 Codex

For an interactive installation, run **only**:

```bash
codex mcp add station --url https://station.example.com/mcp
```

`add` immediately starts OAuth login and may open the host's real browser; it
has no `--no-browser`. Do not follow it with `login` for initial setup: the
reviewer's add-then-login run created two DCR registrations and two pending
requests. Use `codex mcp login station` only for a subsequent intentional login.

Acceptance automation instead writes this into a fresh isolated Codex home's
`config.toml`, using setup's **exact R**, then invokes login once:

```toml
[mcp_servers.station]
url = "https://station.example.com/mcp"
```

```bash
CODEX_HOME="$acceptance_codex_home" codex mcp login station --no-browser
```

Set `acceptance_codex_home` to the allocated private test directory. The harness
must not use `mcp add` or open the host's everyday browser. Consume the printed
authorization URL with the isolated acceptance browser and return the callback
URL through the CLI's no-browser input. These TOML and login workflows follow
the [official MCP guide](https://developers.openai.com/codex/mcp); the exact
0.163.0 immediate-login/no-browser behavior is the supplied executed evidence,
with flags independently checked through local CLI help in revision 2.

1. The single login discovers OAuth and uses DCR unless a stable public client
   is configured (section 5.1) or CIMD is supported. Require S256 and exact R.
2. Complete browser comparison/host request-ID approval or C/passkey review.
   Codex 0.163.0 creates a fresh DCR client each login. Show matching grants with
   supersession **unselected**, require explicit disconnect review, and leave
   them active until successful exchange. Name/registration earns no approval.
3. Verify state/issuer and exchange the code. Only this successful exchange
   activates the grant and selected supersessions. Verify discovery, denied
   mutation and strict refresh rotation without second approval before expiry.
4. At grant expiry/revocation or unknown token response outcome, obtain a new
   login/approval. Tombstones guide logout/re-login; they transfer no authority.

Claude Code's supplied login wait ended at 301 s. **Codex 0.163.0's callback
wait is NOT_VERIFIED**: the [official Codex MCP guide](https://developers.openai.com/codex/mcp)
documents startup/tool timeouts, not a version-pinned OAuth browser-wait limit.
Do not substitute those settings or Claude's result. Determine Codex's actual
window in an isolated timed acceptance run before claiming compatibility.

A hosted MCP client follows the same protocol with its exact operator-allowlisted
HTTPS callback and the prominent remote-site warning.
Its hosting account is not Station operator authority. A client without DCR,
S256 or resource indicators is unsupported in v1 and receives a precise error;
never fall back to a pasted API key or weaker OAuth profile.

## 8. Connections, revocation and audit

Add **Outside clients** within Connections, backed by the management projection,
not by ordinary outbound integration records. Each approved client shows escaped
unverified name, client ID, actual callback origin/path, Project, read-only/full,
approval actor/time, last use, expiry and active/expired/revoked status. Show
active sessions/families as counts, not credentials. Pending requests are a
bounded separate view. An ordinary paired browser sees an operator sign-in
action, never another principal's inventory. A session can read the inventory;
Change access/Revoke always requires a new review and step-up. Without C, show
the host CLI action. No generic device-admin scope can manage outside grants.

Revoke commits the deny state and version bump before returning success. Every
request, tool dispatch, domain mutation and result/stream emission consults the
live grant/family/version. No positive authentication cache survives a revoke.
Abort controllers indexed by grant/family close active MCP streams, invalidate
resume/continuation capabilities, cancel queued calls and request cancellation
of running grant-derived work. Revocation succeeds even if a client disconnects.
All processes must share the authoritative store and revocation channel; a
worker that cannot check current state refuses work rather than serving stale
authority. Expiry and authority loss use the same path.

Serialize revoke against effects using the grant's mutation gate: an effect
committed before revoke stays committed; once revoke wins, no subsequent effect
or content emission is admitted, including within an already initialized MCP
session. Cancellation cannot undo bytes delivered or effects committed earlier.
Report that boundary honestly. Phase two must prove the ordering at the actual
side-effect seam and across inherited work, not only at transport admission.

Access/Project/expiry changes require step-up or host confirmation. Any change
updates the active grant in place and bumps its version in one `BEGIN IMMEDIATE`,
with expected version and current-selection digest checks and a before → after
audit event. H may narrow or widen Project/level/expiry within the originally
requested OAuth scopes and the 30-day absolute ceiling from grant creation;
the selected Project must exist. Existing access and refresh tokens retain their
family and immediately use the live selection. Token issuance versions are not
a cached authority ceiling: admission reads the current grant on every request.
R4 must re-admit dispatch, streams and continuation state against that live
version and selection. A terminal grant is immutable and can never be changed
back to active. Each successful first code exchange produces one family and a new
active grant, atomically revoking any reviewed selected supersessions from section 4.1; repeat login is a new explicit
approval. Revoked/expired grants remain visible as bounded history;
removing history never reactivates them. No unreviewed client metadata change
can modify an existing grant.

Audit through Station's structured audit/logger seams: registration accepted or
limited; authorization requested/denied/expired; approval committed/refused;
grant changed/revoked/expired; token issued/refreshed/replay detected; MCP
authentication/dispatch refused; session terminated and cancellation outcome.
Record station/decision/request/grant/client IDs, actor kind and passkey
pseudonym or host channel, Project ID, level before/after, version, reason and
timestamps. Keep tool names and outcomes, not arguments, search strings,
transcript snippets, tokens, state, verifier, browser code or cookies. Use the
atomic outbox so a crash cannot create an unaudited grant; bounded delivery
retries deduplicate by event ID. Private audit retention defaults to 90 days;
capacity pressure refuses new approvals rather than discarding required events.

## 9. Threat model and rejected alternatives

Trusted: Station host OS/private home, configured TLS ingress and consent origin,
operator's authenticator, and the server's current authority records. A stolen
host filesystem or compromised consent origin defeats this boundary. The client
machine, supplied metadata, app-origin plugin content and returned conversation
text are untrusted. A consent-origin passkey does not prove the client publisher.

| Threat | Required mitigation and remaining limit |
| --- | --- |
| Approval phishing / client named like a trusted app | Stable Station identity and exact consent origin, unverified-name label, client ID and actual redirect/resource/Project/expiry displayed together. Host compares codes on its listing and its own browser, then approves by request ID; passkey review binds the displayed inputs. Non-loopback callbacks need an operator-managed origin allowlist and prominent remote-site warning even when the operator browser holds the ticket. No auto-approval based on metadata. An operator can still knowingly approve an attacker. |
| Lookalike metadata, Unicode labels, malicious logo/URLs | Escaped plain text, bounded metadata, no remote fetch/active links, no inferred trusted badge; registration digest bound into approval. Prevent SSRF and stored script injection. |
| Approval CSRF or same-origin plugin | O has no approval commit. C requires initiating live session, exact Origin/Host, Fetch Metadata, nonce, UV and single-use action fingerprint; host path requires host-secret proof. C uses S4 frame/CSP protections. App plugin may request review but cannot decide. |
| Authorization/login CSRF, code interception, open redirect, mix-up | Client state, browser-bound completion nonce, issuer-bound response, exact registered redirect and S256; invalid redirect never receives an error redirect. Actual loopback port is fixed in the request/code. |
| Client-machine token theft | Sixty-minute access with live grant checks on every request/emission, 30-day maximum grant, project/level/audience limits and immediate operator revocation. Hashed server storage does not protect plaintext stolen from the client. Bearer impersonation within the grant remains possible. Sender-constrained tokens are a later design, not claimed here. |
| Refresh replay or racing refresh | Strict atomic rotation and consumed hashes; any bound consumed-token reuse revokes family access/streams (section 5.3). Lost response requires re-login. No recurring grace that lets thief and client share the family, and no recoverable successor/key in storage. |
| Confused deputy / indirect privilege through an internal child | Explicit outside caller; catalog + level + current authority enforced at dispatch/domain seams; no internal-token conversion, host/remote target or approval commands. Inherited ceiling on all descendants or refuse launch. |
| `search_conversations` crosses Projects or leaks another person's work | Stable approved Project + live delegator view at search, transcript admission and activity projection before reading/counting; test native and file-backed sources, foreign IDs/cursors and slug reuse. Content is context, not instructions. |
| Stale connection after revoke or downgrade | Durable version/family checks, effect serialization, per-emission checks and active cancellation. MCP session ID and reconnect never bypass the token. Already committed effects cannot be recalled. |
| Registration spam / operator prompt bombing | Persistent peer/global budgets, hard live caps/TTLs and no notifications on DCR; bounded pending view and explicit operator-initiated ceremony. Quota denial of service remains visible. |
| Same-station home backup restore | Restoring an older backup can roll back revocations: revoked grants and unused refresh tokens from that snapshot can become usable again within their original expiry. After restoring, the operator must revoke all outside grants before resuming outside access. R1 has no issuer key to rotate; hash-only storage cannot detect this rollback. Moving a backup to a different station or issuer is separately refused by the persisted binding. |
| Cross-instance/tenant/token confusion | Exact configured issuer/R/station binding, token format separation, D11 refusal, no wildcard routes or forwarded-host trust. Test all existing auth surfaces reject outside tokens. |

Rejected alternatives:

- Reuse Device/PAT/raw internal credentials for MCP: wrong audience and authority,
  missing client registration, refresh-family semantics and explicit operator review.
- Let a device administrator or signed-in operator cookie approve directly:
  approval is a privileged write and requires the host or per-action passkey.
- Add a deployment-account OAuth login: deployment identity is not the operator;
  it would replace S3/S4 with a parallel system and violate D11's boundary.
- Make `/mcp/station-control` remotely reachable: breaks the engine-child trust
  contract and invites token/caller confusion. Keep a separate router/store.
- Self-contained long-lived JWTs with offline validation: cannot guarantee
  immediate revoke of active transports without checking live state anyway.
- Wildcard redirects, `plain` PKCE, consent remembered by name or a step-up
  window: permits interception, metadata impersonation or unrelated later writes.
- Full means every operator tool: a client-machine bearer cannot establish
  bound assurance or person approval. Full here is scoped agent work.

## 10. Phase-two verification plan

No new tests are implemented in phase one. During implementation follow the
[testing guide](../guides/testing.md), test-audit authoring gate and fault-injection
prerequisites. Evidence must distinguish source review, focused execution,
real-client/browser execution and hosted/release qualification.

| Layer | Required behavior evidence |
| --- | --- |
| OAuth protocol over HTTP | Anonymous 401 challenge → both resource metadata paths → issuer → DCR → authorization → code/PKCE exchange → actual MCP call. Wrong/missing/repeated R, verifier mismatch, missing/`plain` challenge, bad scopes, wrong client and issuer mixing all refuse. Correctly bound reuse of an exchanged code returns `invalid_grant` and revokes its issued family/grant, access and streams; unknown/misbound code probes cannot revoke a grant. |
| Redirect/DCR limits | Exact HTTPS matching, IPv4/IPv6 loopback port exception only, exact localhost port, query/path/encoding/userinfo/fragment negatives; unapproved TTL, client/instance/day caps, bounded limiter keys and restart quota persistence. No metadata URL/remote image fetch. |
| Approval authority | Exercise every matrix row through real middleware: anonymous, Device/admin/PAT, launcher, deployment, internal, remote raw operator, H, S and P. Session alone yields 202 with no grant; only initiating P records approval intent on C; activation waits for exchange. Host listing shows codes only with H; host approval accepts request ID, never code input. Origin allowlist edits require H or their own P ceremony. |
| Transaction binding | Alter each fingerprint input independently; race grant/Project/authority changes during the mutation lock. Replay nonce/assertion, approve twice, wrong session, cancel, expired session, revoked signing passkey and bound Device; prove zero unintended grant/effect. At 5/5, exchange with one selected supersession succeeds; race two approved intents for the last client/instance slot and prove only one activates, loser gets `invalid_grant` with re-login guidance and no partial supersession. |
| Access dispatch | Compare the exact 23/36 tool sets. Enumerate every other registered tool and directly call it by name under both grants. Spy on real domain effects and nested calls; a denied operation must not execute. Include bounded-write, shared command leaves and unknown future registrations. |
| Work discovery | Same principal with two Projects plus global, another principal, native indexed and file-backed transcripts. Search/list/read/digest agree; no out-of-scope snippets, counts, paths or cursors. Each of the 23 reads has a named negative test at its real caller: foreign-Project conversations/Sessions selected by ID appear absent, including same-owner targets. Exercise supported target/Project selectors and lineage; for catalog reads with no conversation/Session selector, refuse unsupported foreign-ID inputs and prove their sanitized metadata cannot expose that target. No helper-only or aggregate substitute for per-tool evidence. Deleted/reused slugs and unknown outside callers fail closed; partial and unavailable sources stay explicit. |
| Full and descendants | An allowed sandboxed in-scope dispatch performs its intended write. Out-of-scope/host/remote/trust-all/approval requests fail. A Station-started child attempts escalation and fails under the inherited ceiling. Provider missing enforcement refuses before launch. |
| Token/storage lifecycle | No plaintext token/code/ticket in database or logs; projections exclude them except H's displayed comparison code. Concurrent reuse, predecessor reuse and older-token replay atomically revoke the only family AND grant (`refresh_replay`), access and streams; seven-day idle expiry expires family AND grant (`idle`). Prove versions/audit, freed per-client capacity and terminal Connections/review status under the same lock, including five repeated lost-response/replay/re-login cycles using Claude's saved client ID, and idle expiry without a replay. Both real CLIs surface replayed-refresh `invalid_grant` as a clean re-login prompt requiring fresh H/P approval. Prove no encrypted envelope/recovery key exists and no short-lived refresh issuance occurs in the final five minutes. Store unavailable/corrupt means no grant use. |
| Immediate revoke | Hold one live stream, queued mutation, paused search and descendant call; commit revoke through H and separately P. Release each paused action and prove no later effect/content or session resume; pre-revoke committed effect remains identifiable. Repeat for downgrade, expiry and authority loss. |
| Crash/restart | Crash around grant/outbox commit, code consume and refresh rotation; reconcile once by decision ID, never mint a duplicate grant or refresh branch; unknown response outcomes require login, never response recovery. Unredeemed approvals leave old grants active; successful code exchange atomically activates/supersedes once. Restart preserves active token expiry and revoked/replay state; pending requests require fresh flow. |
| Existing surfaces | Existing internal child initializes/calls `/mcp/station-control`; its loopback/token behavior stays intact. Exercise engine OAuth proxy negotiation/sign-in regression from #4094/#4108. Cross-present each token at outside/internal/proxy/general API/consent routes and prove refusal. |
| Exposure/UX | Trusted HTTPS over loopback, host-only approval without C; HTTPS DNS + C paired-browser passkey flow; explicit literal-loopback HTTP opt-in works. Refuse every peer except normalized `127.0.0.1`/`::1` (including other `127/8`), proxy/internal attestation, forwarding/Tailscale header, absent HTTP/1.0 Host, duplicate/conflicting Host or HTTP/2 authority and non-byte-exact authority; test port-80 omission. UI proxy excludes outside paths; startup/periodic Serve mappings refuse exposure; raw TCP forwarding is documented residual; HTTPS IP no operator sign-in; hosted registry disabled. Before R6, prove protocol and `/api/outside-agent/*` routes, every outside-clients command (including register/allowlist edits) and Connections are compiled out or inert, with no store writes in released builds. After R6 verify Connections read/change/revoke with operator and ordinary Device. |

Real acceptance uses a fresh Station home and instance name, isolated client
profiles, synthetic Project/conversations and non-default allocated ports
(for example runtime 43141, UI 43001, consent 43143 after checking availability).
Never use the operator's everyday home or ports 3141/3000. Use the documented
TLS issuer mapping with certificates trusted by both real clients (plus a
separate opt-in loopback-HTTP compatibility run), and the
documented consent mapping and existing paired Device/passkey setup; no fixture may
stand in for the real browser assertion.

Run **real `claude mcp login station` and `codex mcp login station --no-browser`**
against that instance with section 7's isolated configs. Write Codex `config.toml`
directly, never add-then-login, and never open the host's real browser. Capture
version pins, discovery/DCR/PKCE/resource requests with secrets redacted, operator approval outcome,
successful tool listing, both discovery calls with expected synthetic results,
denied read-only mutation, refresh, and live revocation. Repeat with full to
prove an intended scoped write, and with no C to prove host listing/comparison and request-ID approval.
Use both an in-scope and foreign Project to demonstrate isolation. Record
actual client redirect forms; an unsupported client version is NOT_VERIFIED or
FAIL, never compatibility PASS from a fixture. Hosted-client acceptance needs
a reachable personal HTTPS instance and its real HTTPS callback; until executed
it remains NOT_VERIFIED, independent of the two CLI passes.

**Timed read-only acceptance is a release gate.** Record timestamps for login
start, page display, optional phone handoff/pairing/sign-in, review, passkey or
host decision, automatic redirect, token exchange and first MCP call. The
Claude journey must finish inside its observed 301-second window (target under
240 s for margin), with no extra browser click after approval. Determine and
record Codex's window with its pinned real CLI and finish inside that window;
until then its timed acceptance is NOT_VERIFIED. Pending TTL ≥10 minutes is a
server bound, not permission to exceed either client window. Cover simultaneous
Claude/Codex tabs under one B, request-specific completion, ticket capacity,
and a stale Claude ID's tombstone recovery without an unsafe redirect.
Prove same-B/client/exact-redirect replacement invalidates only that request,
code/nonce/intent; a second B using the familiar pre-registered client ID cannot
replace it or consume its per-ticket client cap. Review never calls that ID
“your client” or treats it as identity proof.

Required additional boundary cases: default refusal of a malicious HTTPS
callback whose authorize link is opened by the operator; host/P allowlisting
and warning; unselected-by-default supersession of multiple matching Codex
grants, timeout/unredeemed approval leaving old grants intact, exchange-time
atomic supersession with a stale-version race, and background-tab long-poll/SSE
completion; native `application_type`, both-scope requests with read-only
preselection; hourly-token sustained refresh cadence, strict replay on
response-loss retry and final-five-minute clean re-login;
direct/Serve/unverifiable-ingress limiter keys; and hosted-mode 404s.
Test HTTP 200 unknown-tool errors on insufficient level, JSON-RPC `-32601` on
unknown methods such as Claude's `server/discover`, and initialize/calls with
both **2025-06-18** and **2025-11-25**. Authenticate GET `/mcp` before deciding
stream support: no anonymous 405 or missing metadata challenge.

Cross-present outside and VoltAgent/internal tokens at exact `/mcp`,
`/mcp/servers/*`, `/mcp/:serverId/mcp`, `/mcp/station-control` and the proxy in
the full application, in both directions. Prove refusal with no handler effects,
including path-normalization negatives and route-order shadowing. Exercise
host-execution filtered counts only within authorized Project/delegator scope;
a host-only matching dataset yields an explicit filtered/partial result, not
silent “no matches”. Full additionally proves delete refusal, grant-created-only
rename/interrupt/steering, rejected `navigate` presence on both entry tools,
all full-tool parameter policies, reviewed running-work continuity and
child-work bounds.

Name and execute these six fault injections during implementation; each must
make its boundary test fail at the real caller, not merely a helper:

1. Disable the access **audience check**: cross-resource token admission must fail
   the test.
2. Bypass the **catalog gate at dispatch** while leaving listing filtered:
   directly calling a hidden/full-only tool under read-only must fail the test.
3. Suppress **family revocation on consumed-token reuse**: immediate predecessor
   reuse, including before successor redemption, must fail the test. In separate
   variants, terminate the family but suppress only the **grant's terminal
   transition** on replay and on seven-day idle expiry; each zombie active grant
   must fail the capacity/Connections test.
4. Skip the **live grant check on each stream emission**: revoke between read
   and emit and prove the test catches later content.
5. Move the **Project filter after counting**: foreign-Project/host-exclusion
   count leakage must fail the test.
6. Drop the **grant Project check in `conversation-message-reader.ts`** while
   retaining owner checks: `get_conversation_messages` selecting a same-owner,
   foreign-Project conversation/lineage Session by ID must fail the negative
   test through the real `conversations.ts` message route, for file/native reads.

Fault injection starts from a committed clean tree, preserves intervening
changes, and records baseline, injected failure and restored outcomes. Capture
the browser review/Connections states on desktop and a narrow viewport. Restore
configuration and revoke test grants on completion; retain only redacted receipts.

## 11. PR-sized implementation slices and documentation owners

Do not start these slices until the owner reviews this draft. Each slice is
independently reviewable but not feature qualification; keep exposure disabled
until the complete read-only chain passes. Before R6, a compiled release guard
returns 404 for every outside protocol leaf **and `/api/outside-agent/*`
management/host route**, refuses all `station environment outside-clients`
commands (including `register`, approval/change/revoke and redirect/CORS
allowlist edits), and omits or leaves the Connections outside-client UI inert.
No outside-agent store write may reach a released build through any of these
surfaces, even with valid host/operator proof. The HTTP guard runs before
hosted/auth middleware and route handlers. It matches Hono's once-decoded
`c.req.path` and refuses encoded spellings of guarded segments as well as their
literal paths, including trailing slashes. It preserves Hono's case-sensitive,
strict slash semantics: no case folding, slash collapse or recursive decoding.
The guard refuses feature enablement;
no environment variable, operator command, configuration or UI toggle can turn
it on. R1–R5 exercise routes only in isolated non-distributable test builds with
a test-only composition entry point. R6 removes the compiled refusal only in
the reviewed release change after its evidence passes; runtime opt-in then
remains required. S4 is merged and main has been
integrated; implementation still requires review of this design.

| Slice | Scope and acceptance | Depends on |
| --- | --- | --- |
| R1 | Hash-only private store, immutable DCR metadata, per-ticket pending bounds/replacement, tombstones, grant versions/intents, strict rotation and atomic outbox; only-family replay/idle transitions revoke/expire the grant with `refresh_replay`/`idle` under one lock and free active capacity; code-reuse revocation; lifecycle/fault tests. No envelopes/key or public access. | Reviewed design, S4 |
| R2a | Shared guarded approval/grant/allowlist decision service; host commands including pending codes/details, request-ID-only approve/deny, grant list/change/revoke, stable public pre-registration and canonical exact redirect/CORS origin management. Approval records intent; activation/supersession remains at exchange. Compiled refusal remains. Owner split from R2 on 2026-10-24; #4115 owns delivery. | R1 |
| R2b | Follow-up: S4 typed ConsentTransaction targets and consent-origin review for approve/deny/revoke/level change and both allowlists, decided by `operator-passkey`; uses R2a's shared semantics without another host implementation. Compiled refusal remains. | R2a |
| R3 | **OAuth server endpoints only:** metadata, DCR, authorize/long-poll or SSE wait/automatic completion, token/strict refresh, issuer/exposure/redirect/CORS policy and budgets. Per-request loopback predicate, Serve checks and tested UI proxy exclusions. No `/mcp` transport. | R1, R2a, R2b |
| R4a | Separate `/mcp` router, transport/version negotiation, auth, exact route classification, catalog listing/dispatch gate with a couple of scoped reads (e.g. `list_projects`, `get_project`), revocation at each emission. Other tools fail closed; full selection disabled. | R3 |
| R4b | Grant caller/read admission for discovery plus `search_conversations`/`list_active_work`, pre-projection Project filtering, host-exclusion partial/count semantics and foreign-ID/cursor refusal. | R4a, existing read owners |
| R4c | Remaining reads completing the exact 23-tool catalog; `conversation-message-reader.ts`, `conversations.ts` message/list routes and `conversation-reference-read.ts` caller/admission branches explicitly require live grant Project checks across file/native/lineage reads. Exhaustive outside-caller handling in `isPrincipalScopedAgentRequest`; unknown callers refuse. Named foreign-Project ID negative evidence for each of 23 reads, plus the sixth reader-Project fault injection and per-emission revocation. | R4b |
| R5 | Connections grant/pending listing, review/change/revoke, audit/expiry/recovery UX; consumes R2's commands and decision service without a second host-command implementation. H/P revoke live transports. | R2a, R2b, R4c |
| R6 — read-only milestone | Real Claude login and Codex **config-file + `login --no-browser` harness**, no host browser; timed host/real passkey approval, protocol/token lifecycle, 23-tool reads/denied mutation, tombstone/pending replacement, exchange-time supersession and live revoke/fault proof. Only after this passes may the compiled refusal be removed and explicit read-only opt-in ship. | R3–R5 |
| C1 — next interoperability follow-up | CIMD with bounded validated fetching/cache and SSRF/metadata-change review; real Codex 0.163.0 `--oauth-client-registration CIMD` acceptance, explicit review/redirect policy. DCR and R2 stable public pre-registration remain supported. | R6 |
| F1 — separate full milestone | Add 13 full-only tools (36 total), parameter policy in section 6.2, grant-created ownership, no delete/UI navigation, transitive ceiling and atomic child-work limits. **Entry criteria:** C1 with reviewed work continuity, or explicitly reviewed atomic transfer of running-work `createdByOutsideGrantId` with visible work inventory; no silent cancellation by supersession. Prove every parameter policy, scoped writes, provider enforcement, replay/revoke/effect ordering and real two-client full acceptance before enabling full. | R6 and the stated continuity/parameter criteria |

Hosted-client compatibility against a personal HTTPS Station is separately
qualified after redirect allowlisting, never inferred from the two local CLIs.
Hosted Station tenants remain disabled. The delivery order is read-only end to
end (with stable public pre-registration), CIMD interoperability follow-up,
then the independently reviewable full/child-limit slice; full never blocks the
read-only milestone. The owner-delegated clarification on 2026-10-24 resolves M4/M8's original ordering conflict in favor
of this order: coordination is mostly reads, CIMD stabilizes Codex client
identity for read-only users, and full/child enforcement is the larger risk.
Explicit supersession remains in read-only, committed only on successful code
exchange; F1 has the additional running-work continuity entry criterion.

During implementation update [Connections](../guides/connections.md),
[operator passkeys](../guides/operator-passkeys.md), [deployment](../guides/deployment.md),
[remote-access threat model](../security/remote-access-threat-model.md),
[CLI reference](../reference/cli.md), [module map](../architecture/module-map.md)
and the affected Station Docs/MCP learning inputs. Add an OAuth route/token
reference and runnable personal-Station integration example through the normal
documentation map. Keep this proposal marked as a design until those changes
ship with their own evidence. Revision 3 changes only this design record;
regenerating the design index produces no byte change. Current guides retain
their shipped-behavior claims.

**R2b isolated evidence:** [typed passkey targets, caught faults and inspected review pages](outside-agent-mcp-r2b-evidence.md). The compiled refusal also covers outside transactions on the shared consent listener. This receipt does not qualify R3–R6 or enable the feature.

## 12. Decisions and open owner question

### Decided (owner-delegated, 2026-10-24)

These are the owner's delegated decisions for design revision 3, retaining
revision 2's decisions with the third review's eight minor clarifications and replacing
superseded revision-1 decisions. They are not unresolved recommendations or
authorization to implement. Unchanged proposal defaults are listed separately
below; implementation and runtime qualification are separate.

| Item | Decision |
| --- | --- |
| B1 / Q3 | Access 60 minutes; seven-day idle refresh and 30-day absolute grant maximum/default retained. Strict RFC 9700 rotation: any consumed-token reuse revokes the family; lost response means re-login. No successor envelope/key. Hash-only replacement-successor fallback is future-only, gated on response-loss soak evidence. Cadence-derived budgets and live revocation are in sections 5.2–5.3 and 8. |
| B-1 reversal evidence | Three concurrent Claude processes made 12 sequential rotations with no predecessor reuse; three concurrent Codex startups made exactly one refresh via lock files. Supplied EXECUTED stub evidence, not Station qualification. Repeated same-successor grace permits indefinite thief/client co-tenancy; adjacent/backed-up key defeats hash-only custody. |
| M-a | All loopback-HTTP predicates hold per request, no proxy-prefix exposure, startup/periodic Serve mapping refusal; undetectable raw forwards remain an operator residual. |
| M-b | Approval records intent only. Activate grant and selected supersessions at first successful code exchange; unredeemed intent void by pending TTL + code TTL. Long-poll/SSE waiting, no timer-driven completion. |
| M-c | F1 requires CIMD with reviewed continuity or explicit reviewed transfer of running-work creation ownership, with the operator shown what moves. |
| M-d | F1 gate rejects underscore keys and navigation, confines environment/path and requires grant-created full-tool targets. Read selectors still use scoped view admission; the literal claim that all 23 reads lack session/conversation IDs is contradicted by source (section 6.2). |
| Origin-policy minors | Both redirect and CORS Origin allowlists have matrix rows, typed canonical targets, H/P authority, explicit no wildcard/pattern, and IDN/default-port/trailing-dot normalization. |
| CLI/registration minors | Codex add immediately logs in; acceptance uses direct config + `login --no-browser`. Both CLIs accept stable public pre-registration; recommend bounded host-issued IDs in R2 before C1's network-metadata work. Setup prints exact R; localhost refusal names it. |
| Lifecycle/capacity minors | Port-shared B cookie residual is low-impact with PKCE; final-five-minute token issuance refuses cleanly; only same B/client/exact redirect replaces older pending, with per-ticket client caps; host-issued IDs are not identity proof. Activation enforces caps after selected supersessions, with `invalid_grant` for the last-slot race loser. Only-family refresh replay/idle ends the grant (`refresh_replay`/`idle`); correctly bound code reuse revokes its issued family/grant (`code_replay`). ≥128-bit client IDs and 500/day × 30 days < 20,000 tombstone invariant. |
| M1 | Host lists pending requests with codes/details; operator compares with their browser and approves by request ID. CLI never accepts code input. |
| M2 | Refuse non-loopback redirects by default. Operator-managed HTTPS redirect-origin allowlist requires H or passkey step-up; review prominently labels access sent to a remote site. |
| M3 | Automatic callback completion after approval, no extra click; ten-minute pending TTL, separate five-minute S4 ceremony. Timed end-to-end acceptance must fit Claude's observed 301 s and Codex's still-unverified client window. |
| M4 / Q7 | Review existing active same-delegator/scope/software grants, leave every supersession UNSELECTED and require explicit disconnect review; commit activation and selected supersessions only at first successful code exchange. CIMD is the explicit immediate follow-up after read-only; confidential-client auth remains deferred. |
| M5 | Bounded 30-day client-ID tombstones support local error pages naming CLI logout/re-login, never redirects for unknown/retired clients. |
| M7 / Q1 | Read-only 23 tools; later full 36, excluding `delete_conversation`. Rename/interrupt/steering only on grant-created work. F1 requires the complete per-parameter policy and read-selector qualification in section 6.2, beyond just `navigate`. |
| M8 (clarified) | Read-only → CIMD → full/child-work limits. Keep OAuth endpoints then `/mcp` as separate read-only slices, and exchange-time supersession within read-only. R4 is split into R4a/R4b/R4c, R2 owns host commands, and exposure has a compiled refusal until R6. The owner's 2026-10-24 clarification selects M4's ordering over the original conflicting M8 ordering (section 11). |
| Q4 | Host-only approval without valid C; hosted Station tenants disabled. Non-loopback exposure requires HTTPS. Explicit same-machine literal-loopback HTTP uses the per-request predicate, UI proxy exclusions and periodic Serve checks; local traffic/TLS practicality justify it, with raw TCP forwarding as an operator residual (section 2). |
| Q5 | Revoke on revocation of **the passkey that last decided** a grant, or loss/rotation of its applicable host/delegator authority. Ordinary operator-session expiry alone does not end a durable grant. |
| Q6 adjustments | Size refresh budgets for the measured client cadence and derive peers per ingress. Other bounded quotas and retention remain proposal defaults. |
| R1 audit capacity (owner, 2026-10-24) | Admission ceiling: **100,000 retained security/lifecycle audit events**, configurable downward only. Registration, pending/request terminal outcomes, approval, activation, supersession, replay, idle expiry, revocation and code reuse count. Individual successful refresh rotations and MCP requests do not create audit events; durable consumed/successor hashes retain rotation state. Prune delivered events past 90 days before capacity checks; never evict undelivered events. At capacity, refuse new OAuth state with `audit_capacity` and an unhealthy diagnostic. After saturation, only `terminal`, `request-ended` and `retired` audit events are exempt from the ceiling; every path that creates live rows is refused. These settlement events are never refused or dropped for audit capacity. Revocation, replay/code-reuse revocation and idle expiry must still succeed. This is R1 private-store policy, not release exposure or client qualification. |
| Protocol and routing minors | Insufficient-level tools: HTTP 200 JSON-RPC unknown tool, never 403 `insufficient_scope`. Both-scope requests are normal; preselect read-only. Exact-path outside `/mcp` classification with hosted-mode refusal and two-way VoltAgent/internal isolation; anonymous GET challenge; unknown-method JSON-RPC errors; protocol 2025-06-18 and 2025-11-25. |
| Browser and proof minors | Up to five pending requests per browser ticket; no cancellation across tickets or independent CLI logins. Audience, dispatch catalog, terminal family/grant replay/idle transitions, per-emission live grant, pre-count Project filter and message-reader Project admission are the six named fault injections in section 10. Every read has negative scope evidence. Section 11's compiled refusal covers protocol, management/host APIs, commands and Connections through R6. |

Unchanged proposal defaults (not newly delegated decisions): Q2 retains one
stable Project or explicitly selected global per grant; Q6 retains the other
bounded quotas and 90-day private audit retention; Q8 retains explicit approval
for every authorization-code login, with refresh handling ordinary reconnects
and no registration/name/browser-session-based silent approval. **Q8: A lost
refresh response or any replay ends the grant; the client must log in again,
which needs a fresh operator approval (host CLI or passkey).** Section 5.3
distinguishes client-observed response loss from the server's replay/idle
terminal-state triggers; section 10 requires clean `invalid_grant` re-login
prompts from both CLIs.

### Open: host-execution visibility (M6)

**Owner question:** should an outside grant ever discover/read work that ran
`host`? Recommendation for v1: retain the current bearer-exposed exclusion,
with explicit `host-execution-filtered` partial/count reporting from authorized
scope as section 6.1 specifies. The owner's delegate selects this conservative
v1 behavior, while leaving the broader visibility decision genuinely open for
the owner to override. Alternative: a later explicit per-grant operator opt-in,
with a separate host-data read threat model and admission review; it would not
permit host execution or change the operator's default visibility. Silent
omission or silent widening is not an option.

No implementation, real Station OAuth login, browser/passkey acceptance or
hosted/release qualification is claimed by this design revision.
