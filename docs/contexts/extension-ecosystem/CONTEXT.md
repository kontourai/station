# Extension Ecosystem Context

Extension Ecosystem covers how Station is extended by plugins, registry items, providers, integrations, capabilities, and hosted panels.

## Follow an extension through Station

| Step | Current owner and boundary |
| --- | --- |
| Read the package | [Manifest loader](../../../src-server/services/plugins/plugin-manifest-loader.ts) recognizes legacy and Agent Plugins formats. Portable [component loading](../../../src-server/services/plugins/agent-plugin-loader.ts) isolates Skill/MCP component failures. |
| Review and install | [Install consent](../../../src-server/services/plugins/plugin-install-consent.ts) and [installation service](../../../src-server/services/plugins/plugin-installation-service.ts) bind reviewed bytes, permissions and dependencies. Installed, approved and runtime-ready are separate states. |
| Select executable bytes | [Runtime artifact capture](../../../src-server/services/plugins/plugin-runtime-artifact.ts) requires a ready selected generation and current digest. [Catalog discovery](../../../src-server/services/plugins/plugin-catalog-installation.ts) may show an inert pending declaration. |
| Load a provider or server module | The [provider loader](../../../src-server/providers/plugin-provider-loader.ts) and existing server-module owner enforce their grants and generation fences. Trusted server JavaScript runs in process; this is not an OS sandbox. |
| Change permission or retire | [Grant reconciliation](../../../src-server/services/plugins/plugin-grant-reconciliation.ts) coordinates module, subscription, provider and connection cleanup. A `winding-down` response means work is still owned, not complete. |
| Render an MCP App | [MCPToolUIFrame](../../../src-ui/src/components/mcp-ui/MCPToolUIFrame.tsx) uses a distinct-origin proxy for interactive Apps and mediates their bridge calls. The inner App stays sandboxed without same-origin authority. |

The [module map](../../architecture/module-map.md#packagemcpadmissionjournal)
follows installation custody in detail. Its retained `PluginCompositionModule`
entry describes a separate mechanism with fixture callers; it is not the
production plugin registration or host-action path.

## Language

**Plugin**:
An extension package. Station supports legacy packages and Agent Plugins `1.0`
packages. The latter can supply portable skills/MCP plus Station-specific
contributions under `io.kontourai.station`.
_Avoid_: integration if it contributes more than tools

**Plugin manifest**:
For Agent Plugins `1.0`, the closed portable root is `plugin.json`. Station
declarations live in `extensions["io.kontourai.station"]`; skills and MCP have
their own package locations. The [manifest loader](../../../src-server/services/plugins/plugin-manifest-loader.ts)
recognizes both `legacy` and `agent-plugin-1.0`. Use the
[format reference](../../reference/agent-plugins.md), not the old migration plan,
to choose a package shape.
_Avoid_: package metadata

**Plugin provider**:
A server-side contribution from a plugin into a Station provider registry.
_Avoid_: plugin when only the extension point matters

**Plugin consent tier**:
The review category of requested permissions: passive, active, or trusted.
Unknown permission names default to trusted. A declaration or tier is not a
grant; grant records bind the installed content and current host decision.
_Avoid_: permission string when discussing user trust

**Registry**:
The browse and install surface for agents, skills, integrations, plugins, and panes.
_Avoid_: marketplace when local install semantics matter

**Registry item**:
An installable or installed catalog entry. It may be an agent, skill, integration, plugin, or pane.
_Avoid_: plugin as a catch-all

**Registry lifecycle**:
The state model for draft, installable, installed, disabled, update available, or removed registry items.
These catalog states do not replace a plugin installation's pending/ready
admission state or prove that a renderer/provider is currently usable.
_Avoid_: install status if update/removal matters

**Capability**:
An authored instruction, tool source, or other feature an Agent can use.
Actual delivery depends on the engine's
[capability matrix](../../../packages/contracts/src/engine-capability-matrix.ts)
and the permissions and transport involved.
_Avoid_: feature when assignment semantics matter

**Integration**:
An MCP server or similar tool source. Its availability to an Agent depends on
the selected engine and tool-delivery policy.
_Avoid_: plugin if it only contributes tools

**Tool**:
One callable operation exposed by an integration or station-control.
_Avoid_: integration when referring to a single call

**station-control**:
Station's platform-control integration for agent-visible platform operations.
_Avoid_: admin backdoor

**Platform mutation**:
An agent-visible operation that changes Station, project, plugin, agent, or platform state.
_Avoid_: tool call when governance matters

**MCP server**:
A Model Context Protocol server that exposes tools or resources.
_Avoid_: plugin unless Station installs it as a plugin

**MCP-UI server**:
An MCP server that serves rendered panel resources for hosts.
_Avoid_: Station-only panel

**MCP-UI host**:
A host that renders MCP-UI resources in a contained frame and mediates resource/tool access.
Interactive Apps require the configured different-origin proxy. An opaque-origin
static fallback is not the same interactive bridge. Built-in React panes and
trusted plugin React components have different execution boundaries.
_Avoid_: trusted embed by default

**Host bridge**:
The message channel between an MCP-UI panel and Station for initialization, sizing, resource reads, tool calls, and display-mode requests.
_Avoid_: direct execution

## Relationships

- A plugin can contribute portable Skills/MCP and Station declarations for providers, panes, Agents, settings and knowledge namespaces. Knowledge namespaces configure the existing RAG path; they do not register a `KnowledgeStoreAdapter`. Plugin-contributed record stores remain a [proposal](../../design/plugin-knowledge-store-contributions.md).
- Registry discovery, validated installation, consent, ready artifact selection and runtime activation are separate observations. A visible pending Pane is not permission to fetch its bundle or invoke its server module. Installing or disabling a package does not by itself prove that earlier external effects have ended.
- station-control exposes platform operations through their existing authorization and execution owners. Whether an operation creates a receipt comes from that owner; the presence of a callable tool is not receipt evidence.
- MCP App resource and tool requests go through the host's current occurrence and request authority. Read-only policy blocks ordinary tool calls, `require` delegates approval to the server, and the ordinary prompt policy asks locally. Exact owner-bound read continuations such as Basis have a separate narrow protocol; a frame cannot use that as general tool-call authority.
- Portable package Skills and MCP definitions remain package-owned rather than copied into ordinary editable Skill or integration records. Local Skill mutation and setup import use their own directory locks and durable item receipts; editing those records is not permission to rewrite installed package content.

## Implementation route

Read [plugin authoring](../../guides/plugins.md) for supported contributions.
Trace a package through the [manifest reader](../../../src-server/services/plugins/plugin-manifest-loader.ts),
[portable component loader](../../../src-server/services/plugins/agent-plugin-loader.ts),
[install consent](../../../src-server/services/plugins/plugin-install-consent.ts),
and [provider loader](../../../src-server/providers/plugin-provider-loader.ts).
Installing bytes, granting permission, and publishing a provider are different
operations. Their failure and revocation paths must be reviewed together.

## Flagged Ambiguities

**Plugin versus integration**:
A plugin is a Station extension package. An integration is a tool/resource source, usually MCP.

**Provider**:
Use a documented plugin provider seam (for example Model, notification,
embedding, or vector database) when possible. `ISchedulerProvider` is a
server-internal composition interface today, not a plugin registration seam;
scheduled work is created and managed through the authenticated scheduler
HTTP/SDK projection.
