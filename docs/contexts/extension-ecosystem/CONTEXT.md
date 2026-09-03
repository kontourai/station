# Extension Ecosystem Context

Extension Ecosystem covers how Station is extended by plugins, registry items, providers, integrations, capabilities, and hosted panels.

## Language

**Plugin**:
Target v1: an Agent Plugins package with portable skills/MCP plus optional Station-owned
Pane, agent, provider, knowledge, setting, and server contributions under
`io.kontourai.station`.
_Avoid_: integration if it contributes more than tools

**Plugin manifest**:
Target v1: the closed portable root `plugin.json`. Station host declarations live only in
`extensions["io.kontourai.station"]`; portable skills and MCP use their fixed
package locations. The current legacy loader has not completed this migration.
_Avoid_: package metadata

**Plugin command contribution**:
A versioned, inert action declared under
`extensions["io.kontourai.station"].commands` and projected by Station into the
host command palette.
_Avoid_: plugin shortcut or plugin callback

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
Something Station can attach to a Station agent: skills, integrations, tools, and commands.
_Avoid_: feature when assignment semantics matter

**Integration**:
An MCP server or similar tool source that exposes tools to Station agents.
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

- A plugin can contribute portable skills/MCP and Station-owned registry sources,
  providers, panes, agents, settings, and knowledge namespaces.
- A Plugin command contribution selects a closed host intent; it does not own
  navigation, shortcuts, validation, rendering, or execution.
- A registry item becomes available before it becomes active in any project,
  agent, or pane composition.
- station-control exposes platform mutations; governed sessions should turn those mutations into receipts.
- MCP-UI panels are rendered through Station's host, but tools still route through Station-mediated policy and approval.

## Flagged Ambiguities

**Plugin versus integration**:
A plugin is a Station extension package. An integration is a tool/resource source, usually MCP.

**Provider**:
Use a documented plugin provider seam (for example Model, notification,
embedding, or vector database) when possible. `ISchedulerProvider` is a
server-internal composition interface today, not a plugin registration seam;
scheduled work is created and managed through the authenticated scheduler
HTTP/SDK projection.

## Plugin command boundary

Station currently executes two argument-free command intents: navigation to an
existing host surface and staging visible text in an already-open chat
composer. Staging never sends model input. Commands that declare an argument or
a plugin operation remain visible but unavailable with an exact reason until
their host-owned argument-entry and audited invocation adapters exist.

Argument-free commands execute only after Station revalidates the exact
installed declaration generation and durably records a content-free admission
receipt. Preview/staging trees never enter installed inventory. Update,
permission-change, and removal events withdraw cached command generations
before a fresh installed projection may replace them.

Command ids are owner-qualified (`<plugin-name>.<command-id>`) and enter the
same final-id collision check as existing host commands. Icons and availability
requirements use closed Station vocabularies;
manifest data cannot contain routes, regular expressions, callbacks, markup, or
shortcut declarations.
