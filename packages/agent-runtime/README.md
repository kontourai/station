# Experimental agent runtime

`@kontourai/agent-runtime` retains model requests and completed native streams
for an authorized generation. The existing VoltAgent or Strands loop continues
to choose model calls. This private workspace package is experimental Tier 1;
it is not a released package or Station restart integration.

The root entry exports the twelve model commands, coordinator, staged memory
adapter, fixed policy and ordered outbox drain. `/sqlite` uses a host-supplied
Node 24 `DatabaseSync`. `/ai-sdk`, `/voltagent` and `/strands` bind the pinned
AI SDK v3 interface, VoltAgent 2.10.0 and Strands 1.19.0 VercelModel. Optional
framework dependencies are exact peers. The package imports no Station code.

The host supplies authorization/current implementation and writer-generation
closures, real owner liveness, and the already-authorized source cutoff.
`start` captures effective entry bytes before constructing a guarded native
consumer from that retained input.
`restore` requires the full observed fence and proven-dead previous owner;
it returns the retained entry without consulting a new composer. Construct a
fresh consumer from that entry, use `control.run` around the native call and
stream consumption, then `finish('completed')`. Explicit `cancel` quiesces the
owned stream and records cancellation. A disconnected host transport does not
implicitly call it.

The first `begin.execute` COMMIT acknowledgment permits one provider dispatch.
An acknowledgment retry returns a receipt, never another dispatch grant.
Recovery can resend and incur model billing again. Every visible prefix part
commits before projection. The ordered suffix beginning with a tool-enabling
part or successful terminal remains held through EOF, strict tape validation,
durable body put and complete COMMIT acknowledgment. Empty-prefix completion
uses `lastPartialSequence: -1`; otherwise it is the last committed sequence.

Actual tools refuse before their registered body and block the run, even when
the framework catches the refusal. Client-tool responses exercise the model
commit barrier; they do not establish durable tools, results or approvals.
There are no tool/approval commands, tool replay declarations or new agent loop.

SQLite bodies are immutable, content-addressed BLOBs in the existing host
connection's `agent_runtime_` namespace. Opening requires WAL, FULL synchronous
mode and foreign keys; wrappers validate them and do not change host pragmas.
External/nested transactions, future/partial schema and unsupported writers
refuse. Body COMMIT precedes journal adoption; an orphan body grants nothing.
Journal, operation receipt and outbox commit in one real transaction.
Current journal validation ties every completed attempt to the exact owning
completed outbox body before replay. This permits legitimate completed replay
before run settlement or projection draining; sink acknowledgment/application
remain additional ready-view requirements.
An optional generic participant `maintenance` stage joins actual compaction
writes when the triggering command returns expired; normal `commit` still
excludes refusals. Both run before COMMIT and roll back on failure. Closing
a wrapper does not close the host connection.

SQLite command validation is scoped to the requested run: current run/retired
records, canonically routed receipts and outbox rows, their relationships, and
referenced bodies. Every body read still checks the complete reference, byte
length, digest and codec. New-run admission also checks global active-run
capacity and same-scope conversation occupancy. Opening model storage selects
open/running runs and suspect state/settlement headers through its index, then
validates each selected run against the supported maximum of 128. A reduced
`maxOpenRuns` applies to new admission; existing work remains recoverable and
drainable above that session cap. Takeover validates the requested run before
returning recovery authority. A record excluded by the open-time selector is
checked when its run is read or through the explicit whole-store audit. Damage
in unrelated settled records does not block an ordinary command on this run
through an already-open storage handle. Reopening still refuses invalid JSON
or suspect state/settlement headers in the unresolved selection. A shared body
still refuses wherever a checked reference reads its damaged bytes.

The additive `agent_runtime_unresolved` index changes no table, JSON/BLOB codec,
record identity or writer format (`schema_version=2`, `runtime-model/1`). Exact
namespace checks include this index and refuse TEMP shadows and unexpected
objects attached to runtime tables. Participants retain the real host connection.
Every write compares the physical unresolved-index IDs across callbacks,
allowing only the current run's unresolved-membership transition. This control
query selects IDs without decoding unrelated JSON payloads; physical table-page
I/O has not been verified through SQLite planner or I/O observations. Existing
runs on an already-open handle can finish and drain when unrelated settled
records acquire suspect headers; callback changes
to that current membership still roll back. The complete ID walk is not truncated
or refused merely because suspect membership exceeds 128, so its size can grow
with corruption. New-run admission and storage opening retain strict suspect-header
validation and the absolute supported bound. New admission still parses and
schema/header-validates every selected active record, so its cost depends on
the total active-record payload. Settled-history and single-run workloads do
not qualify that active-set admission cost. Admission derives conversation
occupancy from validated canonical IDs. Participant admission
cannot replace the selected run's captured row bytes; commit cannot change its
expected logical records. Such changes roll back. Current host admission is a
detached observation at its existing point; native release still performs its
own final current-authority checks. This is not continuous authorization across
callbacks.

`auditAgentRuntimeStore({ database, policy })`, exported by `/sqlite`, is an
explicit quiescent diagnostic for an already prepared M1 store. Its exact
`agent_runtime_unresolved` index must already exist; an ordinary M1 wrapper open
prepares the index, while the audit never creates it. The diagnostic connection
must be idle, outside an existing transaction, with WAL, `synchronous=FULL` and
foreign keys enabled. The host owns opening/configuring that connection and
quiescing its callbacks; the audit changes none of these settings.

