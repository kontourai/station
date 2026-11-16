---
status: current
subject: A registry source is a location; what it provides is detected from the structure of its content
decided: 2026-11-12
evidence:
  - kind: doc
    ref: src-server/providers/registries/registry-source-detection.ts
  - kind: doc
    ref: src-server/providers/registries/registry-source-manager.ts
  - kind: doc
    ref: src-server/providers/registries/confined-local-read.ts
  - kind: doc
    ref: src-server/providers/registries/registry-source-configuration.ts
  - kind: doc
    ref: src-server/providers/registries/agent-registry-provider.ts
  - kind: doc
    ref: src-server/routes/plugins/__tests__/registry-sources-detected.routes.test.ts
  - kind: doc
    ref: docs/decisions/managed-policy.md
---

# Registry sources detected by structure

Every registry type accepts several sources. A person adds a source by giving
a **location** and, for a repository, an optional **ref**. They do not choose
an adapter or a kind. Station reads the source and decides what it provides
from the structure of its content, not from where it lives. One source can
provide several kinds.

## The source model

A source is `{location, ref?}` plus a label, which Station derives when the
person gives none. There are three kinds of location:

- `https://github.com/<owner>/<repository>`: read through GitHub's API at the
  commit that `ref` names when it is read. Without a ref, Station reads the
  default branch.
- An absolute path on this Station: a folder is read as a tree, and a file as
  one document.
- Any other `https` URL: one document.

The stored `adapter` field records how the location is read (`github`,
`directory` or `manifest`). It is derived from the location and never decides
a kind. Station keeps writing it so that a Station that predates detection can
still read the file.

## Detection order

[`registry-source-detection.ts`](../../src-server/providers/registries/registry-source-detection.ts)
runs detectors over the source's tree, or over its single document:

1. **Index detectors** read a declared file at the root: Station's manifest
   (`registry.json` or `manifest.json`, `{version, plugins, tools?}`) and a
   Claude Code `.claude-plugin/marketplace.json`. An index decides every kind
   its format can declare, including a declared zero. A structural scan then
   neither adds items of that kind nor counts its packages again.
2. **Structure detectors** scan the layout for the kinds that no index
   declared. `**/SKILL.md` gives skills. `plugin.json` and
   `.claude-plugin/plugin.json` give plugins. `mcp.json` and `.mcp.json` with
   `mcpServers` give integrations.

An index wins only for the kinds it declares, not for the whole source. A
common repository layout puts a marketplace index that lists only plugins
beside `skills/*/SKILL.md` packages. Station's existing default GitHub skill
source (`anthropics/skills`) has that shape. If the index won for the whole
source, such a repository would list no installable skill.

The result is a list of kinds, each with a count, the detector that found it,
and whether Station can install it. Every installable kind maps onto an
installer that already exists; detection adds none:

| Kind | Installable from | Installer |
| --- | --- | --- |
| skills | folder, GitHub | filesystem or GitHub skill provider |
| plugins, agents | a Station manifest in a folder or document | the manifest provider and the plugin pipeline |
| plugins from a Claude marketplace, bare plugin packages, integrations | — | recognized and counted, `installable: false` with a note |

Plugins and agents in a GitHub repository's Station manifest are counted but
not installable. The manifest names its packages by repository-relative
paths, and Station acquires those only from a local folder.

A source that Station can read but recognizes nothing in has the state
`nothing-recognized`, which is not an error. A read that hits a bound has the
state `refused`. One that fails has the state `unavailable` and keeps the last
kinds and catalogs it was seen to provide, marked stale.

## Bounds refuse; they never truncate

A scan stops at any of these bounds and refuses the whole source:

- 8192 files and folders (`.git` excluded);
- 16 folder levels;
- 1 MiB per index or definition file, per `SKILL.md` (checked against the
  listed size before any is read, and again while the skill provider reads
  it), or per single-document source;
- 128 definition reads;
- 512 skills;
- a GitHub tree that the API reports as truncated.

Station refuses rather than truncates because a partial scan could hide an
item, or turn an ambiguous name into a first match.

A folder source is read only inside itself
([`confined-local-read.ts`](../../src-server/providers/registries/confined-local-read.ts)).
The scan lists no symlink. Every later read, by detection and by the skill
provider, walks each path component below the source root and refuses a link.
It re-checks containment by real path, opens with `O_NOFOLLOW`, and refuses
unless the opened file is the one it checked (device and inode). So a
directory swapped for a link after the scan refuses the read, and the source
shows `refused` or an unreadable catalog. A regular file with more than
one hard link is refused too, both as checked and as opened. A hard link is
an ordinary name inside the folder for a file that may live outside it, and
it cannot be told apart from its "original", so the policy is to refuse every
multiply linked file. That covers detection (a `SKILL.md` it counts without
reading is refused by the link count the scan saw, and the source shows
`refused` with the file named), the skill provider (and each
skill package before it is hashed or copied), the manifest provider's
`registry.json`, and each local package directory before it is resolved or
copied. Residual: the package checks run before the copy starts, so a hard
link created during the copy itself is not caught. A linked `SKILL.md` is neither
counted nor listed. Station's default skill folders are not confined, because
a person may link skills into them on purpose. Their `SKILL.md` reads are
bounded the same way.

