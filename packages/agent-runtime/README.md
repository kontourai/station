# Experimental agent runtime

`@kontourai/agent-runtime` retains model requests and completed native streams
for an authorized generation. The existing VoltAgent or Strands loop continues
to choose model calls. This private workspace package is experimental Tier 1;
it is not a released package. Station adopts its agent-turn protocol behind
the **Crash-durable Station Agent** Feature Preview (off by default).

The root entry exports the twelve model commands, coordinator, staged memory
adapter, fixed policy and ordered outbox drain. `/sqlite` uses a host-supplied
Node 24 `DatabaseSync`. `/ai-sdk`, `/voltagent` and `/strands` bind the pinned
AI SDK v3 interface, VoltAgent 2.10.0 and Strands 1.19.0 VercelModel. Optional
framework dependencies are exact peers. The package imports no Station code.

The public root also exports an agent-turn journal and recovery owner. Its
separate `agent_steps_` namespace declares writer format `agent-steps/5` and
leaves existing `runtime-model/1` records intact. An active conversation has
one owner. Recovery requires a proven-dead owner and compares the complete
observed fence inside the SQLite write transaction. A retained Station turn
boundary grants no execution authority. Station boot calls this owner before
ordinary interrupted-turn settlement. Station registers the actual VoltAgent and Strands stream entry points, tools,
approval waits and provider transports. Disconnect transfers stream and native
turn cleanup to the owner; explicit Stop records cancellation. Recovery waits
for the original agent definition and Session, reauthorizes current access,
then re-enters the framework with its retained history. Changed or unavailable
configuration holds recovery. Only text turns are admitted by this preview.
Writer 5 adds cancellation requests, terminal timestamps and retained transport
frames. It validates exact schemas from writers 1–4, preserves existing record
bytes and adds new tables atomically. Legacy settled rows receive a migration
observation timestamp rather than a reconstructed historical completion time.
The prior writer refuses the new metadata; future writers refuse here too.

`durableLanguageModel` journals calls made inside `AgentTurnLease.run` without
replacing the framework loop. Its completed tapes replay; its committed partials
remain aborted audit data after takeover and never become model context. A
possibly dispatched call becomes indeterminate. A pinned, never-dispatched call
can still run with identical input. Tool-enabling stream parts remain held
until the complete model tape commits.

`lease.tool({ id, input, replay }, execute)` commits intent and a one-use grant
before entering a tool. Recovery replays completed results, retries an interrupted
`safe` call once under the new owner, and returns an interrupted/indeterminate
result for an interrupted `unsafe` call. Concurrent identical calls join the
same local execution. Changed input or a stale owner refuses. Unknown tools
must default to `unsafe` in the host; replay safety is a trusted declaration.

`lease.approval(tool, timeoutMs, wait)` persists a pending request before asking
the host. Its identity and absolute deadline survive takeover. The host receives
that identity and the remaining time when it reinstalls the wait; it must never
substitute an automatic approval. A decision compares the current owner fence
and approval revision, commits once, and cannot grant permission after the
deadline. Pending, denied and expired approvals block the tool execution grant.
Duplicate local waits join one request. A failed decision commit leaves the
request pending, and a dead owner's late answer cannot resolve its successor's
request. Writer 3 adds this table through an explicit atomic migration from
writers 1 and 2 without rewriting their turn or effect records.

Writer 4 adds immutable provider-session identities, one per scope and
conversation. Later turns and takeover retain the identity; forks and children
use new conversation identities and receive fresh ones. The model wrapper's
`affinity` callback maps this opaque identity to the provider's supported options
before pinning the request. It is not an idempotency key and never authorizes
redispatch. Cache-hit behavior still requires provider evidence.

New admission and opening also select suspect active headers. A damaged active
header cannot hide a live run from conversation occupancy. Liveness callbacks
must not mutate the transaction, and participant callbacks cannot change another
run's unresolved membership. `auditSqliteAgentJournal` is a separate, read-only
whole-store diagnostic: it checks all turn/effect/approval records and references,
including settled history, without initializing or migrating a database.

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
After a committed dispatch grant, a lost outcome is indeterminate: recovery
does not grant another dispatch without provider idempotency or result lookup,
which this experimental runtime does not yet implement. A request pinned
without a dispatch grant can still be dispatched after takeover. Every visible prefix part
commits before projection. The ordered suffix beginning with a tool-enabling
part or successful terminal remains held through EOF, strict tape validation,
durable body put and complete COMMIT acknowledgment. Empty-prefix completion
uses `lastPartialSequence: -1`; otherwise it is the last committed sequence.

The legacy model-only consumers refuse tools before their registered body and block the run, even when
the framework catches the refusal. Client-tool responses exercise the model
commit barrier; they do not establish durable tools, results or approvals.
They do not supply the agent-turn tool protocol described above. No new agent
loop is introduced; Station approval delivery remains an integration obligation.

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

Station consumes only the package root; `scripts/agent-runtime-import-boundary-gate.mjs`
checks both directions. Scripted native conformance runs at the real Station
adapters, including tool effect counts, approval recovery and conservative
model dispatch. These tests establish local SQLite and framework behavior;
they do not establish live provider idempotency, cache benefit, operating-system
crash durability or a published runtime release.
