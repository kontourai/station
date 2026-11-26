# Station routes: one saved Station, many ways to reach it

**Status: proposal, phase 1 in progress.** Owner: the connection client
([`packages/connect`](../../packages/connect/src/core/)) and the system routes
([`src-server/routes/system`](../../src-server/routes/system/)). Phase 1 ships
behind the device preview **Station routes**, off by default.

## Outcome

A device that saved a Station can reach it over every address the Station is
reachable on: its LAN address at home, its Tailscale address or Tailscale HTTPS
name away from home, and later a relay. The device tries them in order, uses
the first that answers as the same Station, and says which one it is using.
When none answers, it says why, once, for the Station as a whole.

One list answers the questions a person has when a Station is out of reach:
which addresses exist, how each was found, and which one is in use.

## What exists today

- A browser-saved connection (`SavedConnection`) already holds several
  `endpoints`, ranked by `rankCompatibleEndpoints`
  ([environmentProfiles.ts](../../packages/connect/src/core/environmentProfiles.ts)).
  `ConnectionHealthCoordinator` probes them in order and stops at the first
  success
  ([ConnectionHealthCoordinator.ts](../../packages/connect/src/core/ConnectionHealthCoordinator.ts)).
  Only the last failure reason survives a run.
- Each probe checks the Station's identity: `probeServerConnection` refuses a
  handshake whose `environmentId` differs from the saved one
  ([serverHealth.ts](../../src-ui/src/lib/serverHealth.ts)).
- Endpoints are added only by editing the connection's address or by pairing.
  Nothing learns the other addresses a Station is reachable on.
- A relay route and an SSH tunnel are saved as separate connections
  (`addBrokerRoute`, `addHostTunnel` in
  [ConnectionStore.ts](../../packages/connect/src/core/ConnectionStore.ts)).
- Native apps save a `StationProfile` with exactly one `endpoint`
  ([station-profile.ts](../../packages/contracts/src/station-profile.ts)). The
  native host retains that canonical credential origin. The in-progress native
  admission below adds temporary authority for specific alternate HTTPS origins;
  it does not replace the canonical endpoint or copy credentials.

## Model

A **route** is one address a saved Station is reached on. It is an
`AccessEndpoint` with an optional `source`:

- no `source`: added by the user or by pairing;
- `source: 'advertised'`: reported by the Station itself ("found automatically").

The route's kind is derived from its address, never stored separately:

| Address | Kind | Label |
| --- | --- | --- |
| `localhost`, `127.*` | local | This computer |
| private IPv4 (10/8, 172.16/12, 192.168/16), `*.local` | lan | Local network |
| 100.64.0.0/10, or a plain-HTTP Tailscale MagicDNS name | tailscale | Tailscale |
| an HTTPS Tailscale MagicDNS name | tailscale-https | Tailscale HTTPS |
| broker route | relay | Relay |
| anything else | internet | Internet |

Order is the existing rank: the selected route first, then priority, then kind.
A route that answered last stays selected, so a phone that moved off the home
network does not retry the LAN address first on every probe after the first
failover.

## Discovery

`GET /api/system/routes` (read tier, any paired device) answers:

```json
{ "environmentId": "env-…", "routes": [{ "kind": "lan", "url": "http://192.168.1.20:3141" }] }
```

- **LAN**: every private IPv4 address the API listener accepts on (the same
  rule nearby discovery uses), with the listener's port. A loopback-only
  listener advertises none.
- **Tailscale**: the listener's addresses in 100.64.0.0/10, when it accepts on
  them, and the node's MagicDNS name on the same port, which survives an
  address change. The name comes from the public-ingress resolver's cached
  `tailscale status` read, so it costs no extra process.
- **Tailscale HTTPS**: the Tailscale Serve origins that proxy to this Station,
  from the existing public-ingress resolver.

The handshake capability `connectionRoutes` tells a client the route exists.
An older Station omits it, and the client simply learns nothing.

The client asks only the Station it is already connected to and authenticated
with, and only when the response's `environmentId` equals the saved one. It
merges the answer:

- adds new advertised routes;
- drops advertised routes the Station stopped reporting, except the one in use;
- never touches routes the user added;
- skips plain `http:` routes on an `https:` page, which the browser would block.

On a desktop's first start, discovery waits until the native-owned local
profile has been provisioned, authenticated, and connected. With either Routes
preview enabled, the shared Routes query also reads advertisements for native
profiles. Displaying one is not permission to send the profile's credential
there. Host-owned refresh admits alternates separately, as described below;
canonical local HTTP lifecycle ownership remains unchanged. No authenticated
Routes read occurs before the canonical profile is authorized.

