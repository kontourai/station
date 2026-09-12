# Deployment authentication adapters

An operator can supply Station's account authentication through the public
`@kontourai/station-contracts/deployment-authentication` contract. The adapter
is trusted server code selected at process startup. Project plugins and HTTP
requests cannot register an authentication authority.

This interface supplies account login operations and a verified person. Device
grants, Project membership, private Session access and execution offers remain
independent. An account cookie alone cannot load the personal Project catalog.
Station-local account enrollment, email delivery, invitation management and
the operator/Project-admin UI are tracked under #1981 and #488. Configurable
OIDC is #1983; the official hosted identity contract is #489. This adapter
boundary does not claim those user journeys complete.

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
  path is reserved.
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

## Verify an implementation

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
