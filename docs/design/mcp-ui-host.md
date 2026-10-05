# MCP Apps in Station

> **Reading status: current host design with staged custody history.**
> [MCPService](../../src-server/services/plugins/mcp-service.ts), the
> [browser frame](../../src-ui/src/components/mcp-ui/MCPToolUIFrame.tsx), and
> [tool-call route](../../src-server/routes/agents/tools.ts) own the live path.
> The local custody and package-admission sections describe different layers;
> neither SDK cleanup nor passing host tests proves remote effects stopped.
> The verification list names evidence areas; it is not a new browser,
> native-device, or external-server qualification.

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

This local custody layer originated as the first tranche of #1409. SDK close fulfillment does **not**
prove that a stdio process, SDK-internal negotiation child, descendant process,
or remote effect has drained. This owner is neither a shared-home lease nor a
package/installation-generation retirement authority. External file edits and
another runtime are not made atomic by its JavaScript fences. The
[installation lifecycle](plugin-installation-lifecycle.md) now composes managed
package admission and retains old code/data on update or withdrawal. It does
not turn local cleanup into permission for physical reclamation.

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

The [Agent Plugin loader](../../src-server/services/plugins/agent-plugin-loader.ts)
now binds selected package definitions to journal admission, and
[local custody](../../packages/shared/src/mcp-local-custody.ts) crosses the
captured effect boundary before constructing/connecting the SDK handle.
The installation owner withdraws admission while retaining managed code and
data. Legacy plugin lifecycle remains a separate path; this is not universal
physical-retirement coverage. No declaration absence or inert test receipt
authorizes destructive work. Real two-process SQLite tests
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

## MCP client feature support

