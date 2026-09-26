# Extension Ecosystem Context

Extension Ecosystem covers how Station is extended by plugins, registry items, providers, integrations, capabilities, and hosted panels.

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
The permission tier for a plugin: passive, active, or trusted.
_Avoid_: permission string when discussing user trust

**Registry**:
The browse and install surface for agents, skills, integrations, plugins, and panes.
_Avoid_: marketplace when local install semantics matter

**Registry item**:
An installable or installed catalog entry. It may be an agent, skill, integration, plugin, or pane.
_Avoid_: plugin as a catch-all

**Registry lifecycle**:
The state model for draft, installable, installed, disabled, update available, or removed registry items.
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
_Avoid_: trusted embed by default

**Host bridge**:
The message channel between an MCP-UI panel and Station for initialization, sizing, resource reads, tool calls, and display-mode requests.
_Avoid_: direct execution

## Relationships

- A plugin can contribute portable skills/MCP and Station-owned registry sources, providers, panes, agents, settings, and knowledge namespaces.
- A registry item becomes available before it becomes active in any project, agent, or pane composition.
- station-control exposes platform mutations; governed sessions should turn those mutations into receipts.
- MCP-UI panels are rendered through Station's host, but tools still route through Station-mediated policy and approval.

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
