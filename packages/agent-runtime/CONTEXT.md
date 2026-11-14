# Model runtime context

This experimental package has separate model-only and agent-turn protocols.
The model-only protocol owns pinned framework entry/request bytes, one-shot
dispatch grants, completed normalized tapes, aborted partial audit and output
projection readiness. Station consumes the separately versioned agent-turn
protocol behind an off-by-default preview. The package imports only public
Monument contracts and pinned optional framework APIs.

`types.ts` owns the model protocol. `decisions.ts` owns transitions, revision
fences, receipts and stable projection identity. `receipts.ts` correlates
canonical operation/generation rows and historical command answers with their
own pins/attempts/tapes; it never reconstructs an execution grant. `memory.ts`
stages changes and copies each resolved body before validation or another await;
`sqlite.ts` owns real host-connection transactions, immutable BLOBs, namespace
validation, the scoped projection sink and explicit whole-store audit. `retention.ts` owns exact-generation settled
replay compaction, tombstones and irreversible expired markers; raw audit and
BLOBs remain retained. Replay admission expires independently of compaction
eligibility. `codecs.ts` owns fixed entry/request/part/tape
validation and the bounded Zod non-wire sidecar interpretation. `coordinator.ts`
owns private invocation bindings, verified byte custody for entries, pinned
requests and completed replay tapes, grant consumption, backpressure, held
suffix, fatal latch and explicit cancellation. The framework entries create actual
native Agents; neither entry replaces the native loop.

Primary evidence owners are `src/__tests__/journal.test.ts` (typed generic crash
port, receipts, rollback and projection), `bodies.test.ts` (actual SQLite body
and transaction faults), `stream.test.ts` (barriers, normalization, binding,
cancellation and codec refusals), `frameworks.test.ts` (real Volt/Strands callers,
retained composition, actual callback denial and subsequent ready-view prompt),
and `body-process.test.ts` (SIGKILL before/after BLOB COMMIT). The `r1-*` owners
cover detached memory custody, complete native templates, current admission,
public cancellation/races, inert descriptor validation, finite multi-page
outbox windows, retention rollback and native binding/registration negatives. Simulated crash,
disk reopen, process death, framework integration and provider qualification
remain different evidence tiers.

The public Monument testing helper is shared with existing kernel callers.
Preserve its forwarding port across reopen, captured incarnation for old
in-flight calls, hold before writes, appended real failure participant and
nonobserved read behavior. `KernelAtomicProtocol` changes type representation,
not kernel decisions or transaction meaning.

Tools, approval recovery, affinity creation/forking, host terminal integration,
Station transcript/boot adoption, publication and live provider fidelity remain
outside the model-only protocol. The agent-turn protocol below has its own
Station integration and evidence. A completed model tape is never tool execution
or whole-Conversation completion authority.

The `r2-*` owners cover private-entry admission after a held final request read,
current authority/cancellation before held replay release, expired saved full
answers while projection authority lags, and malformed operation/foreign-tape
receipt links between real SQLite generations. Public entry bytes are an
observable copy; current admission and framework construction use private bytes.

`r3-ready.test.ts` owns direct ready-read admission: two real completed SQLite
runs, distinct or identical per-run request/attempt headers, one foreign tape
reference substitution, unchanged journal/projection/BLOB authority and exact
restoration. The owning completed marker/body relation and native header/prefix
are checked in the same authorized read snapshot before returning ready.

`r4-replay.test.ts` owns pre-settlement journal/recovery admission. Actual valid
same-header tapes in two runs cannot replace an owning completed attempt's tape
without matching its exact committed projection. The relation is shared with
ready reads; ordinary journal replay requires no sink acknowledgment/application.
The owner exercises real restored Volt replay, historical execute acknowledgment,
unchanged authority on refusal and exact disposable-DB restoration, including
only the attempted receipt side effect of the deliberately buggy baseline.

