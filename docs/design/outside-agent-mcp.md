# Outside-agent MCP with OAuth sign-in

> **Status: proposal for owner review, 2026-10-24. Design only; no implementation or runtime qualification.**
> Owner: Station operator/identity and Station Control maintainers. This proposal
> builds on [operator device access](operator-device-access.md), S3 (#4102) and
> S4 (#4107). The draft is stacked on #4107 until it merges; integrate subsequent
> main changes with `git merge origin/main`, never rebase.

## 0. Outcome and boundaries

An agent that Station did not start can connect to a personal Station's HTTP
`/mcp` endpoint, use standard MCP OAuth discovery and sign in once. The operator
approves that client, selects a Project and access level, and can revoke it in
Connections. Read-only is the default; full permits the explicitly listed agent
work operations within that Project. Neither level delegates operator identity,
permission approval, host execution, credential management or another Station.

Approval is a privileged write. A host CLI confirms a code displayed in the
requesting browser, or an existing device-bound operator passkey session requests
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
The following are source observations, not executed authentication evidence.

| Existing seam | Observation and proposed extension |
| --- | --- |
| [ConsentTransactionStore](../../src-server/services/consent/consent-transactions.ts) | Five-minute transactions, render nonces, revalidation and a guarded commit already exist. Add three typed outside-client targets to the operator-action checks. |
| [Consent listener](../../src-server/runtime/consent/consent-listener.ts) | S4 checks exact trusted Host/Origin, same-origin Fetch Metadata, initiating session, nonce and a fresh assertion. Reuse its review and decision routes. |
| [Operator sessions](../../src-server/services/identity/operator-sessions.ts) and [operator guide](../guides/operator-passkeys.md) | Device/passkey-bound sessions, 15-minute idle and 12-hour absolute limits. Keep these limits; background status reads never renew activity. |
| [Station Control policy](../../src-server/tools/station-control-policy.ts) and [registry](../../src-server/tools/station-control-mcp-server.ts) | Shared tool implementations have assurance, role and operation policies. The outside catalog is an additional restriction, applied at listing and dispatch. |
| [HTTP MCP route](../../src-server/routes/mcp/station-control-mcp-route.ts) | Internal HTTP MCP has loopback and per-session token checks. Do not widen this route or reuse its credentials. Add a separate inbound router. |
| [Request authority](../../src-server/security/station-control-request-authority.ts) and [caller](../../src-server/runtime/mcp/station-control-caller.ts) | Existing callers derive ownership and Project from Station-started Session records. Add an explicit grant-derived caller variant; never invent an engine Session to obtain authority. |
| [Conversation discovery](../../src-server/routes/chat/conversation-work-search.ts), [conversation admission](../../src-server/routes/chat/conversation-reference-read.ts), [activity](../../src-server/routes/orchestration/session-project-activity.ts) | Discovery already filters by caller and admission before returning content. Extend those admission paths to grant callers, preserving partial/unavailable results. A `projectSlug` filter is not authority. |
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
  directory. Codes/tokens are hashes; no bearer appears in app configuration.
- **Connections projection and host commands** show grants and pending requests,
  with server-derived identity and before/after authority. They cannot decide
  from client metadata alone.

## 2. Exposure and origins

Enable explicitly per instance. Configure one canonical external origin `O`;
its exact resource identifier `R` is `O + /mcp`, with no query or fragment.
The issuer is exactly `O`. These are persisted configuration, never inferred
from Host, forwarded headers or tool arguments. An origin/issuer change revokes
existing grants and requires new registration and approval. Do not silently
retarget tokens or redirect a bearer request between origins.

`C` is the existing `STATION_TRUSTED_CONSENT_ORIGIN`, a separate HTTPS origin
that reaches only the consent listener. It may share O's DNS name on a different
port, as in S3/S4; it must remain a different origin. Operator cookies reaching
both ports do not authorize ceremonies on O. Browser approval on C requires
the already paired Device and operator session used by S3. The OAuth client
itself does not become a paired Device.

| Station address | Serve `/mcp` and OAuth on O? | Approval channel |
| --- | --- | --- |
| Literal loopback HTTP, e.g. `http://127.0.0.1:43141` | Yes, explicit local-only mode. Bind to loopback; verify direct socket and configured Host, reject forwarding ingress. No alternative hostname aliases. | Host CLI. A separately configured valid C may support passkeys; plain loopback alone does not enable them. |
| LAN or tailnet IP over HTTP | No; no discovery, registration, token or MCP access. Return 404. Tailnet encryption does not make an HTTP browser origin a WebAuthn origin. | Host CLI can administer local grants, but cannot enable insecure remote OAuth. |
| Configured HTTPS DNS origin on LAN or Tailscale | Yes, through an explicitly trusted TLS ingress that strips untrusted forwarding headers. All other hosts are refused. | C with S4 step-up, or host CLI. |
| HTTPS IP literal, or HTTPS DNS origin without C | OAuth transport can be enabled with valid TLS, but D10 still forbids remote operator sign-in on an IP-only Station. | Host CLI only. No app-origin approval fallback. |
| Public HTTPS, single personal Station | Optional explicit exposure; same issuer, rate limits and operator gates. No public exposure enabled by default. | C with S4 step-up, or host CLI. |
| Station with a hosted tenant registry | No: fail startup configuration or return 404 for this feature's entire route family. | D11 requires a separate tenant-authority design before enabling it. |

The browser authorization landing/wait page is on O. It can display a code and
pending outcome; it cannot grant, revoke or change access. With no HTTPS C,
**host-CLI approval is the only approval path**, including for a browser on the
host. The host never pastes an operator credential into that page.

For browser MCP clients, validate any supplied Origin against an operator-set
exact allowlist. No wildcard credentialed CORS. Permit preflight only for
advertised MCP/OAuth methods and headers; never allow CORS on management or
consent writes. Native clients without Origin use bearer/PKCE checks. Reject
an untrusted Origin even when a bearer is valid. These rules supplement Host,
TLS and DNS-rebinding defenses; they do not confer operator authority.

## 3. Route and authority matrix

All paths below are proposed except the existing consent paths. O serves
protocol routes; C serves consent; runtime management APIs serve the app and
host CLI. Public OAuth routes deliberately bypass the ordinary Device pairing
admission, **only for these exact paths**, and install their own validators.
They must never become a blanket exemption for `/api`, `/mcp/*` or `/oauth/*`.

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
| O `GET /oauth/authorize/status` | B, same-origin fetch; no code or client ID as credential | Own pending/approved/denied/expired status only; no grant inventory or tokens. No idle extension. |
| O `POST /oauth/authorize/complete` | B + one-use page nonce, exact O Origin/Host and same-origin Fetch Metadata | After a committed approval, issues code once and 303 to the stored validated redirect with `code`, unchanged `state` and `iss`. Denial returns `access_denied` only to that validated redirect. |
| O `POST /oauth/token` | Form-encoded public client `client_id` and authorization code + verifier + exact redirect + `resource=R`; or refresh token + `client_id` + `resource=R` | Atomic code exchange / refresh rotation. Cookies, A and operator credentials cannot substitute. OAuth errors, never HTML login. |
| O `POST /mcp`, `GET /mcp`, `DELETE /mcp` | A in Authorization header only, audience R; each request rechecks grant/family/version and session ownership | Streamable HTTP; initialize/call, event stream/resume, close own session. Missing/invalid bearer: 401 with metadata challenge. Valid token with insufficient level: 403. No query/cookie bearer. |
| O `OPTIONS` for register/token/mcp | Anonymous exact-allowlisted browser Origin | Preflight only, zero authority; other methods return 405. |
| Runtime `GET /api/outside-agent/clients` | H or S | Sanitized approved/expired/revoked inventory and pending request metadata; never browser codes, tickets or tokens. All other callers refused. |
| Runtime `GET /api/outside-agent/requests/:id` | H or S | Sanitized snapshot for operator review; no authorization secret. Missing and foreign records are indistinguishable. |
| Runtime `POST /api/outside-agent/requests/:id/approval` | S + expected request/registration versions, selected permitted level/Project/expiry | 202 `step_up_required` and transaction owned by S; no grant yet. H uses the host confirmation route, not this route. |
| Runtime `POST /api/outside-agent/grants/:id/change` | H with host proof, or S; expected grant version and complete next grant | H applies directly with expected-state checks; S gets 202 and a new transaction. Cannot change client/redirect/resource in place. |
| Runtime `POST /api/outside-agent/grants/:id/revoke` | H with host proof, or S; expected grant version | H applies directly; S gets 202 and a new transaction. Neither A nor a paired admin Device can revoke grants. |
| Runtime `GET /api/outside-agent/transactions/:id` | H or the initiating S only | S4-style terminal status and non-secret effect; never a code or token. Background read does not renew S. |
| Host `POST /api/outside-agent/host/confirm` | H + browser-displayed code + expected request/client fingerprint and reviewed selection | Approves once through shared commit service. No browser session or network-locality shortcut. |
| Host `POST /api/outside-agent/host/deny` | H + code + expected request/client fingerprint | Denies pending request once. No grant is created. |
| C `GET /consent/:id` (existing) | Initiating S, matching WebAuthn transaction | Escaped review and fresh render nonce/challenge. No mutation. Other S gets 404. |
| C `POST /consent/:id/decide` (existing) | P + nonce + transaction-bound assertion for approval; initiating S + nonce for cancellation, as S4 | Only `operator-passkey` commits approval. Exact C Origin/Host, same-origin Fetch Metadata, JSON body, UV and session freshness required. Generic consent authorities refused. |

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
operator targets. They require `ceremony: 'webauthn'`, `operatorSessionId`, and
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
 responseType:'code', codeChallengeMethod:'S256', codeChallenge, stateDigest,
 requestedScopes, requestedAccessLevel, selectedScopes, selectedAccessLevel,
 projectScope:{kind:'project',projectId}|{kind:'global'},
 delegatingPrincipalId, approverAuthorityRevision, expiresAt,
 existingGrantId, expectedExistingGrantVersion, expectedExistingGrantDigest}

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
```

`registrationDigest` binds **all** accepted registration metadata, including
the entire redirect list and displayed name; `expectedGrantDigest` binds all
current grant fields, including expiry. The requested access level is derived
from validated scopes, not a display string. Selection cannot exceed requested
scopes or the approver's current authority. A narrower selection is shown
before assertion and returned explicitly in the token response. Editing a
selection requires a new snapshot/review, not rewriting the asserted action.
For a first approval the three existing-grant fields are `null`. A re-login
may replace an active grant only for the same client, actual redirect, resource,
delegator and Project, with its ID/version/digest captured and reviewed. It
invalidates the previous family atomically. A revoked/expired grant is never
reactivated; approval creates a new ID. An access change cannot exceed the
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

Approval inserts or conditionally replaces the grant and marks the request approved in one
SQLite transaction, conditional on its pending version. It records the deciding
passkey ID or host actor and an audit-outbox row, with a unique decision ID.
Grant change/revoke similarly compare-and-swap the version and commit an outbox
event atomically. Reconciliation can report an already recorded outcome by
decision ID; it cannot execute the mutation twice. Pending in-memory consent
transactions expire on restart; they do not recreate an approved request.

The consent response/status contains grant ID, version, level, Project and
expiry only. **No OAuth code, access token or refresh token is a consent
effect.** The bound requesting browser completes the redirect; the client
redeems the code. A lost redirect/code response requires a new authorization
request and approval, not recovering plaintext from a status endpoint. Failed
code exchange or refresh with an unknown outcome likewise requires login;
the server stores no plaintext token response for replay.

### 4.3 Host CLI alternative

Proposed commands are `station environment outside-clients list`,
`approve <code> --project <slug> [--access read-only|full] [--expires-in 30d]`,
`deny <code>`, `change <grant-id> …` and `revoke <grant-id>`.
Global space needs an explicit `--global`; never infer it from an unknown slug.

The browser shows a random six-digit code, unique among live requests, expiring
after five minutes. CLI listings show IDs, age, redirect, Project and untrusted
client name, **not the code**. An interactive approval prints the whole target
and asks the host operator to compare the browser and terminal. Noninteractive
approval additionally requires `--client <exact-client-id>` and an expected
request fingerprint obtained through the host channel. Five wrong codes per
five-minute host-confirmation window lock attempts until the window passes.
The code locates a pending request; it never authenticates an approver.

Host approval uses a direct domain commit, like S4's host alternative; it does
**not** forge an `operator-passkey` ConsentTransaction decision. It uses the same
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
implicit flow and any unknown grant. DCR is supported; client-ID metadata URL
fetching is not advertised in v1. A metadata-only client must use DCR or wait
for a separate implementation; never fetch arbitrary client-supplied URLs.

An unauthenticated `/mcp` request returns 401 and
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
`station-control:full` requests both read and full; the review initially selects
read-only even when full was requested. No silent full grant because a client
requested every advertised scope. The token response reports the actual scopes.

Redirect matching is byte-exact against the stored registration; no prefix,
wildcard, path normalization, subdomain or query flexibility. Reject userinfo,
fragments, controls and malformed/ambiguous encodings. HTTPS redirects require
an exact URI. HTTP is allowed only for native loopback redirects. The sole
port exception is [RFC 8252 §7.3](https://www.rfc-editor.org/rfc/rfc8252#section-7.3):
literal `127.0.0.1` or `[::1]` may change port, with scheme, host, path and query
otherwise identical. Bind the **actual** redirect, including its port, into the
approval and code; token exchange must repeat it exactly. `localhost` is
accepted only with its exact registered port; it gains no port exception and is
not interchangeable with an IP literal. Private schemes are outside v1.

B is a 256-bit random authorization-browser ticket, hashed server-side, in a
host-only HttpOnly SameSite=Strict cookie scoped to `/oauth/authorize`, Secure
on HTTPS. Bind it to request ID and issuer; five-minute expiry. The initial GET
may be cross-site, but any status/complete action requires the bound ticket,
and completion requires a separate one-use nonce. C's review link identifies
the request, not the ticket. S3 sign-in occurs through its existing page; the
operator returns to review without treating a return URL as authority.
Only one pending request is bound to a browser ticket; starting another replaces
that binding and cancels the older pending request. Retain raw OAuth state only
in volatile request memory until completion, with its digest in durable state;
after restart require a new flow instead of reconstructing the callback state.

### 5.2 Dynamic registration and denial-of-service budget

[RFC 7591 DCR](https://www.rfc-editor.org/rfc/rfc7591) accepts JSON, at most
16 KiB. `redirect_uris` is required (1–5 URIs, at most 2048 bytes each).
Accept bounded optional `client_name` (128 characters), `client_uri`, `logo_uri`,
`policy_uri`, `tos_uri` (2048 bytes each), contacts (at most three short
addresses), `scope`, `grant_types`, `response_types` and
`token_endpoint_auth_method`. Defaults are authorization-code/refresh-token,
code response and `none`; reject incompatible values. Unknown metadata is
ignored, never echoed/rendered or made authoritative. Return 201 with random
`client_id`, `client_id_issued_at` and accepted metadata; no client secret or
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
| Pending authorization requests | 3/client, 5/peer, 50/instance; five-minute TTL |
| Authorization starts | 10/minute/peer, 30/minute/instance |
| Token exchange/refresh | 30/minute/client and peer; 120/minute/instance; at most 5 failed verifier attempts/code |
| MCP transport | 5 sessions/grant, 10 calls in flight/grant; 1 MiB request and bounded response/stream queues |

Charge trusted ingress-derived peer identity, never an unverified forwarding
header. Global budgets still apply to attackers with many addresses. Persist
daily counters/capacity accounting; restarting cannot erase the quota. Limit
limiter-key cardinality and evict expired keys, not quota evidence. Reject before
allocating records; return 429 with Retry-After. TTL cleanup runs on allocation
and a bounded periodic sweep. Never evict an approved client to admit spam.
Unapproved DCR alone does not generate operator notifications. Pending requests
appear as a bounded count; no modal or passkey prompt opens unsolicited.
Denied/expired records keep only bounded audit metadata; approved registrations
remain while a grant or security tombstone references them, then expire after
30 days without a live grant. These bounds permit denial of service by quota
exhaustion, but bound storage and operator interruption; availability is not an
approval bypass.

### 5.3 Token and grant records

| Artifact | Format and binding | Lifetime / consumption |
| --- | --- | --- |
| Authorization code | `oac_` + 32 random bytes, base64url; hash stored with client, actual redirect, S256 challenge, R, request/grant version | 60 seconds; atomically consume after successful verifier and binding checks. Reuse is refused. |
| Access token | `oat_` + 32 random bytes, base64url; opaque, hash stored with issuer/station, R, grant ID/version, client, subject, family and scopes | 5 minutes, capped by grant expiry; valid only as `/mcp` Authorization bearer. |
| Refresh token | `ort_` + 32 random bytes, base64url; hash with client/R/grant/family/sequence, issued/used timestamps | Rotate on every success; 7 days idle, capped by the grant's absolute expiry. No reuse grace. |
| Grant | Random ID; active/revoked/expired; delegator, approval actor, immutable client/redirect/R, Project ID or explicit global, originally requested scopes, selected level/scopes, version, created/last-use/expiry | Default 30 days absolute, selectable shorter, maximum 30 days in v1. No automatic extension or refresh beyond expiry. |
| MCP session | Random opaque ID bound to grant, family, version, issuer and transport | At most 30 minutes idle and never beyond grant expiry; ID alone grants nothing. Reauthenticate each request. |

Hash all high-entropy secrets using domain-separated SHA-256; perform constant-time
comparison when comparing secret-derived bytes. Prefixes are format separation,
not authority. Keep token responses `Cache-Control: no-store`; tokens never
appear in URLs, logs, traces, analytics, audit or Connections. The client is
responsible for its own token custody. Store no verifier; store only the S256
challenge until code consumption/expiry. Redact browser state and authorization
query values from ingress logs. Persist audit/request digests rather than secrets.

Refresh rotation uses one atomic compare-and-swap: mark old hash used and insert
next refresh/access hashes. Retain consumed-token hashes as family tombstones
through grant expiry plus five minutes. A replay of any consumed family member
revokes **the entire family**, including current access tokens and all its MCP
sessions, per the strategy in [RFC 9700 §4.14](https://datatracker.ietf.org/doc/html/rfc9700#section-4.14).
Concurrent refreshes have one winner; the loser triggers family revocation.
Clients must serialize refresh; a dropped response requires login, never replay
of the old token. Unknown tokens get generic `invalid_grant` without revoking
an unrelated family. A wrong client/resource cannot redeem a token.

The outside access-token verifier is registered **only on `/mcp`**. General
runtime authentication, consent, pairing, internal MCP and engine-proxy routers
must reject these token formats. Refresh tokens and codes are accepted only as
form parameters at `/oauth/token`, never as route credentials. No token exchange,
passthrough to another server or conversion into Device/operator authority.
The store fails closed on corruption/unavailability. Reset/credential rotation
revokes grants; passkey revocation ends grants that passkey approved. Operator
session expiry alone does not end an intentionally durable grant. Revoked host
or delegator authority cannot keep a grant alive.

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
| Full only: work execution | `send_message`, `delegate_task`, `continue_task`, `interrupt_task`, `send_to_session`, `interrupt_session`, `run_independent_review` | Current Station only, same approved scope and delegator-owned targets, current Project execute rights; sandboxed execution only. |
| Full only: work lookup conservatively classed as mutating today | `list_delegated_tasks`, `get_task`, `get_task_events` | Preserve their current mutating classification and dispatch scope; do not relabel for read-only. |
| Full only: conversation updates | `rename_session`, `delete_conversation`, `publish_answer_assessment`, `remove_answer_assessment` | Only delegator-owned, in-scope targets; retain user-title/runtime-managed protections. |

Read-only has 23 tools; full has 37. Project-specific tools refuse on global
grants when their target requires a Project. Tool availability is not a promise
that every target is readable; domain membership and target checks still apply.
No tool in read-only may mutate user state, navigate the UI, launch code, create
an app-read continuation, or indirectly dispatch another tool. Audit and token
last-use bookkeeping are security metadata, not delegated work mutations.

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
Reject aliases, unclassified methods, unknown commands on shared leaves, and
out-of-scope target IDs before effects. The in-process adapter preserves the
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

## 7. Sign-in journeys

These are **planned phase-two journeys, NOT_VERIFIED against Station**. Commands
follow the official [Claude Code MCP guide](https://code.claude.com/docs/en/mcp#authenticate-from-the-command-line)
and [Codex MCP guide](https://developers.openai.com/codex/mcp). Capture installed
CLI versions and their exact registration/redirect behavior during acceptance.

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
3. The host compares the code and confirms with the CLI, or the operator opens
   review on C, signs in through S3 if needed, selects Project/access/expiry,
   and completes one S4 assertion. An unpaired approval browser must pair
   through the existing mechanism or use the host; OAuth is not pairing.
4. The bound requesting browser sees approval, chooses Continue, and receives
   the code redirect. The client verifies state/issuer and exchanges with its
   verifier and R. It stores its tokens and connects to `/mcp`.
5. List tools, call `search_conversations` and `list_active_work`, then read an
   admitted conversation. A read-only attempt to call a full-only tool fails
   even if the client manually supplies its name.

If this CLI registers `localhost`, its URI including port must match exactly;
register a newly chosen callback via DCR rather than loosening the matcher.
The browser receiving the redirect must be able to reach the client's callback.
Remote-shell login may need the client's documented no-browser workflow; never
send tokens or an operator credential through chat.

### 7.2 Codex

```bash
codex mcp add station --url https://station.example.com/mcp
codex mcp login station
```

1. Use a separate isolated CLI home, add the URL, and start login. Codex
   discovers OAuth and uses DCR when client-ID metadata documents are not
   advertised. Station requires S256 and R.
2. Complete the same browser code/host confirmation or C/passkey review flow.
   The exact callback shown in that request is what the operator approves;
   neither client name nor prior registration earns automatic approval.
3. The client verifies the returned state/issuer, redeems its code, and uses
   access tokens on `/mcp`. Verify the discovery calls and denied mutation as
   above, plus refresh rotation without a second approval before expiry.
4. At grant expiry/revocation, the client must sign in and obtain a new approval.
   A stale client registration may be recreated after its TTL; no approval is
   transferred by matching its name.

A hosted MCP client follows the same protocol with its exact HTTPS callback.
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
bumps the version, invalidates all existing codes/tokens/families/sessions and
ends the client's access until a new login/approval. Never upgrade an old token
silently. Each login produces one approved family and either a new grant or a
reviewed replacement of a matching active grant; repeat login is a new explicit
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
| Approval phishing / client named like a trusted app | Stable Station identity and exact consent origin, unverified-name label, client ID and actual redirect/resource/Project/expiry displayed together. Host compares two screens; passkey review binds the displayed inputs. No auto-approval based on metadata. An operator can still knowingly approve an attacker. |
| Lookalike metadata, Unicode labels, malicious logo/URLs | Escaped plain text, bounded metadata, no remote fetch/active links, no inferred trusted badge; registration digest bound into approval. Prevent SSRF and stored script injection. |
| Approval CSRF or same-origin plugin | O has no approval commit. C requires initiating live session, exact Origin/Host, Fetch Metadata, nonce, UV and single-use action fingerprint; host path requires host-secret proof. C uses S4 frame/CSP protections. App plugin may request review but cannot decide. |
| Authorization/login CSRF, code interception, open redirect, mix-up | Client state, browser-bound completion nonce, issuer-bound response, exact registered redirect and S256; invalid redirect never receives an error redirect. Actual loopback port is fixed in the request/code. |
| Client-machine token theft | Five-minute access, 30-day maximum grant, project/level/audience limits and immediate operator revocation. Hashed server storage does not protect plaintext stolen from the client. Bearer impersonation within the grant remains possible. Sender-constrained tokens are a later design, not claimed here. |
| Refresh replay or racing refresh | Atomic rotation, consumed hashes, no grace, revoke all family access and streams. Legitimate concurrent refresh/lost response can force re-login; do not weaken replay handling to hide this. |
| Confused deputy / indirect privilege through an internal child | Explicit outside caller; catalog + level + current authority enforced at dispatch/domain seams; no internal-token conversion, host/remote target or approval commands. Inherited ceiling on all descendants or refuse launch. |
| `search_conversations` crosses Projects or leaks another person's work | Stable approved Project + live delegator view at search, transcript admission and activity projection before reading/counting; test native and file-backed sources, foreign IDs/cursors and slug reuse. Content is context, not instructions. |
| Stale connection after revoke or downgrade | Durable version/family checks, effect serialization, per-emission checks and active cancellation. MCP session ID and reconnect never bypass the token. Already committed effects cannot be recalled. |
| Registration spam / operator prompt bombing | Persistent peer/global budgets, hard live caps/TTLs and no notifications on DCR; bounded pending view and explicit operator-initiated ceremony. Quota denial of service remains visible. |
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
| OAuth protocol over HTTP | Anonymous 401 challenge → both resource metadata paths → issuer → DCR → authorization → code/PKCE exchange → actual MCP call. Wrong/missing/repeated R, code reuse, verifier mismatch, missing/`plain` challenge, bad scopes, wrong client and issuer mixing all refuse. |
| Redirect/DCR limits | Exact HTTPS matching, IPv4/IPv6 loopback port exception only, exact localhost port, query/path/encoding/userinfo/fragment negatives; unapproved TTL, client/instance/day caps, bounded limiter keys and restart quota persistence. No metadata URL/remote image fetch. |
| Approval authority | Exercise every matrix row through real middleware: anonymous, Device/admin/PAT, launcher, deployment, internal, remote raw operator, H, S and P. Session alone yields 202 with no grant; only initiating P commits on C. Host code confirms only with host-secret proof. |
| Transaction binding | Alter each fingerprint input independently; race grant/Project/authority changes during the mutation lock. Replay nonce/assertion, approve twice, wrong session, cancel, expired session, revoked signing passkey and bound Device; prove zero unintended grant/effect. |
| Access dispatch | Compare the exact 23/37 tool sets. Enumerate every other registered tool and directly call it by name under both grants. Spy on real domain effects and nested calls; a denied operation must not execute. Include bounded-write, shared command leaves and unknown future registrations. |
| Work discovery | Same principal with two Projects plus global, another principal, native indexed and file-backed transcripts. Search/list/read/digest agree; no out-of-scope snippets, counts, paths or cursors. Deleted/reused slugs fail closed; partial and unavailable sources stay explicit. |
| Full and descendants | An allowed sandboxed in-scope dispatch performs its intended write. Out-of-scope/host/remote/trust-all/approval requests fail. A Station-started child attempts escalation and fails under the inherited ceiling. Provider missing enforcement refuses before launch. |
| Token/storage lifecycle | No plaintext token/code/ticket in database, logs or projections; rotation and replay revoke family, access and active streams. Parallel refresh and response loss follow the specified failure semantics. Store unavailable/corrupt means no grant use. |
| Immediate revoke | Hold one live stream, queued mutation, paused search and descendant call; commit revoke through H and separately P. Release each paused action and prove no later effect/content or session resume; pre-revoke committed effect remains identifiable. Repeat for downgrade, expiry and authority loss. |
| Crash/restart | Crash around grant/outbox commit, code consume and refresh rotation; reconcile once by decision ID, never mint a duplicate grant or return a plaintext secret later. Restart preserves active token expiry and revoked/replay state; pending requests require fresh flow. |
| Existing surfaces | Existing internal child initializes/calls `/mcp/station-control`; its loopback/token behavior stays intact. Exercise engine OAuth proxy negotiation/sign-in regression from #4094/#4108. Cross-present each token at outside/internal/proxy/general API/consent routes and prove refusal. |
| Exposure/UX | Loopback host-only flow without C; HTTPS DNS + C paired-browser passkey flow; LAN/tailnet HTTP refusal; HTTPS IP no operator sign-in; unknown Host/proxy headers; hosted registry disabled. Verify Connections read/change/revoke with operator and ordinary Device. |

Real acceptance uses a fresh Station home and instance name, isolated client
profiles, synthetic Project/conversations and non-default allocated ports
(for example runtime 43141, UI 43001, consent 43143 after checking availability).
Never use the operator's everyday home or ports 3141/3000. Use the documented
TLS consent mapping and existing paired Device/passkey setup; no fixture may
stand in for the real browser assertion.

Run **real `claude mcp login station` and `codex mcp login station`** against
that instance with the commands in section 7. Capture version pins, discovery/
DCR/PKCE/resource requests with secrets redacted, operator approval outcome,
successful tool listing, both discovery calls with expected synthetic results,
denied read-only mutation, refresh, and live revocation. Repeat with full to
prove an intended scoped write, and with no C to prove host-code approval.
Use both an in-scope and foreign Project to demonstrate isolation. Record
actual client redirect forms; an unsupported client version is NOT_VERIFIED or
FAIL, never compatibility PASS from a fixture. Hosted-client acceptance needs
a reachable personal HTTPS instance and its real HTTPS callback; until executed
it remains NOT_VERIFIED, independent of the two CLI passes.

Fault injection starts from a committed clean tree, preserves intervening
changes, and records baseline, injected failure and restored outcomes. Capture
the browser review/Connections states on desktop and a narrow viewport. Restore
configuration and revoke test grants on completion; retain only redacted receipts.

## 11. PR-sized implementation slices and documentation owners

Do not start these slices until the owner reviews this draft. Each slice is
independently reviewable but not feature qualification; keep exposure disabled
until the complete chain passes. Merge S4 and integrate main before implementation.

| Slice | Scope and acceptance | Depends on |
| --- | --- | --- |
| O1 | Private store, immutable registration, bounded pending requests, hashing, versioned grants, atomic outbox and replay families; lifecycle/fault tests. No public access yet. | Reviewed design, S4 |
| O2 | Typed consent targets, guarded domain commits and host-secret/code flow; full authority matrix and fingerprint/race tests. | O1 |
| O3 | Grant-derived caller and principal/read/dispatch adapters, exact catalog, Project scope and inherited descendant ceiling. Prove no implicit operator/host authority. | O1, existing Station Control owners |
| O4 | OAuth discovery/DCR/authorize/token and separate Streamable HTTP `/mcp` router; audience separation, origin/exposure, CORS, capacity and transport revocation. | O2, O3 |
| O5 | Connections projection/actions, host commands, audit/expiry/recovery UX; render both approval modes and revocation states. | O2, O4 |
| O6 | Real two-CLI logins, scoped write and fault/revocation proof on isolated instances; hosted-client journey separately qualified; enable explicit opt-in only after gates pass. | O4, O5 |

During implementation update [Connections](../guides/connections.md),
[operator passkeys](../guides/operator-passkeys.md), [deployment](../guides/deployment.md),
[remote-access threat model](../security/remote-access-threat-model.md),
[CLI reference](../reference/cli.md), [module map](../architecture/module-map.md)
and the affected Station Docs/MCP learning inputs. Add an OAuth route/token
reference and runnable personal-Station integration example through the normal
documentation map. Keep this proposal marked as a design until those changes
ship with their own evidence. Phase one changes this record, its generated
design index and the index's review note only; it does not rewrite current
guides to claim planned behavior.

## 12. Owner questions with recommendations

| Question | Recommendation |
| --- | --- |
| Q1: Is the complete 23-read / 37-full work catalog the intended first release, with administration, browser/device and Session-bound tools excluded? | Yes. Keep full as scoped work authority and expand only with explicit per-tool ownership/enforcement review. |
| Q2: One Project or global per approval, or multi-Project grants? | One stable Project ID or explicit global. Separate approvals for multiple Projects; no all-project default. |
| Q3: Confirm five-minute access, seven-day idle refresh, 30-day absolute grant maximum/default, and no refresh replay grace? | Accept. Forced re-login after a lost/concurrent refresh is preferable to replay ambiguity. |
| Q4: Confirm host-only approval without C, HTTPS remote transport only, and refusal of the entire feature for hosted Station tenants? | Accept D10/D11 boundaries. Hosted MCP clients can still reach a personal HTTPS Station. |
| Q5: Should outside-client approval survive signing-passkey revocation or operator credential rotation? | No. Cascade those events to grants; ordinary operator-session expiry alone leaves grants until their selected expiry. |
| Q6: Are the registration/pending/token/session quotas and 90-day private audit retention appropriate initial defaults? | Accept the bounded values in sections 5.2 and 8; tune downward/configure deliberately after measured client evidence. Never relax approval gates for capacity. |
| Q7: Support client-ID metadata documents or confidential hosted-client authentication in v1? | Defer both; advertise only public-client DCR + S256. Add either only when a named real client requires it and its separate validation/threat model is reviewed. |
| Q8: Require explicit new operator approval on every authorization-code login, including after revocation or changed grants? | Yes. Refresh handles ordinary reconnects during the grant lifetime. Avoid silent authorization based solely on a registration name or previous browser session. |

These recommendations define the proposed behavior pending owner review; they
are not authorization to implement or a claim that the feature is available.
