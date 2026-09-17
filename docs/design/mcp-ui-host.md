# MCP Apps in Station

> Status: native host support is on by default behind the `mcpUiHost` setting.
> Station targets MCP core `2026-07-28` and the independently versioned MCP Apps
> extension `2026-01-26`.

## The user model

People install one MCP integration. Station owns its connection and makes the
integration's tools available to agents and, when declared, its interactive UI
available in the workspace.

There is no protocol-version or UI-dialect selector:

- Station negotiates the newest MCP core protocol first and falls back for
  deployed legacy servers.
- Station prefers current MCP Apps metadata and accepts the older flat resource
  pointer as input compatibility.
- Security policy comes only from resource metadata; Station ignores misplaced
  tool-level `csp` and `permissions`.
- Apps without UI metadata remain ordinary MCP tools.

This compatibility belongs at the external protocol boundary. Station's
internal configuration uses only the canonical `stdio`, `sse`, and
`streamable-http` transport names.

## Connection ownership

`@kontourai/station-shared/mcp` owns the official MCP v2 client and preserves the
raw catalog, resource content, structured tool results, negotiated protocol
version, and server capabilities.

For the default framework, the live Station-owned connection is reused for:

- agent tools, adapted into the agent framework only at the final boundary;
- MCP Apps catalog and resource reads; and
- View-initiated resource and tool requests.

When an installed integration is not attached to an active agent, `MCPService`
uses the same adapter for a short-lived connection. The Strands harness keeps
its existing SDK-specific client; its cleanup capability is retained by the
same runtime-local custody owner, not a second integration registry.
Its SDK client is not reused as an Apps protocol client; an Apps request may
therefore hold a separate transient connection under that same custody owner.

### Local handle custody and its limits

Each runtime holds one `MCPLocalConnectionCustody`. Managed loaders, probes,
transient Apps, OAuth continuations, and tenant-native clients reserve a claim
before asynchronous configuration/secret lookup or SDK connection. The full
prepared client/transport handle is retained before connect and discovery;
constructor partial failure also leaves any already-created transport owned.
Tenant-native publication pools are qualified by the runtime owner.

Reset and explicit integration replacement synchronously fence old claims.
Reset reports `localCleanup` with `scope: local-sdk-handles`, a retained count,
and `settled`, `pending`, or `failed`; maps are cleared only after settlement.
The internal `inspectLocalConnections()` observation contains phases/counts,
not integration names, argv, endpoints, credentials, or underlying errors.
Pending cleanup is joined across retries. A rejected cleanup can be retried
only after that exact attempt settles. Late connection/discovery cannot publish
or make an old facade usable again; a final close follows actual late work.
An unresolved retired claim blocks new admission for that integration.
Other integration identities remain usable during an integration-specific
mutation. The owner bounds retained claims (256 by default) and caller cleanup
waits (one second by default), not the lifetime of the retained cleanup promise.
The runtime injects the same local mutation callback into the existing secret
binding service; binding configuration writes wait for the affected local
handles before committing, without changing the binding grant authority.

OAuth consent is an explicit full-handle handoff: an initial authorization
response does not close the transport needed by `finishAuth`. Exchange remains
under custody, and replacement cannot commit while its old local work remains
outstanding. Stale callbacks cannot return an authorized current projection.
The claim retains the whole completion scope, including bound-state reads and
state removal before SDK `finishAuth`. A closed SDK handle is not sufficient
to prune a pending credential operation. Cleanup runs outside the owned scope
to avoid waiting on itself; local inspection counts these retained operations.

This is only the first local tranche of #1409. SDK close fulfillment does **not**
prove that a stdio process, SDK-internal negotiation child, descendant process,
or remote effect has drained. This owner is neither a shared-home lease nor a
package/installation-generation retirement authority. External file edits and
another runtime are not made atomic by its JavaScript fences. Native child
supervision, shared-home admission, and the exclusive package/data mutation
lease remain required before #1377 can safely update/remove package data.
This change does not authorize or wire destructive package retirement.

### Shared package admission evidence (control-plane prerequisite)

