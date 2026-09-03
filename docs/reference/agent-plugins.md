# Agent Plugins contract

This document defines Station's **target v1 authoring contract**. The current
runtime now consumes recognized Agent Plugins 1.0 packages for portable Skills
and MCP while still accepting the legacy Station manifest until #346 and #348
land. This document must not be read as a claim that the released tree has
removed its legacy fallback or activates every Station extension contribution.

Station targets the published **Agent Plugins 1.0.0** contract. The upstream
1.1.0 document is a working draft and is not a supported package version until
it is published and Station explicitly recognizes it. Runtime loading must use
vendored schemas; it must never fetch schemas while loading a plugin.

Portable package data remains in the closed root `plugin.json` shape. Station
reserves one client extension namespace, `io.kontourai.station`, for both the
manifest entry and a future optional top-level extension directory. Runtime
discovery now exposes that directory only after filesystem containment succeeds;
later namespace-owned features decide its contents. Other namespaces remain
opaque and are ignored without validation.

## Field classification

| Legacy Station field | Agent Plugins 1.0 destination | Classification |
| --- | --- | --- |
| `name`, `version`, `description` | same root field | portable core |
| `$schema`, `author`, `homepage`, `repository`, `license`, `keywords` | same root field | portable core |
| `permissions` | `extensions["io.kontourai.station"].permissions` | generic candidate |
| non-secret `settings` | `extensions["io.kontourai.station"].settings` | generic candidate |
| secret `settings` / `secretEnv` | `extensions["io.kontourai.station"].secretReferences` | generic candidate; references only |
| `dependencies[].id` | `extensions["io.kontourai.station"].dependencies[].name` | generic candidate |
| `dependencies[].source` | none | dropped; dependency sources are not package authority |
| `displayName` | `extensions["io.kontourai.station"].title` | Station host |
| `sdkVersion`, `entrypoint`, `serverModule`, `build` | same key under the Station namespace | Station host |
| `capabilities`, `commands`, `links`, `agents`, `workspacePanes` | same key under the Station namespace | Station host |
| `operationalEventSubscriptions`, `providers`, `integrations`, `tools`, `knowledge`, `prompts` | same key under the Station namespace | Station host |
| inline `skills` | fixed `skills/<name>/SKILL.md` discovery | dropped |
| inline MCP/integration configuration | fixed root `mcp.json` | dropped |
| `layout`, `layouts`, `providers[].layout` | none | dropped |

The generic-candidate label does not make a field portable in Agent Plugins
1.0. Other clients ignore it. It records names and shapes Station would be
willing to propose upstream without a later rename.

Acquisition URL, resolved revision, content integrity, publisher signatures,
and lifecycle events are host observations—not package self-assertions. They
belong in Station-owned provenance and lifecycle records and are deliberately
absent from the extension manifest schema.

## Namespace schema

The versioned schema for the Station value is
`schemas/agent-plugins/io.kontourai.station-1.0.schema.json`. Its closed root
rejects `layout` and `layouts`; provider entries explicitly reject `layout`.
`workspacePanes` is the only v1 pane declaration key. Existing owning parsers
remain responsible for the complete nested Workspace Pane, provider, event,
knowledge, prompt, and agent contracts.

Invalid Station extension data disables Station-specific contributions; it
must not suppress independently valid portable skills or MCP servers. Unknown
portable root fields and a non-object `extensions` value follow the upstream
non-fatal reporting rules, not Station's extension-schema policy.

## Identity

The v1 target uses the Agent Plugins 1.0 name alphabet at storage boundaries:
1–64 lowercase ASCII letters, digits, hyphens, or periods; alphanumeric first
and last characters; no `--` or `..`. There is no second Station-only plugin ID
grammar. The legacy loader still rejects the otherwise-valid names
`constructor` and `prototype` because older object-keyed stores are not all
hardened; #344/#346 must remove that temporary conformance exception rather
than teaching it as a second identifier grammar.

## Secret boundary

`secretReferences` declares slots only. Secret values remain in Station's
secret authority and are injected through a mediated capability. They are
never written into `plugin.json`, `mcp.json` `env`, or MCP HTTP headers.

## Current consumer behavior

Station selects the vendored 1.0.0 manifest and MCP schemas from `$schema`; it
does not fetch schemas during load. Portable Skills are served read-only from
immediate `skills/*/SKILL.md` children with `agent-plugin:<name>` provenance,
and a local Project Skill with the same name wins. MCP servers are projected
from the live package as stable, owner-qualified Station ToolDefs rather than
copied into `integrations/`; installing one makes it available but does not
attach it to an Agent.

The loader supports stdio and Streamable HTTP. It reports and skips SSE,
invalid Skills, and invalid individual server entries at their narrow failure
boundaries. Stdio children receive persistent per-plugin `PLUGIN_DATA`, exact
`PLUGIN_ROOT`, the plugin root as default cwd, and single-pass expansion of
only those two placeholders. Uninstall removes that plugin's data after the
rest of the uninstall transaction has settled.

Recognized Agent Plugins take this path during directory or git installation.
The old manifest parser remains only as an explicit compatibility fallback for
packages without an Agent Plugins `$schema`; #346 owns deleting it after the
remaining examples move. Station namespace data is schema-validated now, but
activation beyond the already-owned portable Skill/MCP paths remains with the
follow-on host integration work.