The audit uses a read-only transaction and `integrity_check`, compares indexed
unresolved membership with a raw table scan and decoded headers, and checks the
whole journal, applied projections and every BLOB, including orphans. It rejects
duplicate control-header keys, nontext states, inconsistent state/settlement
pairs and noninteger numeric settlement encodings when read. SQL/JavaScript
header disagreement and stale index membership are reported offline. Physical receipt and outbox identity issues are enumerated independently
where possible. Per-run and retired-key checks retain the shared receipt, outbox
ordering and body-link validators without a redundant whole-state pass.

Detected damage always yields `status: 'damaged'`, including native SQLite
`CORRUPT` and `NOTADB` errors identified by the primary byte of Node's numeric
`errcode`. Those engine errors report `DURABLE_SQLITE_DAMAGED`; an aborted scan
still has incomplete enumeration. Enumeration completeness is
independent: an undecodable record, aborted relationship pass or truncated issue
list can yield `damaged` with `complete: false`. When SQL or a preparation
prerequisite is unavailable and no damage has been established, status is
`incomplete`; an unprepared namespace alone is not a damage verdict. Each issue
has `disposition: 'damage' | 'unavailable'`, a category, code and optional hashed
row identity, without stored payloads. The audit creates or repairs nothing.
Inspect status, completeness and bounded issues together; incomplete enumeration
is never clean. Receipts moved outside their canonical
run range are audited as damage; losing a receipt does not remint an existing
attempt's grant. These checks do not authenticate the file against coherent
malicious rewrites or consistent rollback, or lock an external effect against
cross-process changes. Whole-run JSON work and workload performance remain
unqualified; scoping removes the requirement to validate unrelated settled
history on each command.

The SQLite projection sink retains raw partial audit and stable abort markers.
A drain captures the initial committed outbox high-water position and applies
that finite window across pages, leaving concurrent later appends for the next
call. `listOutbox` returns `throughPosition`; later page requests retain it.
Its ready view requires a settled run and every required outbox disposition
applied and acknowledged. It returns only completed tapes in request order, requiring each tape to match
its owning pin/attempt, exact completed outbox and applied sink body, native
tape header and retained partial prefix. Request IDs remain scoped to a run.
It is a response projection, with no editable conversation/history API. No
unresolved row is evicted. Defaults are 128 open runs, 1024 calls/run, 32 MiB
per body/request/response, 16 MiB committed partials/attempt, 7-day settled
replay and 30-day generation protection. Fixed bounds may be reduced at open.
Settled command replay compacts only on an authorized write to that exact
generation after all required outbox dispositions are acknowledged and the real
SQLite sink has applied them. On an eligible authorized write at least seven
days after settlement, bulky run and receipt answers become a tombstone. At
thirty days from the same settlement, an eligible write reduces it to a minimal
irreversible expired-generation marker. Old operation
identities/digests keep conflict protection and never regain effect grants.
Raw audit, outbox and immutable BLOB rows remain retained; these replay windows
do not bound their disk usage. Reads never perform maintenance. There is no
public GC/deletion API; generations never reopen by age.

The reduced codec supports text/reasoning and known finite native settings.
`providerOptions` must be absent or empty. Request-defined headers, files,
URLs/binary, raw/provider-executed parts, stateful continuation, Dispatch or
fallback, native Strands Bedrock, unsupported hooks and unknown codecs refuse
durable opt-in. `doGenerate` is unsupported. Debug request/response envelopes
and provider metadata are omitted on first delivery and replay; warnings are
sanitized identically, and timestamps round-trip as Date values. This is not
full provider fidelity or literal authenticated HTTP byte identity.

The pinned Zod 4.6.7 conversion's direct function-tool `inputSchema` may carry
one exact non-enumerable `~standard` sidecar. Only its admitted data-descriptor
shape is excluded; every enumerable schema value remains pinned. The codec
never calls its functions, and its vendor label proves no origin or authority.
Other hidden/accessor/symbol fields refuse, including at nested schema paths.

Package tests use genuine native framework construction with scripted transports,
the actual SQLite BLOB/journal/sink, the public generic Monument crash store,
and separate SIGKILL body controls. They do not qualify live provider behavior,
Station FileMemory, `/chat`, approvals, boot recovery, terminal custody,
capability profiles, performance or release. See [CONTEXT.md](CONTEXT.md) for
owners and [ADR 0005](../../docs/adr/0005-require-a-second-consumer-before-extraction.md)
for the package boundary.

First native dispatch compares the complete supported tool/schema order and
sampling/configuration template with the retained entry, including known
framework defaults. Volt tool schemas use the same pinned public Zod/AI SDK
conversion as the real constructor. Fresh admission, selected implementation,
writer generation and cancellation are checked after the final body-read await
at the provider call. Staged memory owns detached commands/results and private
participant views, then reauthorizes after asynchronous body validation. Staged memory
copies each resolved body before validation or another await, so later reader
mutation cannot replace previously verified bytes.

Admission always uses private retained entry bytes. The exposed `entryBytes`
array is a detached presentation copy; mutating it changes no authorization or
native request. Startup and restore check the copied entry bytes against their
length and digest; startup retains that copy across journal admission. The
coordinator also verifies and copies request and replay bytes against the
pinned or recorded body reference's length and digest before decoding them.
Before dispatch it also binds the verified request bytes to the admitted input.
Completed replay rechecks current binding, writer, model and
cancellation after its last body-read await, before releasing a native part.
Receipt validation correlates canonical generation/operation identity, legal
command/result variants and owning pin/attempt/tape links. Historical receipts
remain valid across later ownership/revision changes, while settled full answers
expire at the replay cutoff even when unacknowledged projections prevent
compaction. Authorized projection draining remains available after that cutoff.
