# Agent Plugins contract

This document defines Station's Agent Plugins authoring contract and retained
compatibility boundary. The source consumes recognized Agent Plugins 1.0
packages for portable Skills and MCP and normalizes validated Station namespace
declarations through existing host contribution owners. Legacy Station manifests
remain accepted. This does not claim that legacy fallback has been removed or
that every feature in this source checkpoint is already released.

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
resolves those assets relative to the source/bundled server module rather than
the caller's working directory, caches the immutable compiled validators, and
does not fetch schemas during load. Portable Skills are served read-only from
immediate `skills/*/SKILL.md` children with `agent-plugin:<name>` provenance,
and a local Project Skill with the same name wins. MCP servers are projected
from the live package as stable, owner-qualified Station ToolDefs rather than
copied into `integrations/`; installing one makes it available but does not
attach it to an Agent. Probes return ephemeral health for these read-only
definitions. Definition mutations such as enablement, tool filtering, OAuth
health, edits, or deletion are refused until Station has an owner-bound overlay
store; they never materialize a shadow integration that could outlive or mask
the package.

The loader supports stdio and Streamable HTTP. It reports and skips SSE,
invalid Skills, and invalid individual server entries at their narrow failure
boundaries. Stdio children receive persistent per-plugin `PLUGIN_DATA`, exact
`PLUGIN_ROOT`, the plugin root as default cwd, and single-pass expansion of
only those two placeholders. Code updates select a retained materialization
while preserving the same independently scoped data directory. Removal
withdraws future contributions and retains code/data; it does not claim that
unmanaged descendants or remote work have ended. The separate
[installation lifecycle](../design/plugin-installation-lifecycle.md) defines
expected-revision publication, explicit reset, and reclamation limits.

Recognized Agent Plugins take this path during directory or git installation.
The old manifest parser remains only as an explicit compatibility fallback for
packages without an Agent Plugins `$schema`. Removing that fallback and
migrating the remaining legacy examples are separate completion requirements. Validated Station namespace declarations now use the existing host contribution
owners. Their durable activation and retained recovery are described in the
[installation lifecycle](../design/plugin-installation-lifecycle.md); full
combined qualification remains required before publication.


## Public author builds

The shared `parseAgentPluginManifest` implementation performs manifest-only
validation without deriving a Station home, provisioning data, loading package
modules, or fetching schemas. Server loading and author builds share that parser.
`buildPlugin` and `station plugin build` use only validated Station namespace
build fields. An unknown root `entrypoint` does not become build authority.
Invalid known Station namespace data is an authoring error, not an empty success.

Runtime compatibility preserves the existing warning-and-ignore handling of a
non-object `extensions` container. Author builds refuse that malformed container.
That runtime recovery behavior is not a claim that the malformed document
conforms to the upstream schema. Unknown namespace objects remain opaque.

The standalone validators are generated from the unchanged vendored schemas by
`node scripts/generate-agent-plugin-validators.mjs`. The generated file records
schema hashes and tool versions and includes the bundled Ajv helper's license.
`npm run agent-plugin:validators:gate` reproduces and compares the generated
bytes; scoped pre-push and static verification run that check. Missing or stale
output fails rather than downloading a schema or silently regenerating on use.

The [Portable Author Kit](../../examples/portable-author-kit/README.md) provides
an editable package and source-checkout CLI commands. Build validation is not
installation consent or proof that runtime contributions activated. Installation
still owns acquisition, content review, current permission decisions, and durable
activation. The CLI carries parent and dependency grant revisions from preview.
