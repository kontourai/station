---
status: current
subject: A Station trusts its own daemon-attested Tailscale Serve HTTPS origin without ALLOWED_ORIGINS
decided: 2026-11-04
evidence:
  - kind: doc
    ref: docs/security/remote-access-threat-model.md
  - kind: doc
    ref: docs/guides/connections.md
  - kind: doc
    ref: src-server/services/tailscale/public-ingress-origin.ts
  - kind: doc
    ref: src-server/runtime/routes/__tests__/runtime-routes-tailscale-serve-origin.test.ts
  - kind: doc
    ref: src-server/runtime/bootstrap/__tests__/runtime-origin-admission-freshness.test.ts
  - kind: doc
    ref: src-server/routes/operations/__tests__/voice-tailscale-serve-origin.test.ts
---

# A Station trusts its own Tailscale Serve origin

## Decision

Station has one browser-origin policy, `StationOriginPolicy`
(`src-server/security/station-browser-origins.ts`), with two sources: the exact
configured origins (`ALLOWED_ORIGINS`, `--allowed-origin`, loopback, and the
native shells), checked first, plus the exact HTTPS origin that the local
Tailscale daemon publishes as serving only this Station
(`PublicIngressOriginResolver.isOwnedOrigin`). Both runtime origin gates, the
pairing provenance check, the credential-free WebSocket verifier and the
sign-in origin picker read it. It adds no setting.

Ownership is an admission, so it does not ride the endpoint-suggestion
resolver's 30-second cache. It reads the daemon through its own single-flight
lookup. An answer is trusted for at most 1 second, counted from when the
lookup started, not from when the reply arrived. A reply that arrives after
that second admits nothing, and a lookup that fails or takes more than 3
seconds refuses. Re-reading on every admission was rejected
because the UI sends `Origin` on every POST, which would mean two process
spawns per API call. The 1-second answer coalesces a burst into one read, and
sharing the origin or turning Funnel on stops admission within about a second.

An origin qualifies only when all of these hold:

- it is on this node's own MagicDNS name;
- every Serve handler on it proxies over HTTP to this Station's API or UI-proxy
  loopback port;
- Funnel is off for it;
- no foreground `serve` session or raw TCP forward can replace it.

Plain-HTTP spellings, other hosts, other ports, and shared origins are refused
unless they are explicitly listed. Only a canonical HTTPS Origin on a MagicDNS
name triggers a daemon lookup.

## Why

Peer enrollment presents the receiver's own address as `Origin`. A Station
published through Serve (for example, a desktop sidecar on `127.0.0.1:38141`
published at its MagicDNS name on HTTPS port 3773) refused every enrollment with
`origin_forbidden`. The cause was the runtime route-classification gate, which
compared the origin only with the static list. The pairing check's same-origin
fallback cannot help, because Serve terminates TLS and the API sees plain HTTP.
The desktop app has no setting for `ALLOWED_ORIGINS`.

Dropping `Origin` from server-to-server enrollment was rejected. The pairing
check requires an `Origin` because browsers always send one on these POSTs, and
that requirement would still refuse the request. It would also leave browsers
and the CLI `--tailscale` preflight at the same published origin refused. The
daemon's statement that it serves nothing but this Station at the origin is the
same fact an operator asserts by listing it. It is never derived from
forwarding headers or Host, and it grants no authentication or approval.