## Several kinds from one source

The source manager keeps one catalog entry for each installable kind of a
source. The source keeps its id, and a selection names
`{sourceId, itemId, revision, kind}`, so the same source's skills and plugins
resolve through their own installers. `GET /api/registry/sources` returns one
row for each source, with `detection.kinds`. `kind` stays the primary catalog
kind for older clients. `RegistryCatalogSelection.kind` gains `agents`. The
contract change is additive: an exhaustive switch over that union needs one
more case.

## Agents from every source

`getAgentRegistryProvider()` used to return the first registered agent
catalog. It now merges every registered catalog, like integrations, but
without picking a winner. Each row names its catalog. An id that two catalogs
offer is listed from both, marked `ambiguous-source`, and installing it is
refused (409) with the catalogs named. Ownership is decided only when every
catalog answers: if one cannot be read, a plain-id install is refused (503,
naming it) rather than given to another catalog that offers the same id. The
check is a precondition of the one resolver every registry entry resolution
goes through, which takes a required purpose. An `acquire` resolution of a
plain id settles the owner first: plugin install, preview, update, dependency
preflight and installation, the legacy dependency policy lookup, and
acquisition capture. A `lookup` resolution (removal, alias migration) reads
only what is already installed or recorded. The agent route always refuses
an unknown owner. Package paths refuse an ambiguous id, and an unknown owner
when a readable catalog offers the id as an agent, so an ordinary plugin is
not blocked by an unrelated catalog outage. Update answers the same status
and code as install. Agents from added sources are listed beside
these rows with source-qualified ids, and they install through the plugin
pipeline, because a manifest agent entry is a package. A plugin-contributed
JSON agent registry now gets the manifest's agent view, not its whole plugin
list.

## Freshness and updates

Each read records the source's revision: for GitHub, the commit that the ref
names at that moment, never a local checkout or a cached tree; for a folder, a
digest of the tree. A read that finds a new revision sets `changedAt`. Refresh
reads the source again before reading its catalogs. A selection made against
the old revision is refused as `source-changed`, so a person installs what the
source is now, not what a stale copy said.

## Migration with no action

A `registry-sources.json` written before detection loads unchanged:

- A source with no recorded detection keeps the one kind its adapter implied
  (`manifest` gives plugins, and anything else gives skills). The kind's
  provider and the revision formula are the same, so every stored selection
  and installed alias keeps resolving.
- A snapshot keyed by the bare source id moves to `<id>#<kind>` for that kind.
- The first catalog read detects each enabled source and records the result.
  From then on, the source provides what its content shows.

The rewritten file stays readable by a Station that predates detection. That
reader validates every source and every `snapshots` row strictly, but drops
unknown top-level keys. So the file keeps:

- the earlier source keys and an `adapter` on each source;
- at most 32 `snapshots`, holding only `skills` and `plugins` rows;
- `detections`, and catalogs of a newer kind (`agents`), under top-level keys
  (`detections`, `kindSnapshots`) that the older reader ignores. It loses only
  their offline cache.

The one exception is a source with a `ref`. The older reader refuses the
whole file ("restore your file") rather than silently dropping the ref and
reading the default branch. To downgrade, remove those sources first; the
older Station then reads the rest. A test pins both outcomes against the
older reader's schema.

An older client's `adapter` on add is accepted and ignored, except as the way
to read a local path that does not exist yet.

## Managed policy

This change leaves policy strength as it was:

- `limits.registries.allowedUrls` refuses a source by location before anything
  is read from it.
- `unsignedPackages: false` refuses every skill catalog from an added source.
  Skills cannot be signed. That holds per kind: a source's refused skills are
  marked on that kind, while its plugins stay listed and still need a trusted
  signature to install.
- A source whose every installable kind is refused is refused whole, at add
  time and in its row, as a skill library was when a person chose its type.

## Extension point

A new format is one more index or structure detector, added to the lists in
`registry-source-detection.ts`. The source model and the source manager do not
change. A Flow Kit detector, for `kit.json` installed through
`flow-agents kit install`, is the expected next one and is not part of this
change.
