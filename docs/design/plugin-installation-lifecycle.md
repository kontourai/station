# Plugin installation lifecycle

Status: working implementation design. Owns the package lifecycle slice of
#1409 and #344; the [personal and hosted topology](conversation-state.md#36-two-implementations-of-one-contract)
and existing permission/composition owners remain authoritative.

## Responsibilities

Station separates verified package artifacts, installation selection, plugin
data, and execution custody. A package URL or directory is not permission to
execute it. An SDK connection closing is not proof that its descendants or
remote work stopped.

| Responsibility | Implemented local adapter | Other deployment adapters |
| --- | --- | --- |
| Verified artifact materialization | Staged source with a checked content digest; retained physical package roots | Registry/object-store acquisition may materialize near a remote executor; no new hosted adapter is implemented here |
| Installation/admission authority | Existing EventStore SQLite journal and its transactions | Transactional hosted installation service is an extension point, not a deployed capability |
| Plugin data | Stable local data scope, independent of code materialization | Scoped database/object storage and migration services remain future implementations |
| Execution custody | Existing managed, probe, App, OAuth and alternate-framework local custody, with captured package admission | Remote workers need their own admission and terminal-effect capabilities |

`PluginInstallationService` uses asynchronous intent interfaces. Inputs and
results carry opaque scope, installation, generation, materialization, data
scope, artifact digest and expected revision. They do not require a local
home, path, PID, vendor account or shared filesystem. Filesystem locations are
private arguments of the local materialization adapter. Registry source,
signature and exact-pin verification remain with `RegistryPackageClaim` and
its existing supply-chain owner. This service is not a second registry.

The local adapter keeps using the already-open EventStore; a request never
opens another database. Its service contract is also exercised over a real
child-process transport. That demonstrates asynchronous/CAS boundaries, not
enterprise deployment support.

## Update, withdrawal, and data

Every code materialization has its own physical root. Updating selects a new
root and a fresh admission generation; it never overwrites, renames or copies
the old package tree. The portable loader captures the physical root before
invocation, so an already-admitted process keeps its original `PLUGIN_ROOT`
and working directory.

Normal updates point to the same data scope. Station never takes a rollback
copy of live `PLUGIN_DATA`, deletes it, or silently replaces it with empty
data. This satisfies the portable contract's preservation requirement without
pretending an SDK close proves process drainage. Application-level concurrency
and schema compatibility remain the plugin data owner's responsibility. No
automatic data migration hooks are run by this Skills/MCP consumer.

An explicitly requested `retain-and-reset` creates a new data scope while
retaining the prior scope for recovery. It is a reset/new installation choice,
not a state-preserving update. Ordinary update uses `preserve`.

Removal withdraws the selected generation and future contributions. Physical
code and data remain retained. The response and Plugins interface say so;
`GET /api/plugins/:name/retained-generations` exposes redacted installation
history and unresolved effect counts. `reclamation: not-proven` is deliberate:
there is no generic physical deletion capability in this change.

Code selection rollback is not data rollback. Writes already performed by a
plugin remain in its data scope. Selecting previous code again must mint a new
admission generation; old tickets must never become current through an ABA
round trip.

## Publication and failure

The backend checks the expected revision before publication. Existing
installation retirement fences new shared admission; replacement atomically
changes the selected journal generation. Possible external effects remain in
the historical generation, including after local SDK settlement.

For first installation, the journal claims the absent installation before
publishing execution materialization. A losing concurrent create cannot remove
the winner's pointer. The local adapter serializes installer publication with
the existing publication/content locks. The journal is the sole selection authority; the local directory alias is a
compatibility projection. Portable source reads resolve the recorded immutable
materialization directly. Alias/backend acknowledgement gaps return a typed
pending outcome and are reconciled on reload or startup, without guessing a
new generation. Projection writes compare their expected prior materialization
under the existing local content lock so a delayed repair cannot replace a
newer projection.

If publication fails before state commits, compensation restores the previous
pointer and cancels its exact fence. It does not restore mutable package/data
snapshots. If a backend loses the commit acknowledgement, inspection checks
whether the new selection committed before any compensation; an unknown result
remains unavailable. Parent-PID death, elapsed time and local close are never
used as deletion evidence.

