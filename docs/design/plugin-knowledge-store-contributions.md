# Plugin-contributed Knowledge stores

Status: **proposed for owner/architecture ratification**  
Issue: [archive#529](https://github.com/kontourai/station/issues/529)  
Parent: [archive#252](https://github.com/kontourai/station/issues/252)

## Decision summary

Station should first support **declarative, read-only root projections served by Station-owned,
non-writing Knowledge Kit readers**. A plugin may describe a bundled store or request a
user-selected local store binding, but it does not receive a raw host path and it does not register
executable adapter code in this first contract.

Executable plugin adapters are a separate, later extension point. They cross a materially larger
trust boundary and need their own trusted consent, lifecycle, conflict, and read-capability
contract. The existing `KnowledgeStoreProvider.registerAdapter()` method is an internal additive
seam, not a safe public plugin contract by itself.

This proposal does not change plugin loading, root registration, or filesystem access. An
implementation backlog should be filed only after the questions under [Ratification](#ratification)
are decided.

## Why this boundary

The current surfaces do not compose safely enough to expose directly:

- `PluginManifest.knowledge` contributes pre-index project knowledge namespaces only. It has no Kit
  root or adapter contribution.
- The durable root registry stores absolute `storeRoot` paths and treats roots as mutable. Its
  generated IDs can be reused after deregistration.
- `KnowledgeStoreProvider.registerAdapter()` is last-write-wins. A plugin can therefore shadow a
  built-in or another plugin's adapter if that method is exposed without a new policy layer.
- `KnowledgeStoreAdapter` combines reads and mutations in one interface. Calling an arbitrary
  plugin implementation “read-only” would not enforce read-only behavior.
- Station's current built-in adapters are not non-writing readers: construction may create a root,
  and read-time index repair writes canonical `graph-index.json` / `alias-index.json` files. They
  cannot serve this contract unchanged.
- The current browser root endpoint returns `KnowledgeStoreRoot`, including its absolute
  `storeRoot`, to same-origin code. Plugin UI bundles execute in that host page, and plugin server
  modules execute inside the Station process. Opaque binding IDs are therefore a target boundary,
  not a property of today's runtime.
- Installed plugins are copied beneath `<STATION_HOME>/plugins/<name>` and uninstallation recursively
  removes that directory. Bundled Knowledge data stored there is therefore package content, not a
  durable user-owned store.
- Plugin provider overrides disable individual provider types. They do not currently express a
  whole-plugin state or a Knowledge-root contribution state.

The Knowledge Kit contract remains authoritative for record shape and headless store behavior.
Station owns only the projection, policy, and presentation around that contract.

## Required platform prerequisites

Option A is a recommendation, not an assertion that today's plugin runtime can enforce it. Before
the first contribution activates, Station must land all of these as separately reviewed work:

- a zero-write `KnowledgeStoreReader` whose constructor and reads never create or repair files
  beneath the canonical source;
- a redacted browser root DTO plus an identity-bound operator/CLI binding channel that never gives
  same-origin plugin code a raw path;
- Station-recorded package authority and content provenance, independent of self-asserted manifest
  name/version; and
- contribution-specific activation, generation fencing, cache/index eviction, and orphan-binding
  lifecycle state.

Until those prerequisites exist, the only conforming behavior is “unsupported”; wrapping the
current adapter, filtering an existing root object in plugin UI, or calling root CRUD at install is
not an acceptable partial implementation.

## Options considered

### Option A — declarative root projection through Station-owned readers (recommended)

The plugin manifest declares stable contribution metadata. Station resolves the source, validates
the boundary, selects a Station-owned Kit-format **reader**, and exposes a read-only projection.
Mutation routes never receive a writable adapter for that projected root. The reader performs zero
writes during construction or reads; any graph, alias, or retrieval index it needs is disposable
Station state outside the canonical source.

Benefits:

- keeps plugin code outside the filesystem trust boundary;
- can enforce read-only access in Station rather than trusting a manifest claim;
- cleanly follows install, update, disable, and uninstall state;
- preserves headless Kit compatibility because the store remains valid without Station; and
- is sufficient for packaged references, skills, examples, and a plugin asking the user to bind
  an existing Kit or Obsidian store.

Cost: this requires a real `KnowledgeStoreReader` implementation rather than reusing the current
write-capable adapters unchanged. A novel store format still needs a Station-owned reader or a later
trusted adapter contract.

### Option B — executable plugin adapter plus root contribution

The plugin ships a server module implementing an adapter and declares roots that use it.

Benefits: maximum extensibility and support for remote or novel stores.

Costs and risks:

- adapter code can read host files or make network calls outside the apparent root;
- the current combined read/write interface cannot prove read-only behavior;
- adapter IDs can shadow one another under the current last-write-wins registry;
- update and unload require instance disposal, in-flight request draining, and cache invalidation;
- provenance must distinguish plugin, adapter implementation, and external source versions; and
- Station cannot claim Kit conformance merely because the module matches a TypeScript shape.

This is a useful later capability, but it requires a trusted permission and a read-specific runtime
interface before it is safe to publish.

### Option C — plugin calls the existing root CRUD API during install

The installer turns manifest entries into ordinary durable roots and deregisters them later.

This is rejected. It produces ghost roots after crashes or manual plugin removal, confuses plugin
state with user-owned root state, exposes absolute paths, permits ID reuse, and makes update or
uninstall cleanup destructive or ambiguous.

## Proposed public contract

The names below are a provider-neutral semantic contract, not a promise that this exact TypeScript
spelling is already implemented.

```ts
interface PluginKnowledgeStoreContribution {
  /** Stable only within this plugin. Must match [a-z0-9][a-z0-9._-]{0,63}. */
  id: string;
  displayName: string;

  /** Personal is one projection per installation. Project is one per activated project. */
  scope: { kind: 'personal' } | { kind: 'project' };

  source:
    | { kind: 'package'; relativePath: string }
    | { kind: 'user-binding'; bindingSlot: string };

  /** Station maps this Kit-format family to a Station-owned, non-writing reader. */
  reader: { adapterFamily: 'kit-default-store' | 'kit-obsidian-store' };

  access: 'read';

  /** Plugin-supplied version of the packaged content or expected external schema. */
  contentVersion: string;
}

interface PluginKnowledgeManifest {
  stores?: PluginKnowledgeStoreContribution[];
}
```

`package` means immutable plugin-package content. `relativePath` is not a general path API: Station
resolves it internally beneath the installed plugin incarnation and never returns the absolute path
to plugin UI code. A package store disappears with the package and must never be described as
user-owned durable data.

`user-binding` means the plugin asks for a logical binding. The user chooses or creates the local
store through Station-owned UI. Station persists the resolved path in its own protected binding
state, not in `plugin.json`, plugin settings, or the ordinary user root registry. The plugin sees
only `unbound`, `available`, or a bounded diagnostic.

Before this contract can ship, the ordinary browser root DTO must be split from the server-internal
`KnowledgeStoreRoot`: untrusted browser code receives root ID, display name, scope, capability,
state, and bounded provenance, but never `storeRoot`. No same-origin HTTP endpoint may return a raw
Knowledge path merely because the caller has ordinary Station browser authentication. Binding a
raw path must use an identity-bound operator channel that plugin runtime code cannot invoke or
observe; the browser manages only opaque binding slots. Until such mediation exists, the headless
Station CLI is the safe binding surface and browser path binding remains unavailable.

The first contract is eligible only for **data-only contributions**: a contributing package cannot
also declare an `entrypoint`/UI bundle, `serverModule`, provider module, or another executable entry.
Such code runs either in Station's same-origin host page or server process and can observe or read
around a binding independently, so Station could not honestly claim the binding is opaque or
contained. Declarative layout metadata may refer only to Station-owned components. A later
executable-adapter/UI proposal must resolve identity-bound host mediation and code isolation
explicitly.

Project-scoped contributions are projected only for projects where the plugin contribution is
activated. Installation alone does not copy the same project root into every project.

### Ownership and identity

There are four identities, and they must not be collapsed:

| Identity | Owner | Stable across | Purpose |
|---|---|---|---|
| package authority ID | Station | revisions from the same verified source/signer policy | consent and ownership |
| contribution key `packageAuthorityId/contributionId` | plugin manifest + Station | compatible updates by the same authority | user choices and diagnostics |
| source binding ID | Station | path moves and display-name edits | protects the real source location |
| projection incarnation | Station runtime | one validated source + reader + content version | cache and request safety |

The public root ID is namespaced and non-colliding, for example
`plugin:<package-authority-hash>:<contribution-id>:<project-binding?>`. It must never share the generated
`root:personal` / `root:project-*` namespace used by user roots.

Station records package provenance independently of the manifest: requested and resolved install
source, immutable revision when available, package content digest, and verified publisher/signer
identity when the distribution channel supplies one. A manifest's self-asserted `name` and
`version` are labels, not authority. A changed source, digest lineage, or publisher creates a new
package authority unless a separately ratified signed migration proves continuity; it always
requires explicit consent before an orphaned source binding can be reused.

An internal incarnation fingerprint includes at least package authority ID, plugin name, installed
plugin version, immutable revision and package digest, contribution ID, `contentVersion`, reader ID
and reader implementation version, source binding ID, and resolved-source identity. Updating any of
these creates a new incarnation. Cached reader, graph, record, or index data from the prior
incarnation must not be relabeled as the new one.

User-created roots remain authoritative. A plugin projection cannot replace, rename, or shadow a
user root even when display names or paths coincide.

### Path authority and filesystem safety

For a package source, Station must:

1. reject absolute paths, empty path segments, `.` / `..`, NUL bytes, and platform-specific
   alternate separators or drive prefixes;
2. resolve the installed plugin directory and candidate with `realpath`;
3. require the candidate to be the plugin root or a strict descendant of it;
4. reject every symlink or junction that escapes the resolved plugin root;
5. validate the root with the selected Station-owned reader before activation; and
6. anchor every descendant traversal and open to the validated directory descriptor, reject
   symlinks at every path component, and use the platform's no-follow/beneath-root primitive (or an
   equivalent OS-enforced mechanism) for the final open.

Re-running `realpath` before a pathname read is not an equivalent control: it leaves a time-of-check
to time-of-use race. A retained directory handle also does not help if later reads return to ambient
absolute paths. If the platform cannot provide descriptor-anchored, no-follow traversal for every
read, package-root projection fails closed on that platform.

For a user binding, only Station's user-mediated picker or headless binding command may establish
the source. The plugin cannot submit a path. Station may show the path to the user in its own trusted
settings surface, but it must not disclose it to plugin UI, logs, telemetry, manifest preview, or a
plugin server module.

The selected directory is the complete authority boundary for a user binding; choosing it does not
consent to external symlink or junction targets. The same descriptor-anchored, beneath-root,
no-follow traversal and open rule applies to **every** descendant read from a user-bound store.
Symlinks or post-binding swaps that would leave the selected root fail closed with a bounded
diagnostic. A future explicit “follow external targets” capability, if ever justified, requires a
separate active consent naming the broader authority and is not part of this contract.

Remote URLs and plugin-computed paths are outside the first contract.

### Read-only enforcement

`access: 'read'` is a capability boundary, not documentation.

- Station exposes only `get`, `getLinks`, `listByCategory`, and `listByType` from a purpose-built
  `KnowledgeStoreReader` for the projection.
- Create, update, link, propose, apply, reject, supersede, retire, migration, and any other mutation
  endpoint rejects a plugin-projected root before reader dispatch.
- A projected root cannot be selected as a write default.
- Construction and reads perform zero writes beneath the source. Reindexing may update Station's
  disposable derived state outside the source; it never creates or repairs canonical store files.
- The reader is not handed to plugin code. The current write-capable adapter wrapped in a facade is
  explicitly non-conforming because its constructor and read paths can still write indexes.
- Out-of-band edits remain owned by the package manager or user. Station may refresh its projection
  but does not rewrite the source to reconcile it.

If executable readers are later approved, their code-execution isolation remains a separate
requirement. Merely implementing a smaller TypeScript interface does not sandbox a module running in
Station's process.

### Permissions

The recommended first contract requires a new **active** consent such as
`knowledge.roots.contribute`. It authorizes Station to activate bounded projection metadata and
make the declared records available to Station experiences; it does **not** authorize the plugin to
read those records. It does not expose a host path or authorize reads outside the validated source. Establishing a `user-binding` is an additional explicit user action.

A future executable adapter needs a distinct trusted permission such as
`knowledge.adapters.register`. Network-backed adapters would additionally require the relevant
network consent. Reusing `providers.register` would hide the materially different filesystem and
canonical-data risk.

## Lifecycle and state

Plugin contribution state is a runtime projection derived from plugin installation state,
activation, permission, binding, and validation. It is not copied into
`config/knowledge-store-roots.json`.

| Event or condition | Projected state | Durable source/binding state | Required behavior |
|---|---|---|---|
| preview | inactive | unchanged | validate schema, IDs, package authority, paths, reader availability, permissions, data-only eligibility, and conflicts without opening records |
| installed, enabled, bound, valid | active | binding retained | publish one read-only projection per applicable scope |
| installed but project not activated | inactive | binding retained | do not project into that project |
| permission absent or revoked | unavailable | binding retained | deny reads; show bounded consent diagnostic |
| user binding absent | unavailable | no binding | offer Station-owned binding flow; never guess a path |
| source or reader invalid | unavailable | binding retained | report bounded diagnostic; do not fall back to another root |
| contribution disabled | inactive | binding retained | drain reads, remove projection, evict reader/index/cache state |
| update validating | old incarnation active | binding retained | validate candidate before swap; do not mix incarnations |
| update valid | new incarnation active | binding retained | atomically swap, then evict prior runtime/derived state |
| update invalid | old incarnation active | binding retained | keep last known-good projection and report update failure |
| contribution removed by update | inactive | binding retained but orphan-marked | stop projection; let the user forget or reassign the binding |
| plugin uninstall | inactive | user binding retained but orphan-marked | remove projection and grants; never delete external records |
| plugin reinstall with same contribution key and authority | inactive until revalidated | binding available for explicit reuse | require explicit reuse; never silently trust a new package/source incarnation |
| package authority changes | unavailable | binding retained but orphan-marked | require new consent and explicit rebind; never inherit the old authority's access |

For package sources, uninstall naturally removes package-owned files when the plugin directory is
removed. That is package cleanup, not Knowledge record deletion. Station must warn that packaged
content is not a durable user store and must never place user-authored mutations there.

The existing provider override array is not sufficient lifecycle state. The implementation needs a
namespaced component key such as `knowledge-store:<contribution-id>` and must define whole-plugin
disable behavior if Station later adds it.

## Conflict rules

Preview and update validation fail closed when:

- contribution IDs repeat within a manifest;
- a contribution key collides with another installed incarnation of the same plugin identity;
- a proposed public projection ID collides with any user or plugin root;
- the reader ID is unknown, write-capable, or is not Station-owned in the first contract;
- a package path escapes its plugin incarnation;
- the package includes an executable server contribution;
- a project contribution lacks an activation binding; or
- an update changes the semantic owner of an existing contribution key without a new key or an
  explicit migration declaration.

Display-name collisions are allowed and disambiguated with plugin provenance. Source paths are not
identities, but a canonical source already registered as a user root is never projected a second
time: the user root wins, and Station may offer the user an explicit association without changing
its ownership or capability. Two plugin contributions resolving to the same source remain
unavailable until the user explicitly selects one projection owner; Station does not silently
duplicate records in the derived index or merge authority.

## Provenance and disclosure

Every root, record, graph result, search hit, and diagnostic projected through this contract must be
able to disclose:

- package authority ID, resolved install source/revision, package digest, verified publisher when
  available, plugin name, display name, installed version, and contribution ID;
- source kind (`package` or `user-binding`) without revealing an untrusted raw path;
- Kit adapter family plus Station reader ID and implementation version;
- declared content version and projection-incarnation fingerprint;
- scope and project binding when applicable;
- read-only capability; and
- current state (`active`, `inactive`, `unavailable`, `updating`) plus a bounded reason.

This projection provenance supplements the record's immutable Kit provenance; it does not rewrite
`KitRecord.provenance` or claim the plugin authored records it merely distributes.

## Headless Kit conformance

Station must remain optional:

- a package or user-bound store is a valid Knowledge Kit store without Station;
- the Kit's published store contract and on-disk format, not Station internals, define record
  conformance;
- a headless validator can open the resolved store with the declared adapter family and read the
  same IDs, records, links, lifecycle, and provenance;
- Station-specific projection metadata stays outside the canonical store; and
- uninstalling Station or disabling the plugin never rewrites external records.

The implementation acceptance suite should create fixtures through headless Kit tooling, read them
through Station, and also read Station-indexed results back from the canonical fixture. It must not
use a sibling checkout or unpublished Kit internals as runtime authority.

## Threat model

| Threat | Consequence | Required control |
|---|---|---|
| `../`, absolute path, alternate separator, drive-prefix, or NUL injection | arbitrary host-file read | strict lexical rejection followed by canonical containment |
| symlink/junction escape or post-validation swap | boundary bypass | descriptor-anchored, no-follow traversal and open for every descendant read; fail closed without OS support |
| raw path returned to same-origin plugin UI | host topology and username disclosure | redacted public DTO, no browser path endpoint, opaque binding operations |
| plugin server module reads around the binding | arbitrary host-file read | data-only v1 eligibility; executable contributions deferred pending isolation |
| “read-only” full adapter mutates during construction/read | canonical data corruption | purpose-built zero-write reader; all derived state outside source |
| adapter ID shadowing | malicious code serves another root | reserved built-in namespace; namespaced future IDs; duplicate rejection |
| root ID reuse or stale cache relabeling | records shown under the wrong owner/version | incarnation fingerprint in every reader/cache/index key |
| update swaps files during an in-flight read | mixed-version result | validate then atomic activation; drain or generation-fence old reads |
| disable/uninstall deletes user records | data loss | runtime projection only; orphan bindings; no recursive source deletion |
| packaged data mistaken for durable user data | data loss on normal uninstall | immutable read-only package source and explicit ownership disclosure |
| malicious or huge store exhausts resources | denial of service | bounded scan, record-size/count limits, deadlines, cancellation, and derived-index quotas |
| record content injects UI or instructions | script execution or agent prompt injection | treat content as untrusted; existing rendering containment and agent-context policy apply |
| telemetry/logging leaks content or paths | privacy loss | bounded IDs/state only; no body, raw path, or secrets in telemetry |
| same-name replacement or plugin reinstall captures an orphan binding | unintended data disclosure | Station-recorded package authority, explicit consent/rebinding, and full revalidation |

## Ratification

Owner/architecture decisions required before implementation issues are filed:

1. Ratify Option A as the first public contract and defer executable adapters.
2. Ratify both `package` and `user-binding` sources, or narrow the first slice to one source kind;
   specifically decide whether immutable packaged records disappearing with package uninstall
   satisfy the suite's canonical-record retention rule.
3. Ratify the new permission names, active consent tier, and data-only eligibility rule.
4. Choose when a project-scoped contribution is activated (project creation from a plugin layout,
   explicit project assignment, or both).
5. Confirm orphan bindings survive update removal and uninstall until the user explicitly forgets
   them.

After ratification, split implementation into independently reviewable vertical slices: redacted
root DTO + zero-write reader prerequisite, manifest + preview contract, secure source binding +
lifecycle projection, read-only query/index enforcement, and package provenance + headless
conformance. Executable adapter registration remains a separate proposal.
