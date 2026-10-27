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

The reference is T3 Code's environment screen: one status line, then a
**Routes** list with each address, how it was found, and which one is in use.

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
  native host binds the profile's credential to that exact origin and refuses
  to send it anywhere else; changing the address drops the credential.

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

### Why an advertised route cannot point at another server

Learning a route does not trust it. Every probe of every route still fetches
the public handshake and refuses a different `environmentId` before any
credentialed request is sent. A route that answers as another Station shows as
**Different Station** and is never selected.

## Status

`ConnectionHealthSnapshot` gains `routes`: one entry per route from the last
run, `in-use`, `failed` (with its reason), `blocked` (the page cannot use it,
with its reason) or `not-checked` (a route ranked after the one that answered;
probing it would cost a request per poll for nothing). The Station-level
status line stays as it is: connected, or the failure reason in the existing
copy (`connectionFailureCopy`).

## UI

Inside a saved Station's details in the connection manager (mobile and
desktop):

- the failure reason, once, only when no route answers (the existing copy);
- **Routes**: one row per route with its label and an **In use** badge on the
  route that answered. A quiet line under it holds the address, "found
  automatically" for advertised routes, and only the notes that differ from the
  obvious ("unreachable", "different Station", "can't use here"). A route not
  checked carries no note;
- **+ Add route**: opens an address field inline; the route is saved, then
  checked on the next probe;
- **Edit**: shown only when a route can be removed; reveals remove buttons on
  routes the user added. Advertised routes have no remove: the Station would
  report them again. The last remaining route cannot be removed.

The Station's own address line is hidden while the Routes list is shown, since
the list already carries it.

## Phases

1. **Browser-saved Stations** (this change): the discovery route, the merge,
   per-route status, the Routes UI, add and remove. Failover is real for
   browser-saved Stations: the coordinator already walks every route.
   Native profiles show their one address and the advertised ones, read-only,
   with no failover. A browser sign-in kept as a cookie (`device-session`)
   belongs to one origin, so on other routes it reads as a sign-in failure; a
   saved credential works on every verified route.
2. **Native profiles**: `StationProfile.routes` (a list of origins). The native
   host binds the credential to the profile's `environmentId` instead of one
   origin, and sends it to a route only after that route's handshake answers
   with the same `environmentId` (the same rule as phase 1, enforced in Rust).
   The CLI reads the same list. Needs device evidence per
   [native shell verification](../guides/native-shell-verification.md).
3. **Relay as a route**: fold a relay route into the same saved Station by
   `environmentId`, ranked last, instead of a separate connection. This
   changes the [broker design](connection-broker.md), which today promises no
   automatic failover to the relay.

## Not changing

- Pairing, credentials and trust: a route never widens what a credential may
  do or where it may be sent beyond a verified same-Station address.
- Nearby discovery (mDNS): unchanged. Phase 1 does not need it; a later change
  can add the `environmentId` to its record so an unpaired device can match a
  nearby Station to a saved one.

## Evidence to land each phase

- Phase 1: unit tests for the route model, merge and coordinator results;
  server route test (paired read, refused when unauthenticated, loopback-only
  advertises nothing); a browser render of the Routes list at 390 and 1440 px
  in both themes.
- Phase 2: Rust tests that the credential is never sent to a route before its
  handshake matches, and a physical device switching between LAN and Tailscale.