Filesystem compatibility uses a narrowly validated directory pointer on the
local adapter only: POSIX symlink or Windows directory junction. All target
ancestors and the data scope must be real directories in the host layout.
Arbitrary user symlinks are not accepted. Windows replacement may have a
pointer gap; absence is fail-closed and never traversed for cleanup. Native
Windows junction/publication qualification remains required before claiming
Windows completion.

Pre-incarnation Agent Plugin directories are not silently renamed. Managed
mutation is refused with an explicit migration instruction because their already-running
processes may still use the original paths. No existing user home is migrated
by startup or a catalog read.

## Local-first and hosted behavior

Local installation works without a server or account. A hosted adapter may
replace artifact transport and installation-state persistence while preserving
the same expected-revision, admission, retention and failure semantics. It
must declare unsupported capabilities, such as stable snapshots or terminal
remote-effect proof, rather than silently emulate them with file locks.

This change does not replicate authorization through a multi-writer cache,
introduce last-write-wins grant synchronization, or publish a hosted adapter.
Organization policy remains evaluated by its owning authority; offline local
scope does not become authority for an enterprise-managed installation.

## Bounded live state and durable retention

The admission journal bounds concurrent unresolved claims and hot generations,
not lifetime probes or updates. Once an SDK handle settles, its exact claim and
owner remain in an EventStore-owned audit table; the hot generation carries a
count of possible external effects. This compaction never grants deletion or
pretends descendants stopped. Retired generations with no remaining local
claims move to indexed durable history, served in cursor pages. Their physical
code and independent data scopes remain retained. Tests exceed 512 sequential
service probes and 256 updates while keeping the concurrent-claim cap enforced.

Portable dependencies use the canonical installer with their own preview-bound
approvals. A private execution context reuses the owned publication lease for
nested installation; request data cannot create this capability. Cleanup custody
for managed children binds their admission generation as well as their digest.
Shared custody transfers through the existing grant/ownership store. Retirement
withdraws nested selections and retains code/data; transaction compensation
mints fresh admissions and rebinds only those exact restored child receipts.
An independently replaced generation is preserved. The legacy copier still
refuses portable creation when no canonical lifecycle owner is supplied.

## Composition and artifact transfer

`StationRuntimeOptions.pluginInstallationHost` injects the installation host at
runtime composition. Direct and registry installation, update, removal and
reload use that host. Its asynchronous service accepts a prepared artifact
reference with an entry-reader capability, so a worker can receive and verify
the actual bytes without knowing the acquisition adapter's temporary path.
The local host keeps a private direct-path optimization and also supports
materializing a foreign reader capability. The route-level transport test
transfers artifact entries to another process, checks the digest there and
commits actual installation state; it does not return a synthetic success.

Local materialization and data keys are injectively prefixed. Logical package
names remain unchanged, including Windows device stems such as `con`, `nul`,
`com1`, and `con.foo`; those names use a dedicated compatibility-alias namespace.
A native Windows helper run with Node24.5 verified key mapping, actual junction
replacement, data preservation, retained code, projection removal/repair and
hostile-pointer refusal at source hash
`074338124699f50b9fa0b8a3f181ed10f8e20ee3822f30f14dc191e6c6e5d779`.
This is adapter-only diagnostic evidence, not full application qualification
under the standard development runtime or a hosted deployment claim.

The transferable-artifact adapter rejects unsupported Windows content-path
spellings (drive/ADS syntax, trailing dots/spaces, device basenames and case
collisions). It never encodes package content paths, whose relative references
must retain meaning. Native Windows Node24.5 execution verified these refusals
and positive reader/digest materialization in bundle
`d0796995eaaf53fec65a1d8b183e0ad454b2ea109113a8adbff39af7be4db27b`.
Hashing preserves symlink text and does not prove containment. The transfer
adapter separately validates lexical targets and native-resolved chains before
publication; dangling/cyclic links are unsupported there. The direct local
source path retains the existing component-level package containment checks.

The native-resolution regression includes an actual outside-read witness;
Node's JavaScript realpath normalization can disagree with the path the OS
opens for a symlink chain containing `..`. Existing containment owners are
tracked separately in #1502; this change does not claim they were all audited.

## Station contribution activation and continuity

