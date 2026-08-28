# Remote access threat model

Station is a local-first coding environment. Remote access exposes capabilities
on the operator's coding machine, so network reachability is never treated as
authority. This document is the security and recovery contract for direct LAN
and private-tailnet access.

Internet relays, Tailscale Funnel, role-based access, OAuth/OIDC, and generic
trusted proxies are outside this boundary. An explicitly configured,
loopback-only Tailscale Serve identity adapter is inside the boundary only as
pairing-request provenance. Host-confirmed, one-time pairing is
inside the boundary. Persistent, revocable same-origin browser sessions are the
mobile continuity baseline; broader reconnect work remains tracked in
[archive#303](https://github.com/kontourai/station/issues/303).

## Trust boundary

Station classifies a caller from the directly connected socket peer and request
authority. Loopback is a transport position, never authority: ordinary
protected routes require a device-session cookie or bearer credential even from
a direct IPv4, IPv6, or IPv4-mapped loopback peer. A public tailnet Host is
remote even when a Station-owned proxy's next hop is loopback. Every
non-loopback peer is remote, and missing peer metadata fails closed.

`Forwarded`, `X-Forwarded-For`, and `X-Real-IP` are ignored. Station has no
generic trusted-proxy mode. Raw Tailscale identity headers are also stripped.
If `STATION_TRUSTED_TAILSCALE_SERVE_ORIGIN` names the exact HTTPS origin, the
loopback-only UI proxy accepts Tailscale Serve's sanitized, WhoIs-backed user
headers for that authority when Funnel is absent, converts them into a bounded
internal identity envelope, and removes the raw headers. Its sibling UI/API
processes instead share a new, random 256-bit internal proxy token on each
start. The UI removes any inbound Station attestation headers before proxying
and always marks ordinary browser traffic as `remote`; a client socket or Host
never grants internal authority. The API accepts a `local` attestation only
from a direct loopback internal consumer that already possesses the per-boot
token. Missing, invalid, incomplete, spoofed, or UI-proxied attestations still
require the ordinary bearer or device-session credential. The UI refuses to
proxy if its internal token is absent.

This narrowly authenticates Station's own sibling proxy; it does not trust an
external reverse proxy or any caller-supplied forwarding header. Keep the
repository-owned private-tailnet deployment described in the
[deployment guide](../guides/deployment.md) private, and do not expose it to an
untrusted network.

Origin and authentication are independent controls:

- Origin limits which browser origins may call Station. It never identifies or
  authorizes the caller.
- Authentication proves possession of the environment credential for remote
  protected requests. It does not make a hostile Origin acceptable.
- Forwarding headers affect neither decision. Verified Tailscale provenance
  labels a pairing request; it does not authenticate or approve it.

`ALLOWED_ORIGINS` adds exact browser origins to the CORS allowlist. It does not
configure proxy attestation, grant network access, or replace the bearer
credential. An external single-origin reverse proxy is not trusted to provide
Station's internal attestation. The optional Tailscale Serve origin must be an
exact HTTPS origin behind the loopback-only Station UI proxy; it is disabled by
default. Funnel is rejected outright. Authority mismatches and missing or
malformed identity never produce verified provenance.

## Surface matrix

| Surface | Direct loopback | Remote without credential | Remote with credential |
|---|---|---|---|
| `GET /.well-known/station/v1` | Public | Public | Public |
| `POST /.well-known/station/v1/proof` | Public, bounded | Public, bounded | Public, bounded |
| `POST /.well-known/station/v1/pairing/access-request` | Allowed only from an exact configured same-origin browser; rate-limited; cannot approve itself | Same | Same |
| `POST /.well-known/station/v1/pairing/request` and `/pairing/exchange` | Public, bounded | Public, bounded | Public, bounded |
| `GET /api/system/liveness` | Public | Public | Public |
| CORS `OPTIONS` | Allowed only with an allowed Origin | Same | Same |
| Every other HTTP route, including `/api/**`, `/agents/**`, `/acp/**`, `/events/**`, root chat/invoke/stream routes, mutations, and unknown future routes | `401` unless it presents a device session, bearer, or exact direct-internal attestation | `401` | Allowed |
| HTTP request with a credential-like query parameter | `401` | `401` | `401` |
| HTTP request from a disallowed Origin | `403` | `403` | `403` |
| Repeated authentication failures | Subject to bounded limiting | `429` with `Retry-After` | A valid credential clears the peer's failure window |
| Terminal or voice `WS /__station/health` | Identity-only; no business session | Identity-only; no business session | Identity-only; no business session |
| Other terminal or voice WebSocket paths | Existing local flow | Closed before session allocation | Requires the first-frame protocol below |

The public handshake is deliberately minimal and contains no credential,
hostname, username, home directory, workspace, endpoint, process identity, or
build details. Its schema is:

```json
{
  "schemaVersion": 1,
  "environmentId": "<opaque-environment-id>",
  "authentication": { "scheme": "bearer", "protocolVersion": 1 },
  "transports": { "http": 1, "sse": 1, "websocket": 1 },
  "compatibility": {
    "serverVersion": "<station package version>",
    "protocolVersion": 1,
    "minClientProtocol": 1,
    "capabilities": { "remoteAuth": 1, "devicePairing": 1, "environmentProof": 1 }
  },
  "capabilities": { "sshEnvironments": true, "webPushNotifications": true }
}
```

The environment ID is stable across restarts and endpoint changes. It is an
identifier, not a secret or authorization token.

## Credentialed consumers (archive#2051)

The removed loopback/SSH compatibility floor has no silent replacement. These
are the supported request contracts established from the live runtime callers:

| Consumer | Explicit credential path | Missing or malformed credential |
| --- | --- | --- |
| Browser UI, desktop shell, and mobile shell | Device-session cookie after the public pairing/access-request exchange; the desktop may use its native request broker | Protected route returns `401 authentication_required`; public pairing paths remain available |
| CLI | `--credential`, `STATION_API_CREDENTIAL`, or an OS-keyring-backed paired profile credential | The command reaches the same `401`; the CLI must pair or supply a credential |
| `station-control` MCP | Per-boot `x-station-internal-token` plus `x-station-proxy-caller: local` from a direct loopback process | Runtime rejects it as ordinary uncredentialed traffic; `station-docs` is read-only and makes no live API request |
| SSH delegation | Paired outbound peer bearer attached to the tunnel request | The remote runtime returns `401`; a tunnel alone grants no API authority |
| Station-owned UI/Tailscale proxy | It always classifies browser traffic as remote and relays its device-session cookie or bearer; the shared token carries only bounded proxy metadata | `401`; a loopback socket, Host, or SSH forward never becomes internal authority |

The public pairing, access-request, exchange, proof, liveness, share-token, and
MCP-token routes remain separately declared authentication contracts; this
change does not make those public paths implicit authority over protected APIs.

`compatibility` is likewise optional and additive (a host from before that
contract omits it); its own nested `capabilities` map is a set of
*sub-protocol version numbers* (remote auth, device pairing, environment
proof), not the boolean feature flags below — see
`StationCompatibility` in `packages/contracts/src/environment-security.ts`.

The top-level `capabilities` (archive#1095) is additive and entirely
optional: every key is an optional boolean, and a host may omit the whole
object. Absence of the object, or of a specific key, always means
"unsupported" — either the host predates this field, or it never seeded that
flag — never an error. This is the client feature-detection story for a
rolling upgrade: a client checks `capabilities.<name> === true` instead of
branching on a version number. Station's own seeded flags live in one
registry,
`src-server/capabilities/station-capability-flags.ts`; the sdk exposes a
`hasCapability(descriptor, name)` accessor (`@kontourai/station-sdk`) that
treats every absence case as `false`.

The proof endpoint accepts only a versioned, 256-bit base64url nonce and is
rate-limited by direct peer. It returns the nonce, environment id, and an
HMAC-SHA256 over a domain-separated protocol message. Connect verifies that
proof locally; credentials never appear in the proof URL, headers, or body.
Fresh nonces prevent replay, and a copied environment id cannot authorize an
endpoint change. Remote endpoint candidates require HTTPS; HTTP is limited to
strict loopback names and addresses.

## Mutation budget (archive#514)

The runtime security middleware applies a shared body-size ceiling and a
per-principal mutation-rate budget to every authenticated mutation
(`POST`/`PUT`/`PATCH`/`DELETE`) before route-specific parsing or persistence
work. This is the shared layer archive#496's route-local Task field limits sit behind
as defence in depth; each product route no longer invents its own limit.

**Body-size.** `Content-Length` is checked first; an oversized request is
rejected `413` before any body read. A lying or absent `Content-Length` is
caught by a streaming byte counter that aborts past the ceiling and re-buffers
the bounded body for the handler — `Content-Length` alone is not trusted.

**Rate budget.** The budget key is the **server-derived principal**, never a
caller-supplied header, body field, or query parameter. A budget keyed on
something the caller controls is not a budget. The key is derived from the
credential the middleware has already verified:

| Authentication mode | Budget key | Scope |
|---|---|---|
| Bearer (`Authorization: Bearer …`) | `principal:` + SHA-256(credential)[:16] | per credential |
| Device session (cookie) | `principal:` + SHA-256(credential)[:16] | per credential |
| Exact attested internal token | `loopback` | shared (Station-owned internal callers only) |

The key follows the **credential value**, never the transport it arrived on.
The bearer and device-session cookie share one key prefix precisely because
they are the same credential family — a holder of one valid secret must not
get a second rate budget by choosing to send it as a cookie instead of a
bearer token (or by omitting the `Authorization` header). One principal
cannot evade the budget by spreading requests across different protected
routes either: the key is the principal, not the route. The
`source` (`bearer`/`session`/`loopback`) is retained on the principal record
for telemetry only and does not participate in the key.

**Availability consequence of the internal budget.** Only Station-owned
callers that possess the per-boot internal token share the `loopback` key.
Generic loopback and SSH-forwarded requests are rejected before budgeted
mutation work, so tunnel access cannot consume that shared principal's budget.

**Streaming routes.** Enumerated streaming mutation surfaces (chat turns,
orchestration sends, streaming invokes) get their own, more generous rate
bucket so active chat does not collide with — and is not throttled by — the
standard mutation budget. SSE read surfaces (`GET /events`,
`GET /api/orchestration/events`, `GET /monitoring/events`,
`GET /scheduler/events`) are GETs and are therefore unbudgeted; they are
enumerated explicitly in `DOCUMENTED_SSE_READ_SURFACES` (documentary, not a
gate — the classifier never consults it; GETs are unbudgeted as non-mutations)
so the surface stays a reviewed decision, not an implicit escape.

**Defaults** (configurable via `RuntimeHttpSecurityOptions`):

| Option | Default | Notes |
|---|---|---|
| `maxMutationBodyBytes` | 1 MiB (1 048 576) | Standard mutation body ceiling |
| `maxStreamingBodyBytes` | 2 MiB (2 097 152) | Streaming mutation body ceiling |
| `maxMutationsPerWindow` | 300 | Standard mutations per principal per window |
| `maxStreamingPerWindow` | 60 | Streaming mutations per principal per window |
| `mutationWindowMs` | 60 000 | Rate-budget window (shared) |
| `maxBudgetPrincipals` | 1 024 | LRU bound on tracked principal keys |

**Public routes** (`/.well-known/station/v1/**`, `GET /api/system/liveness`)
carry no authenticated principal and are never budgeted — they are
classified `'unbudgeted'` before the budget middleware runs.

**Telemetry.** `station.request_budget.outcomes` counts decisions by bounded
`outcome` (`allowed` / `oversized` / `rate_limited`) and `class`
(`standard` / `streaming`). Attributes never carry a path, principal id, or
method name. Like every OTel instrument in this repo the counter is a no-op
unless `OTEL_EXPORTER_OTLP_ENDPOINT` is set; the HTTP status (`413`/`429`) is
the real signal.

## Scope model

Pairing is not all-or-nothing (archive#1098). Every pairing grant and every
device session/credential exchanged from it carries an OAuth-style,
space-delimited scope string drawn from a fixed vocabulary. The starter set
was four scopes: `orchestration:read`, `orchestration:operate`,
`terminal:operate`, and `access:manage` (pairing/device management — creating
offers, confirming or denying requests, revoking devices). Station#1398 slice
2 added a fifth, `inference:invoke` (fleet inference — see below). This is
deliberately small — not a general permission system — and has no relation to
DPoP proof-of-possession, an OAuth server, or relay scopes, all of which are
out of scope.

**The default grant is a curated constant, not "every scope."** Three
populations receive a scope string nobody chose per-device: an offer created
without an explicit `scope`, a credential migrated from a pre-scoping
registry, and the operator bootstrap credential. Until archive#1398 that
string was computed as "join every known scope," which meant every future
vocabulary addition silently granted the new scope to all three *and* changed
the bytes older peers had to parse — and `parsePairingScope` rejects an
entire scope string on one unknown token, so those peers would refuse the
grant outright rather than degrade. `DEFAULT_GRANT_PAIRING_SCOPE` is now an
explicit four-token constant, frozen and pinned literally by test, so adding
a scope is inert for existing credentials and byte-compatible for existing
peers. Adding a scope to the *default grant* is now a separate, deliberate
act from adding it to the vocabulary.

A consequence worth stating plainly: the operator bootstrap credential is no
longer "full authority." It carries the historical four tokens and therefore
cannot reach `/api/inference/**` — that requires a grant minted with the
`inference` preset. Any surface labelling a four-token grant must describe
the tokens held rather than call it "full access," which is why
`describeDeviceScope` (packages/connect) renders it as "Standard + device
management" and reserves "Full access" for a grant that genuinely carries
every token.

The pairing UI offers two presets when creating an offer: **Read-only**
(`orchestration:read` alone) and **Standard** (`orchestration:read
orchestration:operate terminal:operate`), the default *radio selection* in
that UI. Neither preset grants `access:manage`: a paired device, however
broadly scoped, can never manage other devices or pairing offers itself —
only the operator credential can. The chosen scope is shown before the grant
is created and again on the resulting offer.

Two other paths do not go through the preset selector at all, and both
default to full access rather than Standard:

- The server-side fallback when a caller creates a pairing offer without an
  explicit `scope` is full access (all four scopes), not Standard —
  `DevicePairingService#createOffer`'s default. The pairing UI always sends
  an explicit scope, so this fallback is reached only by a caller bypassing
  the UI (or a pre-archive#1098 integration) and exists to keep that path
  functioning rather than silently narrowing it.
- The same-origin "Request access" continuity flow (the short-lived access
  request a browser makes directly from the Station origin, described below)
  always requests full access and has no UI path to ask for less: it exists
  for the operator's own already-authenticated browser to persist a session,
  not for pairing a new, potentially less-trusted device. The operator still
  sees the true requested scope and approves or denies the named request on
  the host before any credential is issued, exactly as with any other
  pairing request.

Enforcement is a single route -> required-scope table
(`src-server/security/pairing-route-scopes.ts`) consulted by one piece of
middleware, never scattered per-handler checks. Every authenticated HTTP route
family and both the terminal and voice WebSocket upgrade paths are listed;
GET/HEAD routes require `orchestration:read`, mutating methods require
`orchestration:operate`, the terminal WebSocket requires `terminal:operate`,
the voice WebSocket requires `orchestration:operate`, and every
`/api/pairing/**` route requires `access:manage` regardless of method. A
route the table does not recognize fails closed — denied, with a loud server
log — rather than defaulting to allowed; a test enumerates the live route
surface against the table so a new authenticated route shipped without a
scope entry is caught before merge. A read-only credential can therefore read
and stream state but is denied every mutation and the terminal route with
`403 insufficient_scope`. The Station operator bootstrap credential predates
scoping and is treated as carrying every scope — it is not itself a pairing
grant.

### Cross-station reads

An SSH environment's local tunnel (`GET /api/environments/ssh/sessions`,
archive#1097) lets this Station's server process read another, remote
Station's orchestration session summaries — titles, project slugs, assigned
agents, and models — for the Home work list's remote-session cards. That
read is not itself authenticated against the remote station: the tunnel
arrives at the remote as a loopback connection, which the remote station
already treats as implicitly trusted (see "Trust boundary" above), so this
Station's server can read it with no credential exchange at all. The remote
station never separately consented to expose those summaries to whichever
device is currently paired with *this* Station.

Consequently, disclosing that read to a caller of this Station is gated at
`orchestration:operate` here — deliberately stricter than the
`orchestration:read` the rest of the `/api/environments/ssh` family uses for
this Station's own SSH profile/connection metadata, which carries no other
station's data. A Read-only-preset paired device can see this Station's own
state but not another station's, until the operator (or a Standard-or-above
device) chooses otherwise. This is an owner decision to tighten now — it can
be loosened to `orchestration:read` later if that turns out to be overly
strict in practice, but the reverse (loosening first, discovering the
cross-station exposure later) is not how this shipped.

Mechanically, this endpoint is `pairing-route-scopes.ts`'s worked example of
a leaf override: the route table normally classifies at route-FAMILY
granularity (one entry per mount prefix — see that file's module docblock),
so a new endpoint added under an already-covered prefix silently inherits
the family's tier by default. That is the wrong outcome for an endpoint
materially more sensitive than its family, so this one instead has its own,
longer-prefix table entry that wins under the scope table's longest-prefix
matcher.

At exchange, a device session's granted scope can never exceed the scope of
the grant (offer) it was exchanged from — a session cannot accumulate more
authority than what was offered and confirmed.

Every device paired before this feature shipped is migrated to the default
grant (the historical four scopes) the first time its registry loads, in
place, with no forced re-pairing: the pre-scoping registry format recorded a
single fixed scope marker meaning "every capability," and the four scopes
that existed then are the faithful reading of that marker. It is deliberately
*not* re-read as "every capability that exists now" — a migration is a
faithful translation of an old record, never a re-grant.

### Fleet inference (archive#1398)

`inference:invoke` gates the `/api/inference/**` family: read which local
models this Station contributes to its owner's fleet, and ask for a model
completion on one of them. It is not `orchestration:operate`, and the
distinction is the point — that scope authorizes starting arbitrary agent
sessions and driving turns here, and "let my laptop use my workstation's GPU"
must not imply "let my laptop run agents on my workstation." The family is
completions only: no tools, no filesystem, no session creation, and no
`delegate_task` reach. Full design in `docs/design/inference-fleet.md`.

Only the `inference` preset grants it, and it is absent from the default
grant, so no credential in existence before this shipped gained fleet
invocation by upgrading. Contributing is separately operator-opt-in and
default-off (`AppConfig.fleetContribution`), so the scope alone reaches
nothing: a peer holding it against a non-contributing Station receives a
named refusal saying so.

Two hardening decisions specific to this family:

- **`GET /api/connections/model-inventory` is raised to `inference:invoke`
  AND narrowed to the contributed subset.** Both halves, deliberately
  together. The scope raise uses the same leaf-override mechanism as the
  cross-station read above; the payload is now `station.fleet-contribution/v1`,
  identical to `GET /api/inference/manifest`.
  Raising the tier alone would have been worse than doing nothing: it hands
  the full launchable enumeration to precisely the fleet-peer class the
  completion route's refusal parity exists to keep from learning what this
  Station has but has *not* contributed. A peer that cannot discover a
  withheld model through `POST /api/inference/completions` must not read the
  whole list here.
  This narrows a shipped route — the measured blast radius is the SDK's two
  inventory functions with no in-repo call sites (renamed to
  `fetchContributedModelManifest()`/`useContributedModelManifestQuery()` so
  the payload change cannot land silently), plus any out-of-repo SDK embedder
  holding a `read-only`/`standard`/`delegation` credential. Same reasoning as
  cross-station reads: tightening now is reversible, discovering the exposure
  later is not.
  archive#2051 resolves the residual tunnel disclosure: this route, like every
  protected route, rejects a bare loopback or SSH-forwarded request with
  `401 authentication_required`. The contributed subset remains the only
  credentialed HTTP projection; the un-projected inventory is in-process only.
- **Historical distinction, retired by archive#2051.** `/api/inference/**`
  previously opted out of a generic loopback compatibility floor. The runtime
  now applies the credential requirement to every protected family, including
  IPv4, IPv6, IPv4-mapped loopback, and malformed `Authorization` requests.

A third decision belongs with these two, on the WRITE side. Enabling
contribution is an ordinary `PUT /config/app` write at `orchestration:operate`
(see `docs/design/inference-fleet.md` §5.4 for why that tier was accepted
rather than narrowed), and that acceptance rests on the flipper gaining
nothing — true only while it cannot also invoke. So a presented credential
holding `inference:invoke` is refused any write to `fleetContribution`,
covering `connectionIds` as well as `enabled`. Without that guard, a single
`orchestration:operate inference:invoke` grant could enable contribution, name
a billable hosted connection, and spend the owner's money with no operator
involved at any step.

A caller that presents no credential is rejected by runtime authentication;
this guard is reached only for a verified bearer, device session, or exact
Station-internal token attestation. In particular, a bare SSH forward cannot
enable contribution or name a billable connection. The guard remains necessary
because an authenticated peer carrying `inference:invoke` must not authorize
its own serving capacity.

Whether this Station is *currently* contributing is never on the public,
unauthenticated handshake. The handshake carries only the static
`fleetInference` protocol-support flag ("this build understands the
`inference:invoke` token"); participation is readable only after
authenticating, from `GET /api/inference/manifest`. Advertising participation
publicly would let any LAN or tailnet scanner enumerate which of the owner's
machines have GPUs.

### SSH environment host alias, and the host key that actually gates it (archive#1144, revised)

`POST /api/environments/ssh` (`SshEnvironmentService#add`, mirrored by the
`create_ssh_environment` station-control tool) registers a profile that a
later `connect_ssh_environment`/`.../:id/connect` call uses to open an
outbound SSH tunnel authenticated with **the operator's own ambient SSH
identity/agent** — the same identity a human would use from a terminal on
this machine. `hostAlias` accepting any string matching
`/^[A-Za-z0-9_][A-Za-z0-9._-]*$/` is not the same guarantee as `hostAlias`
naming a host the operator's own SSH config actually knows about: `ssh -G
<alias>` resolves an alias with no matching `Host`/`Match` stanza just as
cleanly as a configured one, echoing it back as a literal hostname with the
current user and port 22. Left unconstrained, `create` + `connect` together
are an SSRF-shaped primitive — an outbound TCP/SSH connection attempt to any
host reachable from the Station machine, requested purely by a string.

That string is reachable from more than a human filling in the Connections
hub's setup form. `create_ssh_environment` is an ordinary station-control
tool: any agent turn holding `orchestration:operate` can call it, and not
every dispatch path routes through a human-in-the-loop approval — voice,
scheduled jobs, and the default temp agent run with no confirmation hooks
wired, and the platform-mutation gate is inert for workspaces that never
opted into `.flow-agents` governance. So the practical trigger bar for this
surface is prompt injection reaching a mutating-tool-executing context, not
"a human deliberately typed a hostname."

**The control is the host key, not the config stanza.** Station never writes
host trust. EVERY process Station starts that can open a session pins the
same policy on its own argv, where no ambient `~/.ssh/config` can relax it —
the server's two, and the desktop app's:

- the probe (`buildSshReachabilityArgs`, `openssh-reachability.ts`):
  `BatchMode=yes`, `StrictHostKeyChecking=yes`, `UpdateHostKeys=no`, and an
  explicit `UserKnownHostsFile` carrying the store list `ssh -G` resolved for
  THAT host;
- the master session (`buildOpenSshMasterArgs`,
  `openssh-environment-adapter.ts`): `StrictHostKeyChecking=yes` and
  `UpdateHostKeys=no`. The known_hosts LOCATION is deliberately not
  overridden there — an operator's configured `UserKnownHostsFile` is their
  trust store, and replacing it would reject hosts they legitimately
  confirmed.
- the desktop SSH launcher (`ssh_args` / `forward_args`,
  `src-desktop/src/ssh_launcher.rs`, reached by the Tauri `ssh_env_probe` and
  `ssh_launch_start` commands): the same
  `StrictHostKeyChecking=yes` + `UpdateHostKeys=no` pair, before the `--`
  terminator so `ssh` reads them as its own configuration, and likewise no
  `UserKnownHostsFile` override. This path opens a remote shell and a port
  forward as directly as the server's does; it was
  the one Station SSH surface that inherited ambient policy, so under
  `accept-new` it could accept and record an unseen key.

The server's two therefore read the SAME store. The probe used to force
`~/.ssh/known_hosts`, which made the two paths ask different questions about
the same host: one trusted only in a configured store failed the creator's
probe, and appending to the default file could make the probe pass while
CONNECT still refused because its store stayed empty. The probe already runs
`ssh -G`, so the resolved `UserKnownHostsFile` list comes from that single
resolution and is passed explicitly — the trust store stays the operator's
choice, and stays legible in the argv rather than ambient. When `ssh -G` is
unusable the probe falls back to OpenSSH's own default rather than guessing.

Without those two options the master session inherits the ambient policy,
and under the widespread `StrictHostKeyChecking=accept-new` (or `no`)
OpenSSH silently accepts *and records* the key of a host nobody confirmed.
Pinning them makes registering a profile inert on its own: a profile for an
arbitrary host cannot become a session unless that host's key is already in
the operator's known_hosts, which only the operator can put there.

An unknown host is therefore a first-class, actionable outcome rather than
an error. The probe reads (never writes) the presented key with a bounded
`ssh-keyscan` and returns `unknownHost { fingerprint, keyType,
knownHostsLine, trustCommand }`; the Connections creator renders the
fingerprint to verify out-of-band and a Copy button for `trustCommand`. The
`action` sentence is composed from `trustCommand`, so the text the user reads
and the command they paste cannot diverge.

`trustCommand` appends the EXACT bytes that produced the displayed
fingerprint — `printf '%s\n' '<knownHostsLine>' >> <the first resolved
store>`, shell-quoted — and reaches no network. It deliberately is NOT a second
`ssh-keyscan … >> known_hosts`: nothing would bind that scan's result to the
fingerprint on screen. The host can answer differently the second time, and
an unrestricted scan appends every algorithm it offers, so a user who
carefully verified an Ed25519 fingerprint could end up trusting an ECDSA key
they never saw and that `ssh` may then negotiate. The verification ritual has
to bind, or it is theatre. The line is also rebuilt from the three validated
fields (host pattern, key type, base64 key) rather than passed through
verbatim, because `ssh-keyscan` output is remote-controlled text on its way
into a shell command a human will paste.

A **changed** host key never gets this treatment — offering to append the new
key would be one click to trust exactly the interception OpenSSH just refused
— so it keeps the `ssh-keygen -R` + review-in-a-terminal path.

**Retired: the configured-alias gate and `allowUnknownHost`.** The earlier
control required `hostAlias` to match a concrete `Host` stanza found by
`discoverOpenSshAliases`, unless the caller set `allowUnknownHost: true`.
Two problems retired it. First, a `Host` stanza is not a trust decision
about a machine — it is a convenience record, and the check could not read
`Match` blocks or wildcard patterns, so it rejected aliases that were
genuinely configured. Second, the flag was a caller-set boolean in front of
the gate: any caller willing to type it (including the agent-tool path this
section is about) turned the gate off, while the Connections UI sent it
automatically. It read as an audit signal and derived nothing. The alias
format guard (`requireOpenSshAlias`) stays — it is what stops a flag-like or
metacharacter-bearing string reaching argv.

**Residual, disclosed.** This paragraph describes server profile
registration followed by server CONNECT specifically; the desktop launcher is
a separate entry point, pinned above, that profile registration does not
mediate at all. Registration itself is no longer gated: an
`orchestration:operate` credential can store a profile naming any
format-valid host. What it cannot do is reach that host — `connect` fails
closed on an unconfirmed key. The remaining reachable effect of a hostile
registration is a profile row in the Computers list and, for a host whose
key the operator *has* already confirmed, a connection attempt to a machine
they already trust from this one. Probe-driven outbound attempts are bounded
separately by the admission control described below.

### SSH probe admission control (D5 finding 4)

`POST /api/environments/ssh/probe` starts real `ssh` processes against a
caller-named host. Unbounded, an authenticated `orchestration:operate`
credential could use it as an internal port-22 scanner and as a process
amplifier — every request holding processes for up to
`SSH_PROBE_MAX_SECONDS`.

Two bounds, both in `ssh-probe-admission.ts` and applied by the route:

- **one in-flight probe per principal**, keyed by the same
  server-established `BudgetPrincipal` the mutation budget uses (a hash of
  the verified credential, never a caller-supplied header), and
- **three in flight across the whole server**, so many principals cannot sum
  to an unbounded process count.

A refusal is `429` with `Retry-After: SSH_PROBE_MAX_SECONDS`, the SUM of the
probe's three sequential legs — `ssh -G` resolution, the connection attempt,
and (for an unknown host) the key scan. It used to be the attempt's ceiling
alone, so a caller who waited exactly that long could arrive while the first
probe was still scanning and collect a second 429: a header that tells you
when to come back, and is wrong. Each leg is derived from the constant its own
runner applies, so re-timing or adding a leg moves the header with it.

Each attempt runs as its own **process group** (`detached: true`) and is
killed as a TREE. `execFile`'s `timeout` signals only the direct child, and
`ssh` is rarely the only process it started: a `ProxyCommand` (which
`ProxyJump` compiles to) is an arbitrary program — `nc`, `cloudflared`,
`aws ssm start-session` — that OpenSSH does not necessarily reap. Killing the
tree is what makes the probe's time bound a bound on processes rather than
only on the `ssh` binary.

How that is done is per platform, chosen by `planProcessTreeKill`: POSIX
signals the group with `process.kill(-pid)`; Windows has no process groups
and does not support negative-pid signalling, so it runs `taskkill /T /F
/PID`. Before that branch existed the Windows path fell into the same
catch-and-kill-only-`ssh` fallback, which is precisely the leak this bound
exists to prevent. Disclosed test coverage: the real-process test uses
`pgrep`/`ps` and genuine POSIX process groups and proves only that path; the
platform SELECTION is unit-tested with a mocked platform, and no run on a
real Windows host backs the `taskkill` behaviour itself.

### Historical pairing approval finding (pre-archive#2051, archive#1490)

Pairing **approval** is the one step that converts a position into authority
that outlives it. Every other step is either public by design (the joiner's own
request and exchange) or reversible by the operator; a confirmed request is
exchanged for a device credential that keeps working after the caller's access
to this machine ends.

Before archive#2051 it was reachable on the compatibility floor. A probe then
showed that a caller presenting no credential sent `POST
/.well-known/station/v1/pairing/access-request` (a non-browser client passes
`isTrustedBrowserPairingOrigin` by sending an allow-listed `Origin` with no
`sec-fetch-site` at all, which the guard reads as same-origin), then `POST
/api/pairing/requests/:id/confirm`, then `POST .../exchange`, and held a
persistent credential carrying `DEFAULT_GRANT_PAIRING_SCOPE`. Four requests,
self-issued, broader than any pairing preset grants. A second shape needed no
`Origin` header at all: `POST /api/pairing/offers` on the floor, the challenge
read straight out of its response, then the public pairing-request route.
`confirmRequest` had no caller-identity input in either case: the "a request
cannot approve itself" property `DevicePairingPanel` states in its own copy was
*entirely* the HTTP boundary, which the floor bypasses.

**What now holds.** Runtime authentication rejects bare loopback and SSH
requests before they reach pairing-host routes. `DevicePairingService
.confirmRequest` still takes a required `PairingApproval` as defense in depth
for exact Station-internal callers. The predicate is `isDefinitelyOffBox`
(`src-server/security/off-box-peer.ts`), stated positively: it refuses
loopback, link-local, the unspecified address, **every address this host
currently holds on any interface** (subject to the container caveat below), an
unreadable peer, and anything it cannot parse. Addresses are compared after
being reduced to one spelling — IPv6 canonicalised, the whole IPv4-mapped
family (`::ffff:7f00:1`, `0:0:0:0:0:ffff:127.0.0.1`, `::ffff:127.0.0.1`)
unwrapped to its dotted quad, and an IPv4 carrying leading zeros refused
outright rather than resolved to whichever host a given parser thinks `010`
means. It is not `classifyRuntimePeer`, whose `remote` verdict is the *safe*
answer for authentication and the *permissive* answer here — that reuse would
have granted on `fe80::1%lo0`, the loopback interface's own address. Interfaces
are re-enumerated on every evaluation, because a cached list fails open the
moment a VPN or container bridge appears. The verdict is recorded on the offer
at request time and is deliberately not on the wire `DevicePairingRequest`,
which carries no network identity.

Station's own loopback UI proxy would otherwise erase exactly this fact —
everything behind it reaches the API from 127.0.0.1, which is how a phone
normally reaches a Station. The proxy therefore attests the address it saw (`x-station-proxy-peer`,
stripped from inbound like its sibling attestation headers), and the API
accepts that report only behind a trusted internal token from a loopback direct
peer — the same anchor `readVerifiedIngressIdentity` uses. The attested address
is judged by the same predicate, so the proxy hop is transparent rather than a
second, weaker rule.

**Tailscale Serve is not an address question at all.** Serve terminates the
tailnet connection on this host and re-dials the UI port from loopback — which
`trustedTailscaleIdentity` requires — so the truthful attested address for a
Serve request is `127.0.0.1` and always will be. Judging those by address
refused precisely the requests carrying the strongest provenance Station has. A
server-verified ingress identity is therefore a positively-earned position in
its own right, alongside `off-box`: `identifyIngress` demands the per-boot
internal token from a loopback direct peer over a payload the proxy minted
after stripping every client-supplied `tailscale-*` header, so it is no more
forgeable from the floor than the attested address is.

**What this closes.** The whole self-dial class, which the first version of
this fix only disclosed. Re-probed after: the four-request access-request chain
403s at approval and 409s at exchange; so does the offer/pairing-request
recombination; and so does a request dialled at this host's own LAN address,
with or without the UI proxy in front of it. No SSH is required to attempt any
of them, and none now converts.

**What this costs the operator.** Nothing in the journey the floor exists for:
a phone, tablet, or second laptop reaching this Station over the LAN
contributes its own source address, and one arriving over Tailscale Serve
carries a verified identity instead, so the operator still approves either from
an unenrolled browser at the machine, presenting nothing — QR/manual code
flow and per-connection "Request access" alike. What it costs is
**same-machine pairing**, whichever address that browser dials: a second
browser or a native shell on the host itself must be approved by something
holding a credential — `station environment access approve <id>`, which reads
the operator credential from the Station home. `DevicePairingPanel` prints that
command on the 403.

That case is not a regression a smarter check could avoid. Two processes on one
machine are byte-identical to the operator and to an adversary holding an SSH
local forward; refusing it *is* the property. The two-context mobile pairing
E2E (`tests/device-pairing-mobile.spec.ts`) is exactly that shape and now
presents the operator credential from its host context, which is what a human
at that machine would do.

**What remains open.** "Not this network stack" is weaker than "another
machine", and the difference is the residue, stated without softening:

- A **container, VM, or other network namespace on this same box**. Its source
  address is its own, so it is off-box by this definition. An adversary who can
  start a container on the host can still convert.
- **Any second machine the adversary holds** — a LAN foothold, a compromised
  phone. Approval still has to be triggered from the floor, but the requester
  leg is genuinely elsewhere.
- **NAT hairpin**, where the port is externally reachable and the source is
  rewritten to an address this host does not hold.
- **Station itself running in a container, VM, or WSL2.** This is the mirror of
  the first item and the commoner one: `os.networkInterfaces()` enumerates only
  that namespace, so the *host's* LAN address is not in the set, and the whole
  self-dial class re-opens for every process on the host with no adversary
  container required. "The self-dial class is closed" is therefore
  deployment-conditional — true when Station shares a network namespace with
  the processes that can reach its port, which is the ordinary desktop and
  bare-metal case.
- **Anything holding the internal API token.** The token is strong (256 bits
  per boot, compared by SHA-256 + `timingSafeEqual`) and lives in the Station
  server process as `process.env.STATION_INTERNAL_API_TOKEN` (and the sibling
  per-boot `STATION_UI_BOOTSTRAP_TOKEN`). Spawned PTYs and generic engine
  subprocesses do **not** inherit those keys: `childProcessEnvironment()` /
  `scrubBootInternalSecrets()` delete them at every production spawn/PTY
  seam. The one child that still receives the internal token is the built-in
  `station-control` MCP server, via `withStationControlRuntimeEnv` after the
  scrub, because that child is Station's own loopback API client.
- **Accepted boundary (UX audit D6).** A paired principal with
  `terminal:operate` (or agent execution) runs as the Station OS user. That
  principal can read `<STATION_HOME>/logs/server/` from disk even when the
  HTTP diagnostics route redacts. The unredacted local store is inside that
  existing trust boundary — the same user can already read the local-grant
  secret and operator credential files. API redaction defends paired
  principals **without** terminal/agent authority (a phone using Developer →
  Logs, `read_logs` over pairing, a scoped grant that cannot spawn a shell).
  Scrubbing the token from PTY/engine env closes the cheaper path that used
  to turn `printenv` into an ephemeral `home-possession` principal.

The sound closure is unchanged and unaffected by any of this: require a
presented credential on `POST /api/pairing/requests/:id/confirm` (and `POST
/api/pairing/offers`) via `PAIRING_CREDENTIAL_REQUIRED_PREFIXES`. It was
assessed and deliberately not taken, because this family has no enrolment
escape hatch — `EnvironmentSecurityService.authorizeCredential` refuses every
paired-device credential on `/api/pairing/**`, so only the operator's bootstrap
credential passes. Be precise about who pays: a **browser-only first run**
loses its Approve button until the operator runs the CLI once. The desktop
shell need not — it supervises the server, resolves `STATION_HOME`, already
reads credential files, and runs as the operator, so it *could* present the
same credential the CLI does. Note the tense: no such wiring exists today
(`HostDevicePairingPanel` is mounted from `ConnectionManagerModalContent`, and
nothing reads a credential from `STATION_HOME`), so this is a feasibility claim
about unbuilt capability and the cost analysis rests on it being built. That trade is an owner call, recorded in
`src-server/security/pairing-route-scopes.ts` beside the list, and archive#1490
carries a third option (a first-run enrolment token printed to the terminal
that started Station) that would remove the browser cost entirely.

**Detection, while a class stays open.** `station.device_pairing.requests`
carries `approver` alongside `source`/`outcome`, and an approval granted to a
caller that presented no credential emits `station.pairing.approved` at warn
volume, and a refusal emits `station.pairing.refused` under its own name so
grepping for approvals does not return both. Neither carries device or network
identity. That is the only signal distinguishing an ordinary first-run approval
from the residue being exercised, which is why it is covered by tests rather
than left to inspection.

**The rest of the family, assessed with it.** These remain reachable on the
floor, each because it is the operator's own panel doing its job before any
device is paired:

- `POST /api/pairing/offers` — creates the pairing code the panel renders.
- `GET /api/pairing/requests` and `GET /api/pairing/devices` — the panel's
  inbox and paired-device list. The first discloses pending device names and
  request ids; the second the full inventory (names, ids, scopes, `lastUsedAt`),
  which is an activity side channel and the id source for the revoke below.
  Neither yields authority: exchange needs a secret neither read carries.
- `DELETE /api/pairing/requests/:id` (deny), `DELETE /api/pairing/offers/:id`
  (cancel an in-flight offer, killing the operator's QR mid-scan), and `DELETE
  /api/pairing/devices/:id` (revoke). All three are denial of service against
  the operator, none gains the caller authority, and `revokeDevice` is a soft
  revoke that does not enable re-pairing as the revoked device.

Approval was singled out because it is the only one whose effect survives the
position.

## Credential transport and storage

CLI, API, native, and cross-origin HTTP and fetch-based SSE use
`Authorization: Bearer <credential>`. A same-origin paired browser sends its
device credential only as a host-only, persistent `HttpOnly` `SameSite=Strict`
cookie. JavaScript cannot read that cookie. Cookie-authenticated mutations also
require an exact allowed browser `Origin`; originless mutations fail closed.
Credentials in URLs, query parameters, logs, screenshots, WebSocket negotiated
subprotocols, or public handshake responses are forbidden.

Remote terminal and voice WebSockets send this as the first application frame:

```json
{"type":"auth","protocolVersion":1,"credential":"<credential>"}
```

No terminal or voice business state is allocated before successful
authentication. Success returns
`{"type":"authenticated","protocolVersion":1}`. Invalid, oversized, late,
or repeated frames close the socket with a deterministic secret-free reason;
rate-limited attempts use close code `4429`. Never paste a real credential into
a WebSocket URL or diagnostic command.

Station Connect learns identity from the unauthenticated public handshake and
keys authorization state by the stable environment ID, not only by the mutable
URL. Browser connection profiles use `localStorage`. A manually supplied
operator bearer remains in the conservative `sessionStorage` credential
adapter and disappears with the tab session. Same-origin pairing instead asks
the server to retain the independently revocable device credential in a
persistent `HttpOnly` cookie; the exchange response contains only device and
environment metadata. Clearing site data requires pairing again. Use a
dedicated trusted browser profile and treat an origin compromise as authority
to act through that paired session even though scripts cannot extract its
credential. Native clients should inject a keychain-backed credential adapter.

The preferred browser path creates a short-lived access request directly from
the Station origin. It requires an exact configured Origin, is limited to five
attempts per direct peer per minute, returns only the one-time exchange proof to
the requesting browser, and cannot confirm itself because confirmation remains
behind operator authentication. The server also prunes expired offers before
every allocation and enforces a global cap of 256 active offers, so distributed
or changing peer addresses cannot grow the in-memory queue without bound.
Metrics contain only the fixed source and outcome dimensions—not names,
addresses, proofs, environment IDs, or network identity.

Pairing offers expire after five minutes and are single-use. QR payloads contain
an environment ID, intended HTTPS endpoint, random challenge, scope, and
expiry—never a bearer credential. Manual entry uses the same flow with a
10-character one-time code. A named request must be explicitly approved on the
host before exchange. An authenticated host may instead deny it; denial is
final for that offer and returns only a fixed error code to the requester. An
issued device credential can use ordinary HTTP, SSE, and WebSocket surfaces up
to whatever scope its grant carries (see "Scope model" above) — under every
preset it cannot create or confirm pairing offers, enumerate devices, or
revoke another device, since none of those grant `access:manage`. Per-device
revocation is checked on every new authorization without rotating other
credentials.

The server record is created in the selected Station home with restrictive
directory/file permissions. Do not copy it into a repository, support ticket,
shell history, or shared note. The preferred bootstrap is an already-authorized
host confirming a one-time pairing request. Revealing the operator credential
into Station Connect's masked advanced field is the recovery fallback, not
normal browser onboarding.

## Attached terminal transcripts

An externally created terminal transcript is untrusted local input, not an
authority grant. Discovery is confined to the configured Claude projects root;
it accepts regular non-symlink JSONL files only, applies byte/line/event bounds,
and keeps source paths, raw transcript content, and external identifiers out of
telemetry and public errors. Unknown or incomplete records are ignored or
deferred rather than interpreted as commands.

Attached sessions are read-only at the orchestration service boundary. Every
command and lifecycle mutation is rejected with the fixed public error before
adapter lookup, so hiding UI controls is defense in depth rather than the
security boundary. The read model retains the last imported transcript after a
source disappears but does not infer external-process liveness from that fact.

## Failure handling and audit data

Malformed or missing bearer credentials return `401`; a rejected Origin
returns `403`; bounded repeated failures return `429` and `Retry-After`.
Authentication failure accounting is in memory, bounded by peer count and time,
and keyed by the normalized direct peer.

Structured audit events contain only event type, denied outcome, reason class,
route class, peer class, transport, and timestamp. They must never contain the
credential, authorization header, query string, raw URL, environment ID, user
path, or workspace details. Public liveness and handshake responses are also
secret-free.

## Bootstrap, rotation, reset, and recovery

Run lifecycle commands locally from a private terminal. Avoid command tracing,
screen sharing, transcript capture, and redirecting credential output.

1. Inspect non-secret identity with `./station environment show`.
2. Prefer **Connections → Pair a device** and confirm the named request on the
   host.
3. For recovery bootstrap, reveal the operator credential only when ready to
   enter it with `./station environment credential show`.
4. Verify the remote protected connection before closing the local terminal.

`./station environment credential rotate` preserves the environment ID and
rotates only the operator bootstrap credential; independently issued device
credentials remain valid until individually revoked or the environment is
reset. It prints the new operator credential after confirmation. `--force` is
required without an interactive terminal.

`./station environment reset` rotates both identity and credential. It does not
print the credential; use the explicit credential show command afterward.
Reset also clears every paired-device credential. Use it only for identity
compromise or intentional re-provisioning: clients see a new environment and
must be bootstrapped again. Keep local shell access until remote recovery
succeeds to avoid lockout.

If remote access is lost, use loopback access or a local shell to inspect the
environment, reveal/re-enter the credential, and check the public handshake.
Do not weaken the boundary, add a credential to a URL, or broaden
`ALLOWED_ORIGINS` as an authentication workaround.

## Rollback

Application rollback is an exact-SHA deployment rollback or PR revert. Do not
delete or replace the Station home: preserving it preserves environment
identity and the current credential. After rollback, verify public liveness,
the public handshake, loopback access, unauthenticated remote denial, and an
authenticated protected read. If a release changed the credential or identity,
restore access through the local CLI rather than copying an old security record
over a newer one.