This is the compatibility record for Station as an MCP client (#3284, part of
#3274). Station targets MCP core `2026-07-28` through
`@modelcontextprotocol/client` 2.0.0 and falls back to the 2025-era
`initialize` handshake for deployed legacy servers.

| Feature | Supported subset | Not supported |
| --- | --- | --- |
| Tools | Listing, calls, structured results; MCP Apps metadata | — |
| MCP Apps extension `2026-01-26` | Declared; see the sections below | — |
| Prompts | `prompts/list` and `prompts/get` for servers in an agent's tool view, offered as `/<server>:<prompt>` slash commands with named string arguments ([commands guide](../guides/commands.md)). Inserted content: text, and embedded resources that carry text | Image, audio, blob and resource-link prompt content is refused, not dropped; `prompts/list_changed` is not followed (the list is re-read when the command menu refreshes) |
| Elicitation | Capability `elicitation: { form: {} }`. Form mode only, on both eras: a 2025-era server's `elicitation/create` request and a 2026-07-28 `input_required` result reach the same handler. Rendered for the person the Station-agent turn runs for; accept with content validated against the requested schema, decline, or cancel | URL mode (not declared, so the SDK refuses it); an elicitation is answered only when exactly one request is in flight on the connection and it is a Station-agent turn's tool call; with no such call, or with any other request in flight on the same pooled connection (another tool call, an MCP Apps call, a prompt or resource read), it is refused with an error rather than shown to someone who may not own it; Strands-engine turns |
| Resources | `ui://` App resource reads only | General listing, reading and subscription (#3284, later slice) |
| Sampling | — | Not declared; a server's sampling request is refused (#3284, later slice) |
| Roots | — | Not declared |

### Elicitation path

A server's form arrives on the connection's `elicitation/create` handler,
which hands it to the one Station turn whose tool call is in flight on that
connection. That turn's elicitation bridge normalizes the schema
(`@kontourai/station-shared/mcp-elicitation`), refusing any property type or
bound it cannot render, and injects the form into the turn's `/chat` stream.
The Station-agent adapter publishes it as the thread's `request.opened`
(payload `mcpElicitation`), and the pending-requests strip renders the form.
The answer returns through the orchestration `respondToRequest` command,
pinned to the exact opened event; the service validates accepted content
against that form and refuses invalid content with a reason, and the bridge
re-checks it before the server sees it. Nothing is coerced or truncated.

Truthfulness rules: `accept` only with content the person entered; `decline`
only when they declined; a timeout (10 minutes, or the server's own request
timeout), a stopped turn, a server cancellation or a stopped session all
return `cancel`. A form that cannot be rendered, or a hosted turn with no
bound session, is an error to the server, never a fabricated answer. The
agent audience rule for member-facing turns named in #3284 has no runtime
concept to bind to yet and is not implemented.

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
both forms carry string values, the nested value wins.

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

The browser host supplies `approvalPolicy` in its request. The route does not
independently recover that value from a stored layout: `read-only` refuses,
`require` waits when the approval registry is wired, and the other path calls
the tool directly. The `inherit` confirmation is a browser-host step. These
rules describe that host composition, not proof that an arbitrary authenticated
API caller obtained an operator decision.

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

Station ignores tool-level `csp` and `permissions`. Policy construction filters
source strings by secure URL scheme: HTTPS for resource, frame and base-URI
sources, and HTTPS or WSS for connections. It emits restrictive defaults plus
the declared sources. Scheme filtering is not a complete CSP source-expression
validator or proof of effective browser egress containment. Keep that assurance
separate from metadata acceptance. Permissions are limited to the supported
Apps fields.

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
   parsed resource policy.
5. The proxy creates an inner opaque-origin frame with `sandbox="allow-scripts"`
   and injects the resource's deny-by-default CSP.
6. The proxy forwards non-reserved Apps bridge messages between Station and the
   inner View.

The MCP proxy endpoint serves `GET /mcp-ui/proxy`; the same dedicated listener
also serves the fixed `/plugin-host/frame` bootstrap. Neither is a general
asset server. The MCP proxy does not receive the resource URI, read resources,
proxy arbitrary URLs, store credentials, or execute tools.
The outer proxy response applies only a `frame-ancestors` CSP, bound to the
configured Station UI origins. It deliberately applies no resource directives
that could be inherited by its inner `srcdoc`; the resource-specific CSP is
applied inside the inner document.

The two-frame boundary prevents untrusted app code from becoming the proxy
WindowProxy that Station trusts. Messages are also pinned to the expected
window source. The inner frame receives no same-origin access, top-level
navigation, popup or modal permissions. Network restrictions retain the policy
validation limits described above.

If the proxy cannot start or its origin is not distinct from Station, the host
degrades to an opaque-origin static `srcdoc` render. It never grants
`allow-scripts` plus `allow-same-origin` to untrusted content on Station's own
origin.

## Host bridge

Station uses `@modelcontextprotocol/ext-apps` for the Apps JSON-RPC bridge. The
host supports the initialize lifecycle, tool input and result notifications,
size changes, display-mode requests, resource reads, and guarded tool calls.

All App requests cross the same server-side authorization boundary as other
Station actions. The host bridge does not expose its configured provider
credentials or direct MCP transport to the App.

## Threat controls

| Threat | Control |
| --- | --- |
| App reaches Station DOM, cookies, or storage | Different-origin proxy plus an opaque inner frame |
| App impersonates the trusted proxy | Inner frame has a distinct `WindowProxy`; source checks pin messages |
| Network exfiltration | Resource-specific CSP; effective restrictions require source-expression and browser validation |
| Camera, microphone, location, or clipboard access | Allow only validated declared permissions |
| Cross-server tool calls | Re-resolve the frame reference and pin `serverId` |
| Model-only tool called by an App | Enforce Apps visibility on the server |
| App requests a write through the host bridge | Apply the configured host approval path; the request policy is not independent proof of consent |
| Arbitrary resource read | Read only the resolved tool's declared URI |
| Huge or hanging content | Byte caps, request timeouts, and render bounds |

## Runtime surface

Tool, integration and configuration routes below are relative to Station's API
base. The proxy route belongs to its separate frame origin.

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