Validated `io.kontourai.station` declarations normalize into the existing host
manifest and consent owners. Managed installation uses the existing build,
Agent synchronization, provider publication, permission, and rollback flow.
Agent sources are validated before prior definitions are removed. Uninstall
withdraws admission and removes host contributions while retaining package code
and data. Transaction compensation selects the recorded prior materialization with a
fresh admission generation; it does not undo writes made by plugin code.
Compensation of a failed explicit reset restores its prior data-scope selection.
This internal recovery intent is distinct from ordinary user-facing code rollback,
which would keep the currently selected data scope and is not provided by it.

The journal additionally records an opaque acquisition-origin continuity token.
The local acquisition owner scopes it to the host, canonical source, and registry
owner when applicable. A changed or missing historical origin refuses data
continuity with a migration-needed outcome; it does not reset or copy data.
This token does not authenticate a publisher. Registry signatures and trusted
publisher changes must remain governed by the registry claim/pin owner, whose
complete production integration is a separate qualification requirement.

The selected generation records pending activation before host effects. The
existing runtime configuration owner verifies the declared resources and commits
ready only after its applied rebuild; ordinary admission includes that readiness
in its selected-generation fingerprint. Installed notifications are delivered
after the runtime access barrier opens. Notification failure does not undo a
committed installation, and events are hints rather than durable readiness proof.

Qualification remains incomplete: provider visibility during pending composition,
all contribution diagnostics and user-facing recovery, full captured-root
propagation, and final routed gates are still required. Focused tests cover real
Station Agent activation, withdrawal, permission-revocation races, injected
activation-failure compensation, retained data, fresh compensation admission, and
acquisition-origin refusal. They do not establish hosted execution or full
enterprise support.

A local journal scope or shared filesystem home is not tenant isolation. Hosted
identity and policy must bind authenticated tenant scopes to their installation,
data and execution backends. These local adapters do not establish that hosted
isolation contract.

## Permission decision receipts

Permission state remains in the existing GrantsFileStore. Its host-generated
`mutationRevision` distinguishes decisions even when a revoke or regrant leaves
the same permission values. Empty revisioned records are denial fences, not an
installed-package claim or disposable cache; removing them could revive an old
approval. Legacy arrays remain readable without inventing a content digest.

An install adapter observes grant revisions before acquisition, including when
it does not yet know the package name. Preview and recovery bind the eventual
package and dependency revisions from that observation. Before every owned grant
write, the permission owner compares the expected revision under the existing
short mutation lock. A later independent decision rejects the stale write with
`plugin_grant_mutation_superseded`; retry requires a fresh review. Source fetch,
build, provider initialization, and other long work do not hold that lock.

An in-process mutation scope retains receipts for its permission writes.
Rollback folds those receipts backward under one short store mutation and
reports `restored`, `superseded`, `unchanged`, or `unavailable`. Superseded means a
later decision was preserved; it is not an invitation to repeat an old restore.
An unavailable store is never repaired from a snapshot automatically. Current
installation custody is retained: its owner compensates custody separately,
then providers reload against the resulting live grants. A grant snapshot is
observation and cannot authorize restoration.

These receipt objects are server-local transaction context, not public plugin
SDK authority or durable approval. After a crash, recovery obtains fresh approval
against current grant revisions instead of treating old receipts as permission.


## Recovering an interrupted local installation

`GET /api/plugins/:name/recovery-preview` inspects a pending journal selection and
its retained artifact. `POST /api/plugins/:name/recover` requires that preview's
`recoveryRevision` and a fresh permission decision, including current grant
revisions for the package and its dependencies. These routes use the existing
plugin administration authentication boundary; the revision is a comparison
value, not a credential or a reusable authorization token. The [SDK reference](../reference/sdk.md)
provides a client example and response handling.

The local recovery adapter works after the original source and routing alias are
removed. It verifies the retained bytes and origin, reuses the existing installer
and contribution owners, and mints a new admission generation while preserving
the data scope. It does not fetch dependencies or rebuild retained code. Missing
managed dependencies must be installed first; pending dependencies must be
recovered first, from leaves to parent. Changed bytes, grants, dependency
selections, or activation evidence require a new preview or a reviewed original
source. A previously ready installation is not a pending recovery candidate.

Real process tests terminate the installer before host effects, after host effects,
and before ready publication. Fresh processes exercise original-source recovery,
alias-free retained recovery, and dependency-first graph recovery with data
preservation. These tests use the local execution journal. They do not qualify a
hosted recovery adapter, automatic graph replay, user-facing code rollback, data
migration, or eventual delivery of an event lost during process termination.