`EventStore.createPackageMcpAdmissionJournal()` composes one package-MCP
metadata owner on its already-open home SQLite handle. It opens no second
database and inherits, rather than strengthens, EventStore's filesystem and
durability boundary. The fixed table stores only host installation observations,
incarnations, purpose/owner claims and retirement requests: no integration
definitions, argv, endpoints, credentials or PLUGIN_DATA contents.

An installation-owner event explicitly supplies the previous incarnation and
content digest; recording a replacement mints a fresh incarnation even for
identical bytes. This is a metadata observation, never permission to mutate
package files. Reservation and retirement serialize in a SQLite transaction.
An effect boundary must commit before SDK construction or external invocation;
lost commit acknowledgement returns unavailable and never permits invocation.
Only the exact returned capability that has not crossed/uncertainly attempted
that boundary can release its no-effect reservation. SDK close settlement is
recorded separately and keeps possible effects retained. There is no TTL,
dead-parent cleanup, PID-only takeover, or arbitrary claim deletion API.

Every inspection has `mutationAllowed: false`, including zero claims and a
homogeneous current process population. `compatibility-unproved` remains until
a boot-understood crash-safe barrier exists; possible native/descendant/remote
effects add `external-effect-unproved`. Neither a package-specific mutex nor a
current runtime roster stops a legacy binary from joining after a crash.
The impact read can prove recorded package history, but an absent record is
`unclassified`, not evidence that a package is unrelated or safe to delete.

This prerequisite is not yet connected to all MCP entry points or package
mutation owners. The Agent-Plugins package/data owner in #1377 is the planned
refusal seam before its first backup/copy/delete; unrelated legacy plugin
lifecycle remains outside this guarantee. No current declaration absence or
inert test receipt authorizes destructive work. Real two-process SQLite tests
prove claim/fence serialization, retained crash debt, incarnation ABA and
unknown-commit refusal, not native containment, remote cancellation or physical
platform compatibility. No home-schema upgrade or operator recovery is run.
In particular, the legacy registry install/uninstall routes still invoke
provider effects and write/delete integration configuration directly. Those
writers belong to the remaining package-retirement work; they are not covered
by this local service-entrypoint guarantee.

Modern servers start with core discovery and automatic negotiation. Existing
servers fall back to the legacy initialize exchange only when the transport
identifies that protocol era. Silence or transport failure remains an outage,
not a legacy signal.

## App metadata

The preferred tool shape is nested:

```jsonc
{
  "name": "get_weather",
  "_meta": {
    "ui": {
      "resourceUri": "ui://weather/dashboard",
      "visibility": ["model", "app"]
    }
  }
}
```

Station also reads `_meta["ui/resourceUri"]` from existing Apps servers. When
both forms exist, the nested value wins.

Visibility is enforced, not merely displayed:

- omitted visibility means both model and app;
- `["model"]` exposes the tool to agents but not an App;
- `["app"]` exposes the tool to Apps but removes it from agent tool catalogs;
- malformed explicit visibility fails closed.

An App may call only an app-visible tool on the same pinned MCP integration.
Station rejects cross-integration calls and model-only tools before execution.
The layout's approval policy remains an additional gate:

- `read-only`: deny App tool calls;
- `require`: route calls through Station's approval inbox;
- `inherit`: require the current host confirmation until agent policy is wired.

## Resource loading and policy

Station resolves the declared `ui://` URI, reads it through the pinned MCP
connection, and returns byte-capped content. The resource content may declare:

```jsonc
{
  "_meta": {
    "ui": {
      "csp": {
        "connectDomains": ["https://api.weather.example"],
        "resourceDomains": ["https://cdn.weather.example"]
      },
      "permissions": { "geolocation": {} }
    }
  }
}
```

Station ignores tool-level `csp` and `permissions`, as required by the Apps
spec. It validates resource domains, admits only HTTPS origins, and builds a
deny-by-default policy. Permissions are limited to the Apps extension's
supported set.

Station retains a bounded `mcp-ui.dev` embedded-result fallback for deployed
servers that put a `ui://` resource in a tool result instead of declaring it.
That fallback runs only for a layout explicitly pinned `read-only`, because
rendering requires calling the tool with fixed empty arguments.

