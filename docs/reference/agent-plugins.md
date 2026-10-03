# Agent Plugins contract

This document defines Station's Agent Plugins authoring contract and retained
compatibility boundary. The source consumes recognized Agent Plugins 1.0
packages for portable Skills and MCP and normalizes validated Station namespace
declarations through existing host contribution owners. Legacy Station manifests
remain accepted. This does not claim that legacy fallback has been removed or
that every feature in this source checkpoint is already released.

Station recognizes the **Agent Plugins 1.0.0** schema identifiers recorded in
its [contract constants](../../packages/contracts/src/agent-plugin.ts). The
[vendored schema provenance](../../schemas/agent-plugins/1.0.0/UPSTREAM.md)
records the imported revision. Recognition does not automatically advance when
upstream publishes another version. Loading uses local schemas, without a
schema fetch.

Portable package data remains in the closed root `plugin.json` shape. Station
reserves one client extension namespace, `io.kontourai.station`, for both the
manifest entry and an optional top-level directory. Runtime discovery exposes
the directory only after filesystem containment succeeds; discovery alone does
not execute its contents. Every namespace member must
be an object. Station leaves unknown objects' contents opaque.

```text
my-plugin/
  plugin.json                    # identity and optional Station extension
  mcp.json                       # optional portable MCP definitions
  skills/
    explain-project/SKILL.md     # optional immediate-child Skill
  io.kontourai.station/           # optional contained namespace directory
```

The package's code location and persistent `PLUGIN_DATA` directory are separate.
Updates can select new code while preserving data; a package cannot select its
own installation revision or grant itself permission by declaring a field.

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
| `capabilities`, `commands`, `links`, `agents`, `workspacePanes`, `workspacePaneHost` | same key under the Station namespace | Station host |
| `operationalEventSubscriptions`, `providers`, `integrations`, `tools`, `knowledge`, `prompts` | same key under the Station namespace | Station host |
| inline `skills` | fixed `skills/<name>/SKILL.md` discovery | dropped |
| inline MCP/integration configuration | fixed root `mcp.json` | dropped |
| `layout`, `layouts`, `providers[].layout` | none | dropped |

The generic-candidate label does not make a field portable in Agent Plugins
1.0. It is a classification for possible upstream proposals; the portable
schema gives another client no Station-specific behavior for those fields.

Acquisition URL, resolved revision, content integrity, publisher signatures,
and lifecycle events are host observations—not package self-assertions. They
belong in Station-owned provenance and lifecycle records and are deliberately
absent from the extension manifest schema.

## Namespace schema

The optional `experiences` contribution references bounded JSON author
definitions in `io.kontourai.station/experiences/`. See the
[visual skill experience contract](skill-experiences.md) for source binding,
author validation, installed inventory, and compatibility limits. Admitted
packages can contribute inert definitions through the Skill inventory API;
this does not start a session or render a visual workflow.

The versioned schema for the Station value is
`schemas/agent-plugins/io.kontourai.station-1.0.schema.json`. Its closed root
rejects `layout` and `layouts`; provider entries explicitly reject `layout`.
`workspacePanes` is the only v1 pane declaration key. Existing owning parsers
remain responsible for the complete nested Workspace Pane, provider, event,
knowledge, prompt, and agent contracts.

An object-valued Station extension that fails its schema disables only
Station-specific contributions; independently valid portable Skills and MCP
servers can still load. A non-object namespace member, including an unknown
namespace or the Station namespace, is a fatal manifest error in the
[shared parser](../../packages/shared/src/agent-plugin-manifest.ts). This is
different from the runtime's warning-and-ignore handling of a non-object
`extensions` container. Unknown portable root fields are reported and ignored,
except the explicitly retired root fields `layout` and `layouts`, which are
fatal. A namespace that passes JSON schema can still lose its Station
contributions during host normalization—for example, duplicate setting keys.
The portable part remains separate from that normalization result.

## Identity

