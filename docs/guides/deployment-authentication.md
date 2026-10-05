# Deployment authentication adapters

An operator can supply Station's account authentication through the public
`@kontourai/station-contracts/deployment-authentication` contract. The adapter
is trusted server code selected at process startup. Project plugins and HTTP
requests cannot register an authentication authority.

This interface supplies account login operations and a verified person. Device
grants, Project membership, private Session access and execution offers remain
independent. An account cookie alone cannot load the personal Project catalog.
Built-in username/password accounts and manually shared invitation links work
without a mail service. The implemented administration and membership boundaries
are described below and in [Project rooms #488](https://github.com/kontourai/station/issues/488).
Independent-person acceptance is tracked separately in [#497](https://github.com/kontourai/station/issues/497).
Optional configured OIDC choices use the same local account/session owner (see below); the official hosted identity service is tracked in [#489](https://github.com/kontourai/station/issues/489).
Optional provider integration does not make hosted identity a core prerequisite.

## Enable local accounts without email

Choose this built-in configuration instead of an authentication module:

```sh
export STATION_PROJECT_SHARING=1
export STATION_LOCAL_ACCOUNTS=1
export STATION_AUTHENTICATION_ORIGIN=https://station.example.com
export ALLOWED_ORIGINS=https://station.example.com
```

Leave `STATION_AUTHENTICATION_MODULE` unset. HTTP loopback origins are supported
for local development. This configuration does not provision public reachability
or TLS. Solo local operation still requires neither accounts nor a provider when
these opt-ins are absent.

The operator enables sharing in a Project's **People and access** section,
chooses a role and creates a single-use invitation link. Share the link manually;
no email is sent. The default link may be accepted by any authenticated person
who possesses it, once, before its expiry. Cancel a pending link from that same
section. An optional email restriction requires provider-verified contact
evidence; a local username alone cannot satisfy it.

The recipient opens the link, creates a username/password account, signs in and
explicitly accepts the invitation. Local accounts use Better Auth's maintained
username/password and session implementation. Passwords never enter Project
records or SDK responses. Account subjects are opaque persisted IDs, qualified by
this Station's issuer. Better Auth's required internal email column uses a
reserved `.invalid` address; it is never emitted as contact or identity evidence.

**Settings → System → Accounts and sign-in** lets an operator
disable sign-in, revoke account sessions or create a password-recovery link.
Confirm the person's identity before sharing that recovery link privately. The
link expires after 20 minutes and can reset the password once; reset revokes old
account sessions. These controls do not delete Project membership or device
grants. A Project administrator does not inherit Station operator authority.

The authentication secret and account store live in private SQLite files beneath
this Station home's `authentication` directory. Restart preserves existing
account identity and unexpired cookies. Another Station identity or a missing
authority secret for an existing account store is refused. Preserve that whole
private directory under the Station home backup/recovery procedure.

Private-file checks enforce ownership and modes on POSIX systems. The Windows
path checks file/directory shape and symlinks, but does not validate a private
Windows ACL. The operator must protect that directory and its backups with
appropriate OS access controls; Windows custody has not been qualified by
this audit. These files are not a generally encrypted database.

## Configure a deployment

Use Node.js 24 and an operator-owned JavaScript module with a named async
`createStationAuthenticationProvider(host)` export. Install its authentication
library and dependencies through the deployment's package owner. Keep secrets
in the operator's credential store or protected environment; never put them in
Project manifests, returned descriptors, source control or logs.

Set both process variables before starting this Station:

```sh
export STATION_AUTHENTICATION_MODULE=/srv/station-auth/provider.mjs
export STATION_AUTHENTICATION_ORIGIN=https://station.example.com
export ALLOWED_ORIGINS=https://station.example.com
```

The module path must be absolute and name a regular file. The public origin
must use HTTPS; HTTP is accepted only for loopback development. Preserve any
other origins the deployment already needs when configuring `ALLOWED_ORIGINS`.
These settings do not provision a tunnel, DNS, TLS or email delivery.

Omit both authentication variables for existing account-free local operation.
An incomplete or invalid configured adapter fails startup rather than silently
disabling authentication. Changes to the module or its configuration require a
controlled process restart.

The factory receives the exact Station identity, public origin, fixed
`/api/account-auth` base path and a private `authentication` directory within
this Station home. That directory rejects symlinks and, on POSIX systems,
requires operator ownership and private permissions. The adapter owns its
database migrations, secret rotation, backup compatibility and account/session
storage within that custody boundary. It must clean up a failed initialization
and implement idempotent resource closure.

## Public contract

`DeploymentAuthenticationProvider` extends a closed descriptive contract:

- `version` is `station.authentication/v1`.
- `issuer` is a stable, exact authority URI. Public URL changes must not
  silently change existing identities.
- `displayName` is presentation only.
- `sessionCookies` names one to four account cookies. Use names unique to this
  Station authority, including when several Stations share a hostname. Existing
  Station device-cookie names are reserved. Multiple presented account cookies
  are a conflict; no credential is selected by precedence.
- `endpoints` lists exact relative paths, GET/POST methods and their login,
  callback, registration, contact-verification, recovery, refresh or revocation
  purpose. An explicit POST logout operation is required. The core `/session`,
  `/invitation-preview`, and `/accept-invitation` paths are reserved.
- Optional `login` selects the standard browser entry: `email-password` or
  `username-password` names
  declared POST `signInPath` and optional `signUpPath` operations; `redirect`
  names a declared GET `startPath`. Station validates their operation purposes.
  Omit this capability when the adapter owns its own entry interface.
- `authenticate(request)` receives copied headers, URL, method and an abort
  signal, with no destination request body. It checks current account/session
  state and returns `absent`, `invalid`, `unavailable` or `authenticated`.
- `handle(request)` serves only declared endpoint/method pairs. It owns the
  maintained authentication library's login, callback proof, password hashing,
  CSRF, contact verification and cookie issuance. `close()` releases resources.

Station invokes session verification only when a declared account cookie is
present. Empty or duplicate credentials are refused. A provider's `absent`
result for a presented credential becomes an invalid-credential refusal;
provider failure never falls through to operator identity. Verification and
operation waits are bounded and carry cancellation. An adapter must honor that
signal; stopping the wait does not prove an external operation was undone.

An authenticated result contains an opaque stable subject, display name,
non-secret session record ID, authentication/expiry timestamps and verified
contact claims. It contains no Station role, device grant or Project permission.
Unknown authority-bearing fields are rejected. Expired results are refused.
Issuer/subject pairs are encoded as JSON and hashed with SHA-256 into a bounded
`human:deployment:` principal. Emails and display names do not participate in
that derivation, and equal emails never link accounts across issuers.

Disable stale session-cookie caches for authorization reads. For example,
[Better Auth's session documentation](https://better-auth.com/docs/concepts/session-management)
explains that cookie caching can delay revocation visibility. Session renewal
belongs to an explicit operation that can deliver its cookie response; ordinary
verification must not consume the destination body or silently refresh cookies.
Original device/person bindings and historical authorship are preserved. A
conflicting verified ingress person or device/person binding is refused.

## HTTP behavior

`GET /api/account-auth` returns the provider descriptor, including its version.
`GET /api/account-auth/session` authenticates and returns the current person,
issuer, expiry and verified contacts. It exposes neither a session token nor
the private session record ID. With no adapter configured, these routes return
501. A missing/invalid account returns 401; provider unavailability returns 503.

`POST /api/account-auth/invitation-preview` takes `{ "token": "<invitation>" }`
and returns only the offered Project name, inviter display, role/actions, expiry
and optional verified-email restriction. A current link is required, but sign-in
is not: this lets the recipient understand the offer first. The service holds the
exact Project revision and checks the current invitation and inviter authority.
It returns no filesystem path, member inventory or private work. Keep the token
in the request body; never put it in an HTTP path or query string.

`POST /api/account-auth/accept-invitation` accepts a single invitation token
using the current authenticated account. Email-restricted invitations additionally
require matching verified contact evidence. When Project
sharing is configured, its membership owner checks the current Project and
inviter authority, then consumes the invitation with the membership write.
The response explicitly reports `grantsDeviceAccess: false`. Without that
membership owner the route returns 501. Account authentication and invitation
possession alone cannot approve a device or access private Project content.

Other GET/POST paths under this namespace reach only declared adapter operations.
Unknown operations return 404. Bodies are limited to 32 KiB, responses use
`Cache-Control: no-store`, and the owner reserves a bounded per-peer attempt
budget before adapter invocation. The adapter must also enforce its account-
and operation-specific abuse controls.

Ordinary browser POST requires an exact configured allowed browser origin. The public Station
origin is included; additional origins must be explicitly configured through
`STATION_AUTHENTICATION_BROWSER_ORIGINS` as well as the existing CORS policy.
This does not make arbitrary cross-origin form-post callbacks supported. Use a GET code callback
with the provider's state, nonce, issuer, audience and PKCE verification. OAuth
authorization alone does not establish identity. A custom non-OIDC adapter must
verify identity using its provider's documented contract.

The native invitation-acceptance leaf is a separate exception: the router
requires private current native Pion provenance, current Device proof and
matching native account continuation/proof. It rejects browser Origin, cookies
and Authorization headers. Its authenticated body is already bounded to 16 KiB
by native admission, and its attempt budget is keyed to the verified Device.
Neither an originless direct HTTP request nor a native routing grant earns this
exception.

This namespace is independent of personal-device scopes. Other Station APIs
continue to require their existing credential and authorization. Current
account identity is carried through the runtime's bounded-body replacement and
used by its principal-resolution owner. Project sharing still needs the separate
member/resource authorization implementation.

### Account-bound collaborator Devices

A collaborator Device uses an explicit second pairing ceremony after account
authentication. Ordinary requests retain the existing pairing shape. Guest
entry sends `requireAccountBinding: true` with a fresh client-instance
correlation; Station attaches an optional
`accountCandidate` containing the provider-verified `issuer`, opaque `subject`
and display name. A client cannot nominate or replace that candidate. The
operator reviews it and confirms with `{ "bindAccountIdentity": true }`.
This flag is mutually exclusive with the existing
`bindVerifiedIdentity` Tailnet-person approval. Confirmation returns the
bounded `principalBinding` receipt, including its account kind, issuer,
subject, display name, approval ID, approver and time. Station rechecks the
provider session and operator credential after reading the confirmation body.

The exchanged Device must present a current account for that exact
issuer/subject on protected resource requests, apart from the narrowly scoped
Device-binding self-read and native neutral observations described below.
Missing, revoked or conflicting
account proof is refused before resource authorization. Cookie-only signup and
login remain available so a person can authenticate before receiving such a
Device; authentication itself grants neither the Device nor Project access.
An existing unbound personal Device is not silently converted by login. The
operator must explicitly approve and exchange the account-bound replacement,
then revoke any older broad grant retained for that client.

The direct request-access endpoint also accepts `requireAccountBinding: true`
after sign-in. Station attaches the verified account candidate and makes this
intent immutable: approval and exchange cannot issue a personal or Tailnet-bound
Device for that request. Existing ordinary pairing requests remain available.

The collaborator profile admits account controls, membership-filtered Project
catalogue/detail reads, and bounded reads of explicitly published shared Tasks:
the shared-work list, history, document and publication receipt. Shared work is read-only in this
entry. The [account-bound Device gate](../../src-server/runtime/bootstrap/account-bound-device-gate.ts)
admits those specific paths; the
[shared Task routes](../../src-server/routes/projects/project-shared-tasks.ts)
independently require current membership and publication. A member's
publication read returns the same summary the shared-work list gives for a Task
currently shared into that Project incarnation. An unshared, stale, unknown or
other-scope Task gets the routes' uniform not-found response, so a member cannot
tell them apart. Only the operator sees the `unshared` review state, and sharing
and unsharing stay operator-only. Protected reads set
`Cache-Control: no-store` and bind response delivery to the exact local and
portable Project incarnation. Membership is rechecked before delivery and each
streamed chunk. The audited administration endpoints below are the only
additional Project mutations admitted here. Unrelated personal configuration,
plugin, terminal, coding, secret and orchestration surfaces remain denied even
if the Device scope is broader. Existing unbound local/operator Devices retain
their prior behavior. Existing Tailnet person bindings remain a separate
personal-device mechanism; they do not become Project membership through this
account contract.

#### Invited administrators through the API

An accepted Project administrator can read `GET /api/projects/:slug/access`
with an approved account-bound Device carrying `orchestration:read`. To manage
members or invitation links, the operator must independently approve
`orchestration:operate` on that Device through the existing
`POST /api/pairing/devices/:deviceId/scope` endpoint. Grant exactly
`["orchestration:read", "orchestration:operate"]`; the standard personal-device
preset includes terminal access and is not the collaborator-management grant.
The person remains signed in as their own account throughout this workflow.

The audited POST leaves beneath `/api/projects/:slug/access` are
`invitations`, `invitations/:invitationId/revoke`, `members`, and `transfer`.
Read the current administration response for its exact Project scope and member
revisions before submitting a change. Current membership must independently
permit the action: an operate grant does not turn a viewer into an admin, and
ownership transfer remains owner-only. Enabling sharing is operator-only.
Stale revisions and replaced Project scopes refuse rather than overwrite.

Administration views and invitation tokens recheck current account, Device,
Project incarnation, and management permission before delivery and each queued
body chunk. A committed mutation is not retried if its response becomes
unauthorized. Self-demotion or self-revocation can still return the contentless
`{ "changed": true }` acknowledgement while the same request credential/account
and Project incarnation remain valid; this acknowledgement carries no protected
member or token data. Already downloaded plaintext cannot be recalled.

The [guest entry](../../src-ui/src/views/account/GuestDeviceOnboarding.tsx)
mounts Project access controls as well as shared Task views. Showing those
controls does not confer administration: current membership and the separately
approved Device scope still govern each action. Independent-person browser and
native qualification remain separate from backend and component-test evidence.

For authenticated members, the existing Project catalogue/detail endpoints
return `station.member-project/v1` views: Project ID, slug, name, optional icon
and description, and currently effective actions (`view` in this profile).
Local workspace paths, provider/model configuration, knowledge settings and
layout metadata are excluded. Unaudited nested Project resources remain denied.
Personal/operator callers retain their full Project configuration.

SDK consumers use `listProjectViews` and `getProjectView` to handle the typed
member/full-view union. Legacy `listProjects` and `getProject` refuse member
projections rather than pretending they contain full configuration. Unknown
versions, extra fields and malformed member views fail validation.

Shared Task list/history/document/publication reads are implemented separately from that
restricted base Project projection. Shared editing and execution, compute-offer
access, and the fully qualified two-person browser/native journey remain
separate work discussed in [#483](https://github.com/kontourai/station/issues/483),
[#488](https://github.com/kontourai/station/issues/488) and
[#497](https://github.com/kontourai/station/issues/497). Tailnet member integration is discussed in
#1513 and [#488](https://github.com/kontourai/station/issues/488).

## Browser invitation entry

`/account/join#invitation=<token>` previews the current Project, inviter and
offered role before presenting account entry. A refused preview shows recovery
guidance without offering registration or acceptance. The page runs independently of the
personal Station provider tree and persisted Project query cache. It uses the
same browser origin's account service and attaches no operator bearer. Sign-in
and invitation acceptance are separate user actions. Password registration is
offered only with an invitation and a declared registration operation; the
provider still owns registration eligibility and its configured contact policy.

The page removes invitation and password-reset proof from the visible URL.
Invitation continuation stays in this tab's session storage for at most one hour
so a provider redirect can return to it. The server's invitation expiry and
single-use checks remain authoritative. Password-reset proof stays only in the
open page's memory. An invalid new invitation cannot select a prior invitation
saved in the tab. `/account/reset#token=<proof>` uses the provider's declared
recovery operation and returns to sign-in after success.

A new invitation fragment received in an already open tab replaces the current
entry and clears its form state. An earlier acceptance finishing afterward clears
only its own saved continuation, never the newly received invitation.

After acceptance, this entry requests an immutable account-bound Device and
shows validated `station.member-project/v1` catalogue and detail metadata.
It rechecks the exact signed-in principal around each read, removes stale query
authority when the Station or account changes, and returns to Device approval
when that grant is revoked. It never mounts the personal Station provider tree
or treats a personal Device receipt as guest access. Selecting a Project also
opens bounded, read-only shared Task list/history/document views and the
separately authorized Project access view. Shared content requires current
publication and membership, revalidated through guarded response delivery;
base Project metadata alone grants neither. Shared Task editing and execution
remain outside this entry. Optional native opening, compatible
platform downloads and installation continuation are required follow-up
acceptance discussed in [#488](https://github.com/kontourai/station/issues/488) and
[#497](https://github.com/kontourai/station/issues/497). Their completion requires real browser/native
evidence and published artifacts; the account page does not establish that an
app is installed or that a device has been approved.

## Verify an implementation

### Application sessions over virtual transports

`@kontourai/station-contracts/application-session` defines
`station.application-session/v1`. The SDK implementation is
`@kontourai/station-sdk/application-session`. Ordinary HTTPS keeps native
HttpOnly cookies. A same-origin HTTPS browser can explicitly adopt its current
`__Host-station-device` cookie and provider account cookie into a read-only alias
for that same approved Device plus an exact alias-bound continuation. The SDK's
`ApplicationSessionClient.adoptCookies()` sends them only through the browser's
same-origin cookie handling; cookie values are never read by JavaScript or
returned in JSON. The provider must verify the current exact session reference
before and after issuance. No new Device grant is created.

A virtual transport uses a separate Station-issued continuation
and a non-extractable P-256 signing key; it does not process `Set-Cookie` or extract
provider cookies into JavaScript. The existing approved Device credential remains
independently required. Transport/Station connection proof grants neither one.

The SDK's `ApplicationSessionSigner` allows a native bridge to sign in protected
platform custody. Its browser factory creates a non-extractable WebCrypto key;
persist the CryptoKey and public JWK, then use `restoreApplicationSessionKey` to
restore the facade. Never serialize private key bytes. Non-extractability is a
custody property, not an attestation supplied by a client-controlled JSON field.

All application headers and bodies travel inside the authenticated encrypted
transport. The receiver must establish the selected Station's identity before
credentials enter it. The browser-profile continuation adds these headers to the normal Device
authorization:

| Header | Meaning |
| --- | --- |
| `Authorization: Bearer <device-credential>` | Existing independently approved Device grant |
| `X-Station-Account-Continuation` | Opaque, proof-key-bound continuation; not a provider cookie or bearer session token |
| `X-Station-Account-Proof` | Fresh ES256 compact JWS for the logical request |
| `Origin` | Actual, explicitly allowed client origin; never omitted to impersonate a native client |

The proof has type `station.application-session+jwt` and signs the protocol
version, Station id, purpose, server nonce, method, canonical target, continuation
credential hash for resource requests, random request-proof id and issuance time. Verification
requires a fresh proof (60 seconds, five-second clock tolerance), exact public key,
nonce, target including query, method and continuation. This is a Station virtual
request profile, not a claim that a DataChannel is HTTPS or implements OAuth DPoP.
The encrypted transport still owns message/body integrity. Do not prebuffer a
response outside its authorized delivery boundary or rewrite its target/query.

`GET /api/account-auth/continuations` advertises cookie exchange, cookie adoption
and virtual login separately. The operations are POST:

| Path suffix | Input and effect |
| --- | --- |
| `/challenge` | Public P-256 JWK; checks the Device and origin, returns a nonce/challenge valid for two minutes |
| `/exchange` | Challenge id and proof; requires the current HTTPS account cookie |
| `/login` | Challenge id, proof and provider credentials; uses a provider-native server login without exporting cookies |
| `/adopt-cookie/challenge` | Same-origin HTTPS only; reads the existing secure Device cookie and current provider account cookie, then binds the challenge to both identities and the key |
| `/adopt-cookie/complete` | Challenge id and proof; rechecks the same Device and exact provider session, then atomically records the continuation with its bounded Device alias |
| `/renew` | Current continuation/proof headers; rechecks the source session and Device, retains the authority key |
| `/revoke` | Current continuation/proof headers; revokes the provider session and its continuation renewal family |
| `/adopt-cookie/revoke-alias` | Current alias and exact continuation/proof; revokes only that alias, not the provider account session or parent Device |

Controls have a 16 KiB body limit. Login attempts are bounded per Device credential.
Continuations last at most 15 minutes and never outlive their provider session.
Renew before expiry; an expired continuation requires fresh login or cookie
exchange. Older renewed credentials remain bounded by their original expiry,
and source-session logout invalidates all of them. Challenges, continuations and
consumed proof ids are bounded and stored privately in SQLite. Alias issuance
uses a durable private journal: startup revokes an alias if issuance was
interrupted before the continuation's first successful request; a continuation
already used remains valid across restart. The alias is limited by the pairing
store to eight active aliases per Device and thirty days. Repeated verification
of the same admitted server Request rechecks live authority without consuming the
proof twice; a new request replay is refused, including after process restart.

The provider opts in with private `sessionReferences.verify(sessionId, signal)`
and `sessionReferences.revoke(sessionId, signal)` hooks. The id comes from a
previously verified result and is never accepted as a caller's identity claim.
An optional `sessionReferences.login(request)` enables virtual-only login. Local
username accounts implement these through the maintained auth library. A custom
or OIDC provider must retain its own verified callback and private session owner;
no missing hook falls back to caller-supplied subject/email, browser cookie
emulation or an operator credential. Unsupported providers return 501. This
interface does not claim a deployed Google/OIDC callback flow.

For an additional application origin, configure
`STATION_AUTHENTICATION_BROWSER_ORIGINS` as a comma-separated explicit list, and
include that origin in the deployment's existing `ALLOWED_ORIGINS`. The public
Station origin remains allowed. Known native-shell origins may be explicitly
listed; missing Origin is never evidence of native custody. This policy binding
is not hardware or browser attestation.

Every application request checks current account/session and Device state. A
conflicting approved Device/person binding is refused. Continuation issuance does
not create that binding or change its grant. Response delivery rechecks account
authority before headers and before releasing each body chunk, including producer-
queued chunks. It does not recall bytes already released or prove cancellation of
work already accepted by an external engine. Project/resource and compute policy
remain at their existing owners and require their own live checks.

Account-specific 401 responses carry `X-Station-Authentication-Failure: account`.
The SDK invokes `onAccountUnauthorized` instead of discarding the Device credential.
Bind that callback and the continuation's stable `authorityKey` to the client's
account/cache lifetime. Account changes must retire pending operations and private
state; renewal of the same authority must not retarget them.

The core/SDK fixture is free and uses real cryptographic keys, maintained local
sessions and the production HTTP principal path without a cookie-processing client.
It is not proof of actual WebRTC delivery, native key custody or two-human use;
the relay consumer and physical acceptance must supply those receipts.

#### Native application-session profile

`station.application-session-native/v1` is a separate opt-in profile.
`POST /api/account-auth/continuations/native/challenge` accepts its version and
public JWK; `/native/exchange` accepts its version, challenge ID, provider
credentials and proof. Both require server-owned request provenance from the
admitted native Pion/virtual-application path, the exact configured Station
audience and native surface, and an approved Device already bound to an account.
They reject a browser `Origin`; absence of that header on a direct HTTP request
does not establish native provenance. Controls retain the 16 KiB body bound.

The provider must support private session-reference login and verification.
Exchange consumes the challenge before provider login, then rechecks the exact
provider subject/session and Device binding before persisting a continuation.
The client's exchange proof binds the exact serialized credential body; resource proofs bind the
method, path/query, Station audience, native surface, Device, nonce and
continuation hash. Native resource requests carry
`X-Station-Native-Account-Continuation` and `X-Station-Native-Account-Proof`
alongside the existing Device credential. Combining native and browser
continuation headers is refused. The receiver rechecks current provider and
Device authority and rejects replay; the native continuation lasts at most
15 minutes and never beyond its provider session.

The native SDK supplies `challenge`, `exchange`, signed read `headers`, and
fixed host-prepared invitation-acceptance and revocation operations.
`POST /api/account-auth/continuations/native/revoke` accepts only an empty
object with the current native account and Device proofs. It removes that
continuation before awaiting provider-session revocation, then verifies the
provider session is absent or invalid; an uncertain provider outcome does not
restore the continuation. Device custody is independent. The profile adds no
native renewal or cookie-adoption operation. Host preparation expiry also caps
the client continuation and cannot be extended by a delayed account exchange.
The client consumes a caller-owned encrypted transport and independent account
signer. The
[connector opt-in](self-hosted-broker.md#native-routing-grant-foundation-v2)
and [SDK contract](../reference/sdk.md#native-station-account-continuation-opt-in)
do not establish ordinary Desktop activation, key-custody integration or a
physical end-to-end result.

The executable external-module fixture materializes a disposable module using
the public factory contract and loads it through the production loader. It
exercises login, self identity, invalid/revoked sessions, provider outage, origin
refusal and denial of the personal Project catalog:

```sh
npm run test:focused -- src-server/services/identity/__tests__/deployment-authentication-http.test.ts
```

The full runtime composition test uses a real approved device grant and the
actual principal resolver to prove account attribution survives body buffering,
and rejects a conflicting verified person before attachment staging:

```sh
npm run test:focused -- src-server/runtime/routes/__tests__/runtime-routes-device-session-chat-principal.test.ts
```

The fixture's synthetic credentials are test evidence only. Qualify a real
adapter with its issuer, callback, expiry, revocation and recovery failures, then
test member access against the actual Project APIs. Email receipt, two-human
acceptance, browser/native credential custody and device revocation require
their own runtime evidence. Do not infer them from these source/fixture checks.

## Operations and recovery

Keep account/session, device and Project revocation distinct. A Project admin
does not acquire Station operator authority by managing membership. The operator
must retain the existing local bootstrap/recovery path; it must not be replaced
by an email assertion or an adapter role claim. Shared-mode ownership and
last-owner transfer protection belong to the access-management implementation.

Close the adapter with the Station lifecycle before replacing its account store.
Do not clone a live authentication authority into two active homes. Home movement
and recovery must use the owning home-authority procedure. Rolling back the
adapter disables its login surface; it must not erase account history or silently
reassign persisted principals to the local operator.


## Optional OIDC choices with local accounts

Operators can offer an OpenID Connect identity provider alongside local
username/password accounts. Set `STATION_LOCAL_ACCOUNT_OIDC_FILE` to an absolute
JSON file path, while retaining `STATION_LOCAL_ACCOUNTS=1` and the public
Station authentication origin:

```json
[
  {
    "id": "example",
    "displayName": "Example identity",
    "issuer": "https://identity.example.org",
    "clientId": "station-client",
    "clientSecretEnv": "STATION_EXAMPLE_OIDC_SECRET"
  }
]
```

Provide the named secret through the operator's environment/secret manager;
never place it in an invitation, client configuration or Project manifest.
Treat the provider `id` and issuer as durable configuration. Change the display
name for presentation; changing an identifier is not an account migration.

Register the exact redirect URI
`<STATION_AUTHENTICATION_ORIGIN>/api/account-auth/callback/example` with the
issuer. This implementation supports authorization-code callbacks using GET,
not arbitrary OAuth providers or provider-specific native token exchange.
Custom identity protocols retain the deployment module contract above.

The pinned Better Auth generic OAuth implementation performs discovery, code
exchange, PKCE, ID-token signature/audience/issuer validation and nonce binding.
Station additionally pins the discovered issuer to the configured issuer,
requires an ID token on every OIDC callback (no UserInfo-only downgrade), and
refuses registration if required verification is unavailable. The pinned
library encrypts OAuth access and refresh tokens in the account store. This
setting does not encrypt every account field or the database as a whole;
other stored identity material relies on the private-file access controls.
The public descriptor exposes only the configured display choice, availability
and Station login endpoint. It exposes no client secret or provider token.

The browser starts a declared POST login operation. Station chooses the callback
and return destination; request-supplied redirect URLs or OAuth parameters are
not accepted. Invitation intent travels in the library's server-controlled
OAuth state and is checked again against the real invitation owner after
verified identity returns. Account creation does not accept the invitation or
grant Project/Device permissions. The underlying external account key includes
verified issuer and immutable subject; reusing an operator's provider label for
a different issuer cannot inherit an old account. UserInfo must identify the
same subject as the verified ID token, following [OIDC Core UserInfo validation](https://openid.net/specs/openid-connect-core-1_0.html#UserInfoResponse). Equal emails never link accounts automatically.

Discovery runs at account-provider startup. If discovery returns a failure or
an issuer mismatch, the optional provider becomes unavailable and its
start/callback endpoints refuse, while local username/password login can start.
A stalled discovery request delays the whole account provider: this path has
no Station-owned discovery deadline. Optional OIDC therefore does not yet have
independent startup availability. Restart after repairing issuer configuration
or connectivity. Existing Station sessions use Station's current local
account/session revocation state; disabling an account at the external IdP does
not itself revoke an already established Station session. Operators can disable
or revoke it through Station's account administration.

The cookie-free continuation contract remains unchanged: local passwords can
use virtual login; OIDC completes a real browser ceremony, followed by the
existing approved-Device cookie exchange and proof-bound continuation. No
DataChannel cookie handling or native handoff is implied. Tests with a free
local HTTP issuer are diagnostic evidence, not production Google/Kontour,
physical-device or independent-person acceptance.

## Opt-in native Device request-proof pilot (#2893)

An approved account-bound Device can address a narrow protected surface
without any bearer or cookie by presenting a short-lived, one-use native
Device request proof over the encrypted application channel. The pilot is
source opt-in only — `STATION_NATIVE_DEVICE_PROOF_PILOT=1` with an
authentication module that supports session-reference verify AND login;
unsupported configuration refuses to boot. Ordinary product UI is not
auto-enabled.

Preconditions, all owned by existing stores: an active paired `kind: 'device'`
Device with an account principal binding, an operator-approved native proof
binding (exact surface, Device proof key distinct from the route key) in the
private binding sidecar, and a current admitted native Pion peer whose private
facts (offer nonce, Station identity, surface) carry the request. The replay
store lives at `<home>/security/native-device-proof-replay.sqlite`.

The admitted POSTs are exactly native account-continuation challenge,
exchange and revoke, plus `/api/account-auth/accept-invitation`. GET/HEAD admits
`/.well-known/station/v1`, `/api/system/status`, `/api/system/identity`,
`/api/auth/authority`, `/api/projects`, `/api/projects/:slug`,
`/api/projects/:slug/shared-work`, and that Task's `document`, `history` and
`publication` leaves at `/api/projects/:slug/shared-work/:taskId/`. Neutral
handshake/status/identity observations may use Device proof alone when no
account material is supplied; account-bearing requests and Project reads retain
current account verification. The status exception requires verified native
Device proof; an ordinary account-bound Device with an account session still
cannot read `/api/system/status`. Everything else — pairing, consent, terminal,
plugin, operator and admin surfaces — refuses proof authority even for a broadly
scoped Device. Each request re-proves: the JWS is verified against the exact
received bytes and private peer provenance, the JTI is consumed once, and the
binding, paired Device and account binding are re-read at every seam,
including before and after each provider await. Revoking the Device, its
binding, its account session or its Project membership stops protected bytes
mid-delivery. A presented proof never falls back to a bearer or cookie, and a
proof-bearing request can never read as the local operator.

Limits: this is not packaged-Tauri, physical-device or production-identity
evidence. The opt-in runtime mounts operator-only binding approval and public
readback under `/api/pairing/native-device-bindings`; native proof authority
cannot enter that operator path. Host peer/Device and separate structured account
proof commands are registered on desktop and mobile. The selected native relay
member route and account sign-in are source-composed into the UI; ordinary
resource writes, operator and compute surfaces remain unsupported. A separate
`STATION_NATIVE_ENROLLMENT_PILOT=1` enables the
[native fresh enrollment ceremony](../design/native-relay-enrollment.md) with
its pending account-provider, approved installation surface and operator Device
approval requirements. Source composition and fixtures do not establish a
fresh native application enrollment, executed application IPC, packaged or
physical acceptance receipt.

The [account operation owner](../../src-desktop/src/native_account_operations.rs)
derives audience, Station, Device, surface, hashes, JTI and time through the
current reconciled host owner. Its independent account key prepares a complete
username/password exchange body before the application transport freezes and
Device-signs that body. It does not expose `sign(bytes)` or accept principal,
cookie or Device-bearer authority from the renderer. One exchange consumes an
opaque context; untrusted expiry hints cannot reset replay or extend lifetimes,
and effective expiry/key identity are checked after signing waits. Server
native challenges still require an already account-bound approved Device and
supported provider-native login; unsupported/OIDC relay login fails closed.

A separate protected `GET/HEAD /api/auth/native-device-bindings/:bindingId/receipt`
accepts only the owning current ordinary Device bearer with `orchestration:read`.
Its exact account-bound Device bootstrap exception allows this public binding
observation before account sign-in; it creates no account principal or Project
authority. Historical revocation/replacement remains readable by the active
Device owner, while revoking its bearer removes access. The response and
`currentDeviceBinding` are observations, not permission to activate a native
client or delete a provisional key after an unknown approval outcome. Native
proofs, cookies and operator credentials cannot substitute for the Device bearer.
See [the broker design](../design/connection-broker.md#native-device-proof-on-the-application-channel-2893)
for the protocol and the production-composition test for the exercised
boundary.