`scoped-validation.test.ts` owns M1 affected-run validation, unresolved open and
recovery checks, binary receipt/projection routing, selected-row callback
rollback, global occupancy/capacity across two connections, and the public
offline audit. Ordinary commands do not validate unrelated settled history;
the audit checks all logical rows, applied rows and orphan BLOBs. The per-run
JSON/link validators remain fresh on each command. `sqlite-compatibility.test.ts`
uses immutable pre-M1 source in a scratch runner to exercise already-open and
fresh old reader/writer wrappers against the additive index, preserving existing
application row bytes during index creation. This is local format evidence,
not registry, deployment, native-provider or performance qualification.

`r2-receipts.test.ts` distinguishes malformed receipts selected for the current
run from identities moved outside its canonical range. Selected damage refuses;
out-of-range damage is found by the explicit audit, and a stale retry cannot
remint the existing attempt. The source scope change does not qualify the parked
owned-connection or normalization experiments or supply Station adoption.

`scoped-review.test.ts` owns the independent M1 R1 repair counterexamples:
reopen/recovery/drain under a reduced session cap, callback changes to other
unresolved control rows, header interpretation, physical identity enumeration,
incomplete/truncated diagnostics and the selected-state error. The offline
`scoped-index-audit.test.ts` creates an actual index/table disagreement through
a hostile peer SQLite function, then checks raw/index membership and audit
refusal. Storage opening retains the absolute supported maximum and new
admission applies the lower session cap; ordinary callback controls compare the
full physical index-ID membership without parsing unrelated payloads or imposing
a new progress cap on preexisting suspect rows. These owners add no performance
qualification. The compatibility owner explicitly skips with a
NOT VERIFIED prerequisite explanation when immutable Git sources are absent;
an available immutable implementation must still execute successfully.

The R2 cases in `scoped-review.test.ts` distinguish ongoing finish/ACK/drain on
an already-open handle from new admission when unrelated settled headers become
damaged, including suspect membership above 128. Current-run duplicate/mispaired/noncanonical numeric header
refusals are exercised at execute, and removal of the current load's header check
fails those assertions. Actual callback membership insert/remove controls remain.
Offline status reports detected damage independently of enumeration completeness;
per-key retired relationships remain checked after removal of the redundant global
pass. Compatibility Git probes, extraction and runner children disable lazy fetch;
absence remains a named NOT VERIFIED skip, not a compatibility pass. The
compatibility owner conservatively requires Git 2.50+ before object inspection
and forbids transports in its child environment; older or unrecognized Git is
also a named prerequisite skip. This is not a claim about the first Git release
supporting those settings.

The R3 companions pin exact new-admission and reopen refusal classes while S
remains damaged, then successful reopen after original-row restoration.
`scoped-index-audit.test.ts` also exercises unchanged stale current-R physical
membership through an observed read/commit and refused write, plus real SQLite
engine errors from byte-damaged copies of a public-created database and exact
file restoration. Native CORRUPT/NOTADB classification remains separate from
operationally unavailable SQL and incomplete enumeration. These are local owner
checks at their source pins; independent delta review and workload admission
remain separate. Strict new admission parses all selected active payloads;
these checks establish no active-set cost or physical table-page I/O proof.

The current agent-turn writer is `agent-steps/12`. It retains cancellation requests,
terminal timestamps and journaled transport frames without replacing the older
model journal. Station's off-by-default durable preview consumes the root contract and explicit `/internal` integration entry
at its real framework/model/tool/approval boundaries. Its native adapter suite
is `src-server/runtime/agents/__tests__/durable-agent-conformance.test.ts`;
`chat-primary-stream.durable-disconnect.test.ts` owns the route handoff control.
These local scripted boundaries do not establish provider or release qualification.

Writer 7 retains immutable payload bodies behind indexed effect headers. The owner retains a connection with peer/local/schema change detection; prefix commits batch at 16 ms, 64 KiB or 128 parts. New durable approval waits default to ten minutes and accept `STATION_DURABLE_APPROVAL_TIMEOUT_MS`; recorded deadlines do not change on restart.

Writer 8 adds immutable effect/approval change tracking and per-turn validation cursors. It validates changed records and cross-links without decoding unchanged history, while schema changes and recovery keep full validation. A cursor for one turn never acknowledges another turn’s unchecked writes.