The v1 target uses the Agent Plugins 1.0 name alphabet at storage boundaries:
1–64 lowercase ASCII letters, digits, hyphens, or periods; alphanumeric first
and last characters; no `--` or `..`. There is no second Station-only plugin ID
grammar. Both the shared portable parser and the legacy loader also reject the
otherwise-valid names `constructor` and `prototype` for compatibility with
Station's object-keyed stores. Installation additionally refuses Station's
[reserved route identities](../guides/plugins.md#reserved-plugin-names).
The logical plugin name identifies contributions and installation records; a
managed portable package's retained materialization directory need not have
that name.

## Secret boundary

Authors must not commit secret values in `plugin.json`, `mcp.json` `env`, or
MCP HTTP headers. `secretReferences` declares named inputs without embedding
their values, but its name does not imply a secret-store resolver.

The [manifest adapter](../../src-server/services/plugins/plugin-manifest-loader.ts)
currently converts each declaration to an ordinary string setting with
`secret: true`. The settings UI masks that input, the settings GET returns
`null` for its value, and the settings-change event withholds declared secrets.
The [settings PUT](../../src-server/routes/plugins/plugin-config-routes.ts)
persists submitted values through
[`ConfigLoader.savePluginOverrides`](../../src-server/domain/config-loader.ts)
as plaintext JSON in `<STATION_HOME>/config/plugin-overrides.json`.
[Provider factories](../../src-server/providers/plugin-provider-loader.ts)
receive those settings directly at construction. Masking and response
redaction do not encrypt storage or mediate provider access.

The [portable MCP loader](../../src-server/services/plugins/agent-plugin-loader.ts)
accepts literal environment and HTTP-header values; it does not resolve
`secretReferences` into them. Its placeholder expansion supports only
`PLUGIN_ROOT` and `PLUGIN_DATA`. A mediated secret authority for these plugin
inputs remains unimplemented.

## Current consumer behavior

Station requires the recognized manifest and MCP `$schema` identifiers; it
resolves those assets relative to the source/bundled server module rather than
the caller's working directory, reuses compiled validators, and
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

The loader supports stdio and Streamable HTTP definitions. It reports and skips SSE,
invalid Skills, and invalid individual server entries at their narrow failure
boundaries. Stdio children receive persistent per-plugin `PLUGIN_DATA`, exact
`PLUGIN_ROOT`, the plugin root as default cwd, and single-pass expansion of
only those two placeholders in arguments, environment values, and cwd. HTTP
headers remain literal. A stdio command is a bare executable token or a
contained `./` path; cwd must stay within the package or declared data root.
Those loading checks do not prove a child can launch or a remote server accepts
the supplied credentials. For managed installations, code updates select a
retained materialization while preserving the same independently scoped data
directory. Managed removal withdraws future contributions and retains
code/data; it does not claim that
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

The standalone manifest and Station-extension validators are generated from the
vendored manifest schema and Station's namespace schema by
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

## Follow the implementation

| Boundary | Owner and caller |
| --- | --- |
| Manifest admission and host normalization | [Shared parser](../../packages/shared/src/agent-plugin-manifest.ts), [server manifest adapter](../../src-server/services/plugins/plugin-manifest-loader.ts) |
| Package discovery, contained paths, Skills and MCP projection | [Portable loader](../../src-server/services/plugins/agent-plugin-loader.ts), [Skill discovery and mutation policy](../../src-server/services/agents/skill-service.ts), [MCP service](../../src-server/services/plugins/mcp-service.ts) |
| Selected code and persistent data | [Incarnation paths](../../src-server/services/plugins/plugin-incarnation.ts), [installation adapter](../../src-server/services/plugins/plugin-installation-local.ts) |
| Author builds | [Shared builder](../../packages/shared/src/build.ts), [CLI build command](../../packages/cli/src/commands/build.ts) |
| Schema freshness | [Generator](../../scripts/generate-agent-plugin-validators.mjs), [comparison gate](../../scripts/agent-plugin-validators-gate.mjs) |