### Why an advertised route cannot point at another server

Learning a route does not trust it. A public handshake's `environmentId` is
copyable discovery data, not cryptographic authentication. A mismatched ID is
grounds for refusal, but a matching ID alone must not authorize sending a saved
credential to a new origin. Native admission requires the authenticated anchor's
authorization and the fresh proof described below.

### Native host-authorized alternate origins

**Status: implementation in progress; native execution and failover are
NOT_VERIFIED.** The host-owned `station_profile_refresh_routes` command in
[native_route_authorization.rs](../../src-desktop/src/native_route_authorization.rs)
returns an admission receipt, not credentials. Its intended boundary is:

1. Capture the active binding epoch (`bindingId`), profile-store revision,
   canonical origin, and environment identity. Fetch `/api/system/routes` with
   the saved credential only at that already-authorized canonical anchor.
2. Require the response's environment identity to match. Candidates must be in
   both `publication.appOrigins` and its published `tailscale-https` routes,
   using exact canonical HTTPS DNS origins. An approval origin, Nearby hint,
   or user-entered address is not admission authority.
3. Request the existing public nonce proof at the anchor and each candidate,
   using the same fresh nonce and no bearer or cookies. Refuse redirects and
   bound requests and responses. Require matching protocol, environment, nonce,
   and signature. The nonce must satisfy the existing proof route's
   43-character base64url contract; an arbitrary UUID is not compatible.
4. Recheck the captured binding and profile revision before committing. Keep
   admitted origins only in host memory for at most ten minutes, bound to that
   epoch, revision, canonical origin, and environment. A receipt exposes origins
   and expiry; it cannot expand the host's authorization.

The proof is HMAC-SHA256 from `EnvironmentSecurityService.createPublicProof`,
not a public-key identity certificate. Comparing anchor and candidate proofs
avoids requiring a paired Device to possess the operator secret. Freshness
prevents stale replay, but the public proof can be relayed live: it is **not
standalone authentication**. Authority comes from the authenticated anchor's
owned HTTPS app-origin advertisement, together with HTTPS certificate validation.
An attacker-controlled origin must never gain authority merely by returning
the same proof. No cloud account is involved; existing Device permissions apply.

The desktop's owned loopback HTTP endpoint remains canonical. This does not
authorize arbitrary LAN HTTP alternates or weaken remote TLS. Failover may use
only a currently admitted alternate, never an address that merely passes the
public handshake. Do not rewrite the profile endpoint or persist alternate
credential bindings. Expiry, binding/profile changes, restart, and failed
refresh cannot mint new authority. If the canonical anchor is unreachable,
existing admission lasts only until expiry; this is not offline anchor recovery.
Request Access remains the recovery path when no authorized route is available.

## Status

`ConnectionHealthSnapshot` gains `routes`: one entry per route from the last
run, `in-use`, `failed` (with its reason), `blocked` (the page cannot use it,
with its reason) or `not-checked` (a route ranked after the one that answered;
probing it would cost a request per poll for nothing). The Station-level
status line shows whether the Station is connected and what to do when a
check fails. An authenticated 401 can prompt pairing again. When the Station
temporarily limits sign-in checks, the client keeps checking on its normal
retry schedule. A scope refusal asks the person to check their access with
the operator. If local relay authority cannot be verified, Connections
shows where to check the selected Station and account. A public handshake
refusal can point to an address check before any authenticated request is made.

The browser relay gate keeps protected content behind the access check. It
releases a previously verified person's cached appearance after an authenticated
401 or when the account scope has settled without an account.

## UI

A **Routes** section on Settings → Devices (`?view=devices`, row
`station-routes`), for the Station this device is connected to. It stays out of
the connection manager, which keeps one compact card per saved Station:

- the failure reason, once, only when no route answers (the existing copy);
- **Routes**: one row per route with its label and an **In use** badge on the
  route that answered. A quiet line under it holds the address, "found
  automatically" for advertised routes, and only the notes that differ from the
  obvious ("unreachable", "different Station", "can't use here"). A route not
  checked carries no note;
- **+ Add route**: opens an address field inline; the route is saved, then
  checked on the next probe;
- **Edit**, on the section header, shown only when a route can be removed;
  reveals **Remove** on routes the user added. Advertised routes have no
  remove: the Station would report them again. The last remaining route cannot
  be removed.

## Phases

