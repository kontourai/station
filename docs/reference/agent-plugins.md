# Agent Plugins contract

Station targets the published **Agent Plugins 1.0.0** contract. The upstream
1.1.0 document is a working draft and is not a supported package version until
it is published and Station explicitly recognizes it. Runtime loading must use
vendored schemas; it must never fetch schemas while loading a plugin.

Portable package data remains in the closed root `plugin.json` shape. Station
implements one client extension namespace, `io.kontourai.station`, for both the
manifest entry and optional top-level extension directory. Other namespaces
remain opaque and are ignored without validation.

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
| `capabilities`, `links`, `agents`, `workspacePanes` | same key under the Station namespace | Station host |
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

Station uses the Agent Plugins 1.0 name alphabet at storage boundaries:
1–64 lowercase ASCII letters, digits, hyphens, or periods; alphanumeric first
and last characters; no `--` or `..`. There is no second Station-only plugin ID
grammar.

## Secret boundary

`secretReferences` declares slots only. Secret values remain in Station's
secret authority and are injected through a mediated capability. They are
never written into `plugin.json`, `mcp.json` `env`, or MCP HTTP headers.
