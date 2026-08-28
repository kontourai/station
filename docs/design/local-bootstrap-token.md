# Local-bootstrap token (archive#1991)

## Problem

`station` (with no verb, in a TTY) opens a running Station in the browser. For
that page to be a *paired device* rather than merely riding the loopback
compatibility floor, it needs a credential. Station already has a same-user
self-authorization path — the **local-grant** route
(`/.well-known/station/v1/pairing/local-grant`), which exchanges the per-boot,
owner-only secret file (`<home>/runtime/local-grant.secret`) for a normal
paired credential when called directly on loopback.

But that secret is **boot-lifetime and reusable**. Handing it to a browser
through a URL fragment — the only channel the CLI opener has to the page it just
launched — would plant a standing credential in the address bar, history, and
any `Referer`. So the opener cannot forward the secret itself.

## Design

The existing UI-bootstrap exchange remains the only browser endpoint. A direct
loopback mint route refreshes its one current server-held capability.

### MINT — `POST …/pairing/mint-ui-bootstrap` (CLI → server)

- **Auth: identical to local-grant.** Requires possession of the secret file
  **and** `isDirectLoopbackCaller` — a loopback direct socket, no ingress
  identity, and none of the UI proxy's internal headers. A request that
  transited the proxy, a Tailscale Serve tunnel, or any forwarded hop is
  refused with the same `local_grant_forbidden` code a wrong secret gets, so a
  network position can never stand in for filesystem possession.
- **Effect:** generates a `randomBytes(32).base64url` token, replaces the
  server's single current UI-bootstrap capability, and returns `{ token, path
  }`. A later mint invalidates an unspent prior token. It does **not** itself
  mint a pairing credential.

### EXCHANGE — `POST …/pairing/ui-bootstrap` (browser → server)

- **Auth: the token is the sole proof.** This call reaches the backend *through*
  the UI proxy, so `isDirectLoopbackCaller` is intentionally false and no secret
  is presented — mirroring how the answer-share view is credentialed by a body
  token rather than a pairing credential. Listed in `PUBLIC_ROUTES` so it is
  reachable without a pre-existing credential, exactly like the normal pairing
  exchange.
- **One-time:** the token is validated against the one current value and spent
  after successful pairing issuance. A replay or a token invalidated by a later
  mint is refused. It runs the `createOffer → requestPairing →
  confirmRequest({kind:'ui-bootstrap'}) → exchange` ceremony and delivers the
  credential as an **HttpOnly device-session cookie** (trusted-origin gated),
  so the page never has to hold a bearer.

### CLI opener → browser

1. Resolve the running instance (registry + `GET /api/system/instance` probe).
2. Read `<home>/runtime/local-grant.secret` and `POST …/mint-ui-bootstrap`
   directly on loopback → receive the one-time token.
3. Open `http://localhost:<ui-port>#station-ui-bootstrap=<token>`.

### Browser (`src-ui/src/lib/local-ui-bootstrap.ts`)

On boot, before the auth tree mounts: read `station-ui-bootstrap` from the fragment,
**strip the fragment synchronously** (`history.replaceState`, before the network
round-trip and before anything can log `window.location`), then `POST
…/ui-bootstrap`. Success sets the device-session cookie; failure or no-token is
an ordinary boot.

## Threat model

- **What it defends:** the boundary around the secret file (0600, owner-only,
  per-boot) and the requirement that the *mint* caller reach the process
  directly on loopback. The token that crosses to the browser is single-use;
  only the server's most recently minted value is exchangeable.
- **No peer-address trust.** Neither half trusts a claimed peer address; the
  mint trusts filesystem possession + direct loopback, the exchange trusts the
  one-time token. Slice A's removal of peer-address trust is preserved.
- **What it deliberately does not defend:** a same-user malicious process. That
  adversary already has arbitrary access to everything this grants — reading the
  secret file, driving the routes, or minting its own checkout. The token adds
  no new privilege; it mechanizes an existing one into a normal paired
  credential.
- **Proxied / remote callers** never reach the mint (not direct loopback) and
  never possess a token they did not mint, so the manual-approval pairing path
  is unaffected.