## Browser isolation

The web host follows the Apps sandbox-proxy lifecycle:

1. Station starts a minimal proxy on a different origin. It uses an ephemeral
   loopback port by default; `MCP_UI_FRAME_PORT` may pin a nonzero port.
2. The Station page embeds that proxy with
   `sandbox="allow-scripts allow-same-origin"`.
3. The proxy sends `ui/notifications/sandbox-proxy-ready`.
4. Station sends `ui/notifications/sandbox-resource-ready` with the raw HTML and
   sanitized resource policy.
5. The proxy creates an inner opaque-origin frame with `sandbox="allow-scripts"`
   and injects the resource's deny-by-default CSP.
6. The proxy forwards non-reserved Apps bridge messages between Station and the
   inner View.

The proxy serves only `GET /mcp-ui/proxy`. It does not receive the MCP resource
URI, read resources, proxy arbitrary URLs, store credentials, or execute tools.
The outer proxy response applies only a `frame-ancestors` CSP, bound to the
configured Station UI origins. It deliberately applies no resource directives
that could be inherited by its inner `srcdoc`; the resource-specific CSP is
applied inside the inner document.

The two-frame boundary prevents untrusted app code from becoming the proxy
WindowProxy that Station trusts. Messages are also pinned to the expected
window source. The inner frame receives no same-origin access, navigation,
popups, modals, or undeclared network access.

If the proxy cannot start or its origin is not distinct from Station, the host
degrades to an opaque-origin static `srcdoc` render. It never grants
`allow-scripts` plus `allow-same-origin` to untrusted content on Station's own
origin.

## Host bridge

Station uses `@modelcontextprotocol/ext-apps` for the Apps JSON-RPC bridge. The
host supports the initialize lifecycle, tool input and result notifications,
size changes, display-mode requests, resource reads, and guarded tool calls.

All App requests cross the same server-side authorization boundary as other
Station actions. Browser code never holds provider credentials or a direct MCP
transport.

## Threat controls

| Threat | Control |
| --- | --- |
| App reaches Station DOM, cookies, or storage | Different-origin proxy plus an opaque inner frame |
| App impersonates the trusted proxy | Inner frame has a distinct `WindowProxy`; source checks pin messages |
| Network exfiltration | Resource-specific, deny-by-default CSP |
| Camera, microphone, location, or clipboard access | Allow only validated declared permissions |
| Cross-server tool calls | Re-resolve the frame reference and pin `serverId` |
| Model-only tool called by an App | Enforce Apps visibility on the server |
| Write without approval | Apply the layout approval policy before execution |
| Arbitrary resource read | Read only the resolved tool's declared URI |
| Huge or hanging content | Byte caps, request timeouts, and render bounds |

## Runtime surface

- `GET /tools/mcp-ui/resolve?ref=...`: resolve a tool and its UI pointer.
- `GET /tools/mcp-ui/resource?ref=...`: read its declared resource.
- `POST /integrations/:server/ui/call`: call an allowed, app-visible tool on the
  pinned integration.
- `GET /mcp-ui/proxy`: serve the isolated sandbox proxy.
- `GET /config/app`: expose the runtime-only `mcpUiFrameOrigin`.

`mcpUiFrameOrigin` is never persisted. `mcpUiHost: false` disables rendering but
does not disable ordinary MCP tools.

## Verification

The acceptance lanes cover:

- modern discovery and legacy server negotiation;
- raw metadata and result preservation;
- nested metadata preference and flat-pointer compatibility;
- model/app visibility and cross-integration denial;
- resource-policy precedence;
- sandbox-proxy lifecycle and different-origin rendering;
- a real Apps SDK handshake and resize;
- hostile View containment; and
- a non-mocked MCP Apps server integration.

## Sources

- [MCP core 2026-07-28](https://modelcontextprotocol.io/specification/2026-07-28)
- [MCP Apps extension 2026-01-26](https://github.com/modelcontextprotocol/ext-apps/blob/main/specification/2026-01-26/apps.mdx)
- [MCP Apps repository](https://github.com/modelcontextprotocol/ext-apps)