1. **Browser-saved Stations** (this change): the discovery route, the merge,
   per-route status, the Routes UI, add and remove. Failover is real for
   browser-saved Stations: the coordinator already walks every route.
   Native alternate admission is the bounded phase 2 slice below, not evidence
   of qualified failover. A browser sign-in kept as a cookie (`device-session`)
   belongs to one origin, so on other routes it reads as a sign-in failure.
   Browser-saved bearer connections retain the existing route-selection policy:
   advertised routes are merged from the authenticated Station when its reported
   `environmentId` matches, and candidate handshakes compare that public ID.
   This is not cryptographic proof of candidate ownership and does not use the
   native host's authenticated-publication-plus-nonce admission below. A route
   may still fail transport, browser policy or authentication checks.
2. **Native profiles** (in progress): preserve the canonical endpoint and add
   temporary host-authorized HTTPS alternates through authenticated anchor
   publication plus fresh proof comparison. A matching public identity alone
   never widens credential authority. CLI route parity is not established by
   this slice. Needs device evidence per
   [native shell verification](../guides/native-shell-verification.md).
3. **Relay as a route**: fold a relay route into the same saved Station by
   `environmentId`, ranked last, instead of a separate connection. This
   changes the [broker design](connection-broker.md), which today promises no
   automatic failover to the relay.

## Not changing

- Pairing and credential permissions do not change. Browser-saved connections
  retain their existing public-identity route checks, not the stronger native
  admission boundary. Native credentials remain bound to the canonical anchor
  except for the host-authorized HTTPS alternates described above.
- Nearby discovery (mDNS) does not establish identity or merge routes into a
  saved Station. The optional HTTPS app-origin hint below changes only the
  address offered for connection; Request Access and the handshake still own
  pairing and identity verification.

## Dynamic HTTPS publications preview

The separate Station-wide **Dynamic HTTPS routes** preview
(`dynamic-route-publications`) is **off by default**. Enable it under
Settings → Advanced → Feature previews; it does not replace the device
**Station routes** preview. The runtime-owned
[RoutePublications](../../src-server/services/connections/route-publications.ts)
uses existing Tailscale Serve mappings, refreshed from host state, to distinguish:

- **App origins**, mapped to this Station's app/API listeners, for connections.
- **Approval origin**, mapped to the separate consent listener, for approval
  pages and passkey ceremonies; it is not an app connection route.

The local operator can persist `trustedConsentOrigin` through **Approval HTTPS
origin** in the Routes settings, without restarting. An absent persisted setting
uses the legacy `STATION_TRUSTED_CONSENT_ORIGIN` startup value. An explicitly
saved empty value requests automatic discovery instead of that environment
fallback. Automatic selection requires exactly one separate approval mapping
with the same hostname as a discovered app origin; missing or ambiguous mappings
leave approval HTTPS unavailable, without guessing or falling back to HTTP.
An origin discovered as an app mapping cannot also be configured for approval.
With the preview off, the legacy environment/HTTP behavior remains in effect.
Saving an origin neither provisions HTTPS nor grants access. See the
[deployment HTTPS guide](../guides/deployment.md#reaching-the-consent-origin-over-https)
for the operator-owned mapping and exact-origin requirements.

When LAN publication is enabled and there is exactly one discovered app origin,
the publisher can include it as DNS-SD TXT `appOrigin`, refreshing it as host
publication changes. Android/iOS discovery retains resolved private-LAN endpoint
validation before preferring a canonical HTTPS DNS hint; an absent or rejected
hint keeps the legacy LAN URL. TXT is untrusted discovery input, never consent
metadata, an identity assertion, a credential grant, or authority to apply
advertised routes to a saved Station.

This boundary does not qualify installed-device multicast, local-network
permissions, TLS, lifecycle, pairing, or route failover. Those require physical
Android/iOS evidence; adapter tests alone do not establish them. Native
credentials remain canonical-origin bound except for the temporary admission
above. Native shell execution and physical-device failover are **NOT_VERIFIED**,
not implied by discovery or adapter coverage.

## Evidence to land each phase

- Phase 1: unit tests for the route model, merge and coordinator results;
  server route test (paired read, refused when unauthenticated, loopback-only
  advertises nothing); a browser render of the Routes list at 390 and 1440 px
  in both themes.
- Phase 2: host tests proving no candidate bearer before anchor authorization
  and proof matching; refusal for unadvertised origins, mismatched proofs,
  redirects, expiry, stale binding/revision, and refresh failure. UI tests must
  prove failover cannot bypass host admission. Real native shell and physical
  Android/iOS journeys must separately establish TLS, lifecycle, and switching;
  until then record those outcomes as **NOT_VERIFIED**.
