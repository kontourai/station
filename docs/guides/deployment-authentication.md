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
are described below; complete shared-content/device admission remains under #488.
Configurable OIDC is #1983; the official hosted identity contract is #489.
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

**Settings → Station configuration → Accounts and sign-in** lets an operator
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
  purpose. An explicit POST logout operation is required. The core `/session`
  and `/accept-invitation` paths are reserved.
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

POST requires the configured Station origin. Cross-origin form-post callbacks
are outside this first contract's supported browser flow; use a GET code callback
with the provider's state, nonce, issuer, audience and PKCE verification. OAuth
authorization alone does not establish identity. A custom non-OIDC adapter must
verify identity using its provider's documented contract.

This namespace is independent of personal-device scopes. Other Station APIs
continue to require their existing credential and authorization. Current
account identity is carried through the runtime's bounded-body replacement and
used by its principal-resolution owner. Project sharing still needs the separate
member/resource authorization implementation.

## Browser invitation entry

`/account/join#invitation=<token>` opens the account entry independently of the
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

This entry currently confirms membership; the complete shared-work/device
admission journey remains under #488. Optional native opening, compatible
platform downloads and installation continuation are required follow-up
acceptance under #488 and #497. Their completion requires real browser/native
evidence and published artifacts; the account page does not establish that an
app is installed or that a device has been approved.

## Verify an implementation

### Application sessions over virtual transports

`@kontourai/station-contracts/application-session` defines
`station.application-session/v1`. The SDK implementation is
`@kontourai/station-sdk/application-session`. Ordinary HTTPS keeps native
HttpOnly cookies. A virtual transport uses a separate Station-issued continuation
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
credentials enter it. The continuation adds these headers to the normal Device
authorization:

| Header | Meaning |
| --- | --- |
| `Authorization: Bearer <device-credential>` | Existing independently approved Device grant |
| `X-Station-Account-Continuation` | Opaque, proof-key-bound continuation; not a provider cookie or bearer session token |
| `X-Station-Account-Proof` | Fresh ES256 compact JWS for the logical request |
| `Origin` | Actual, explicitly allowed client origin; never omitted to impersonate a native client |

The proof has type `station.application-session+jwt` and signs the protocol
version, Station id, purpose, server nonce, method, canonical target, credential
hash for resource requests, random request-proof id and issuance time. Verification
requires a fresh proof (60 seconds, five-second clock tolerance), exact public key,
nonce, target including query, method and continuation. This is a Station virtual
request profile, not a claim that a DataChannel is HTTPS or implements OAuth DPoP.
The encrypted transport still owns message/body integrity. Do not prebuffer a
response outside its authorized delivery boundary or rewrite its target/query.

`GET /api/account-auth/continuations` advertises cookie exchange and virtual login
separately. The remaining operations are POST:

| Path suffix | Input and effect |
| --- | --- |
| `/challenge` | Public P-256 JWK; checks the Device and origin, returns a nonce/challenge valid for two minutes |
| `/exchange` | Challenge id and proof; requires the current HTTPS account cookie |
| `/login` | Challenge id, proof and provider credentials; uses a provider-native server login without exporting cookies |
| `/renew` | Current continuation/proof headers; rechecks the source session and Device, retains the authority key |
| `/revoke` | Current continuation/proof headers; revokes the provider session and its continuation renewal family |

Controls have a 16 KiB body limit. Login attempts are bounded per Device credential.
Continuations last at most 15 minutes and never outlive their provider session.
Renew before expiry; an expired continuation requires fresh login or cookie
exchange. Older renewed credentials remain bounded by their original expiry,
and source-session logout invalidates all of them. Challenges, continuations and
consumed proof ids are bounded and stored privately in SQLite. Repeated verification
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
