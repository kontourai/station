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
the existing publication/content locks. A pointer/backend acknowledgement gap
is unavailable execution, not permission to guess a current generation.

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

Pre-incarnation installed directories are not silently renamed. Mutation is
refused with an explicit migration instruction because their already-running
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