Writer 9 groups partial wire values into immutable bodies of at most 128 entries. Its migration preserves logical partial/input/result bytes and existing turn records while rewriting effect control headers to physical version 2. Previous body rows remain retained. The old writer refuses the new metadata.

Historically, writer 10 stored only complete 128-entry partial groups as immutable bodies. An in-progress tail of at most 127 wire values is overwritten in its effect header and checked against its digest. The model stream flush limit is **1024 parts**, 64 KiB or 16 ms; writer-12 physical version 5 uses 1024-entry groups and compressed tails of at most 1023 entries, while older groups remain readable. The separate foreground frame transaction limit is **1024 frames**, 64 KiB or 16 ms. These are different limits.

Large request/result bodies share immutable fragments of at most 16,384 UTF-16 code units behind a physical `agent-body/2` descriptor. The reconstructed logical wire keeps its original digest and byte length, including Unicode across fragment boundaries. Migration validates the frozen writer-9 schema and records before creating the chunk table and physical version-3 effect headers. Existing bodies and turn records remain retained; migration does not reclaim historical garbage.

Change tracking keeps the newest receipt for every turn/kind/id. While full turn replay is retained, a receipt can be deleted only when a newer receipt for that same key exists. Terminal-turn expiry removes receipts only after its refusing terminal tombstone is recorded. Sequence numbers never decrease, and any connection whose cursor predates a change still sees the newer receipt. The final receipt remains protected until that terminal-turn expiry transition. Pure custom clocks take the incremental path; clock callbacks that write rows are refused and rolled back.

The chat projection commits bounded batches before displaying any frame. Each frame keeps its own ID, wire and position; transaction grouping does not merge identities. Control events share ordered batches with text; error and terminal events flush pending output first, and cleanup waits for both the publication drain and owner completion. The frame ceiling is 1,048,576 per turn, leaving margin above the default 200-step workload at 400 chunks per answer. Text processing retains provider chunk boundaries. New turns record `input-chunks/1`; recovery of older descriptors retains their original character-frame layout.

The benchmark counts quiescent home bytes before its read-only table inspection creates diagnostic sidecars; those sidecar bytes are reported separately. The benchmark includes the actual in-process chat/SSE route and `projectFrame`/`projectFrameBatch`, with 0, 5 and 20 ms token pacing. It reports total home bytes divided by emitted text bytes, journal/body/frame bytes, transient WAL peak, elapsed ratio, command and amortized projection costs, and event-loop stall. The fresh-journal workload budget is 128 KiB fixed + 16 KiB per model step + three times emitted text bytes; immutable body storage has a separate 8 KiB per-step + twice-text budget. The 4-byte-delta option and per-table/index `dbstat` breakdown measure small-delta overhead separately. These allowances include indexed frame/change metadata; they are not a claim that total disk usage is twice text, or that retained raw disk is bounded. TCP and the outer EventStore relay remain outside this benchmark. SDK tracing stays active; fixture traces and garbage are cleared between measurements, never within a measured turn.

The opt-in agent-turn writer uses packed delta/frame blocks and shared native text while retaining logical frame and provider chunk boundaries. Writer 12 tracks typed body references under a private connection permit. Indexed expiry/garbage queues drain in bounded idle callbacks after admission or settlement, pausing while any turn is running. FULL SQLite commits remain synchronous, so the cooperative work budget is not a hard wall-clock guarantee. Every terminal state retains replay for seven days, then a compact identity tombstone synthesizes the refusing expiry frames. Uncertain nonterminal turns retain their evidence. See the private package README for migration, work budgets, typed corruption/capacity and real-stream steer replay contracts.


`turn-retention.test.ts` owns batched-setup row fidelity and the ordinary 10×80
backlog; `turn-retention.process.test.ts` owns the process-heavy 60×80 case.
Their shared fixture separates seed/drain timing, cold-audits setup, and runs
expiry through real idle retention. Fixture batching adds no production
transaction or crash-durability qualification.
