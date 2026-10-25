# Outside-agent OAuth endpoints (R3, inert)

R3 of [the reviewed design](../design/outside-agent-mcp.md#11-pr-sized-implementation-slices-and-documentation-owners)
adds an isolated OAuth server composition. The compiled release guard still
returns 404 before runtime admission for this entire feature. There is no
runtime enable flag, `/mcp` transport, or supported operator setup yet. R6 owns
enabling exposure after the remaining slices and real end-to-end evidence.

The [protocol owner](../../src-server/routes/outside-agent/oauth-routes.ts)
composes the [private store](../../src-server/services/outside-agent/oauth-store.ts)
and the [shared management service](../../src-server/services/outside-agent/management-service.ts).
Host/passkey approval records intent. Only a successful code exchange activates
a grant and selected supersessions; waiting, approval or an unredeemed code
disconnects nothing. Read-only remains the only selection.

`O` is one exact configured canonical origin, persisted with the store's Station
identity. `R` is exactly `O + /mcp`. Issuer changes require an explicit credential
reset; this composition refuses to silently reopen a store under another issuer.

| Method and literal path on O | Contract |
| --- | --- |
| GET `/.well-known/oauth-protected-resource/mcp` | RFC 9728 resource R, authorization server O, supported scopes and header bearer method |
| GET `/.well-known/oauth-protected-resource` | Same resource document |
| GET `/.well-known/oauth-authorization-server` | RFC 8414 metadata: code, S256, public DCR, strict refresh and issuer response identification |
| POST `/oauth/register` | At most 16 KiB JSON; immutable public-client registration, no secret; bounded metadata is never fetched |
| GET `/oauth/authorize` | One exact R, code response, registered redirect, bounded state/scopes, 43-character S256 challenge; creates a ten-minute pending request |
| GET `/oauth/authorize/status` | Browser ticket plus bound request ID and same-origin Fetch Metadata; long-poll, no idle renewal or inventory |
| POST `/oauth/authorize/complete` | Same ticket, one-use nonce, exact O Origin and same-origin Fetch Metadata; automatic 303 after approval/denial, unchanged state and `iss=O` |
| POST `/oauth/token` | Form body; code, client, actual redirect, verifier and exact R, or refresh/client/R; no cookie/operator/bearer substitution |
| OPTIONS `/oauth/register`, `/oauth/token` | Exact operator-allowlisted browser Origin, POST and Content-Type only |

Unknown/retired client IDs display local logout/re-login recovery instructions
and never redirect. HTTPS callbacks require the separate redirect-origin
allowlist and display a remote-site warning. Literal-IP HTTP loopback callbacks
may vary only their port at authorization; the actual URI is fixed for approval,
completion and exchange. `localhost` callbacks retain their registered port.
Callback paths at `/oauth` or below `/oauth/` are refused, including encoded
spellings, so another loopback port cannot receive the browser ticket.

A browser ticket is HttpOnly, host-only, SameSite=Strict and scoped to
`/oauth/authorize`; HTTPS adds Secure. Up to five requests share a ticket, each
with a separate nonce. Only the same ticket/client/exact actual redirect replaces
an older pending request. Pure pending replacements do not add audit events;
replacing a host-approved or coded request still does. The wait page uses an origin-only referrer policy so
the browser's form POST carries O rather than `Origin: null`; OAuth query values
are never included in the referrer. The 30-minute ticket cap never cuts short a new
request's ten-minute TTL plus its code's 60 seconds. A ticket is renewed only
when no pending/code binding would be lost. Raw OAuth state stays in process
memory; restart requires fresh flows.

Codes are single use. Correctly bound code reuse revokes the issued family and
grant. Access lasts 60 minutes, capped by grant expiry. Refresh rotates once;
any correctly bound consumed-token reuse revokes the family **and grant**, even
when issuance is rate limited. Unknown/misbound probes cannot revoke another
grant. Seven-day idle expiry ends the family and grant. Less than five minutes
before grant expiry, issuance returns `invalid_grant` with new-login guidance,
without consuming a current refresh token. Token responses are never cached.
Lost refresh responses require a fresh login and operator approval.

The [ingress policy](../../src-server/security/outside-agent-ingress.ts) requires
an exact raw Host and real socket identity. HTTP is explicitly opted-in literal
loopback compatibility mode, with every request refusing proxy/internal,
forwarding and Tailscale headers, duplicate/missing Host and every peer except
normalized `127.0.0.1`/`::1`. A `localhost` issuer Host names the exact configured
R in a refusal. HTTP default port 80 must be omitted from Host. This mode does
not claim the MCP profile's HTTPS conformance. Raw TCP forwarding remains an
operator-chosen residual, and cookies are not port-isolated.

The [Serve check](../../src-server/services/tailscale/public-ingress-origin.ts)
inspects every HTTP subpath, TCP forward and foreground configuration at startup
and every 30 seconds. A mapping or installed-but-unverifiable status suspends
HTTP routes and wakes outstanding waits into refusal. An absent `tailscale`
executable means no Serve mapping and allows loopback HTTP. On macOS, an
installed but stopped Tailscale app makes status unverifiable and refuses
loopback HTTP startup. A sweep failure also suspends routes; recovery needs both
a successful sweep and a clear Serve result. A future/unrecognized forwarding schema refuses. Trusted HTTPS ingress
must supply its own authenticated, stripping/replacing path; header claims alone
never establish identity. Hosted configuration is refused.

Durable bounded token buckets cover global/client/verified-peer/family budgets;
daily registration quotas survive restart. Anonymous DCR through ingress without
verifiable peer identity uses the global ceiling and hard storage bounds.
Global and verified-peer budgets run before client, family or CORS-policy
reads. Each budget charge checks every supplied key before spending any tokens,
in the same write transaction. A peer refusal spends no global tokens; refused
charges allocate no keys and leave existing buckets unchanged. A full 4,096-row
limiter table evicts its oldest supplementary row, preserving global quota
counters. Limiter keys never come from unregistered supplied client IDs or
unverified identity headers. Bound token replay checks still run after budget
refusal to revoke compromised credentials. Limits return 429 with Retry-After. Store TTL/capacity/tombstone
and audit limits remain enforced at allocation. The 30-second tick owns history
and delivered-audit pruning; request admission checks bounded live expiry, and
status reads check their own row without a full sweep. A transactional audit
counter keeps allocation independent of retained event count.

Audit health reports `audit_pressure` at 80% of its 100,000-event ceiling and
`audit_capacity` at saturation. Undelivered events are retained even past 90
days: R5 has not wired delivery yet, so sustained new flows can still saturate
the store. Pure same-ticket pending replacements do not consume this ceiling.
At saturation, new OAuth state refuses while security settlement remains
permitted; the warning is an operator diagnostic, not a delivered notification.

Both production and development UI proxies exclude `/oauth`, `/mcp` and the
outside well-known paths, including encoded spellings, before the broad
`/.well-known` match or mutation fallback. Other Station discovery still proxies.
Routes have literal paths and exact method-specific capability declarations;
no `/oauth/*` or `/mcp/*` public exemption is added.

[HTTP boundary tests](../../src-server/routes/outside-agent/__tests__/oauth-routes.test.ts),
[store lifecycle tests](../../src-server/services/outside-agent/__tests__/oauth-store.test.ts),
[Serve checks](../../src-server/services/tailscale/__tests__/public-ingress-origin.test.ts)
and [production UI proxy transport tests](../../packages/cli/src/__tests__/lifecycle.test.ts)
and [Vite proxy transport tests](../../src-ui/src/__tests__/vite-dev-proxy.test.ts)
own focused evidence. These tests do not qualify R4 transport, hosted clients,
release exposure or the later Connections UI. The future runnable personal-Station
setup belongs to R6; these inert endpoints are not an end-user integration example.
