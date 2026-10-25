# Model runtime context

This experimental model-only package owns pinned framework entry/request bytes,
one-shot dispatch grants, completed normalized tapes, aborted partial audit,
and output projection readiness. Station remains a future consumer. It imports
only public Monument contracts and pinned optional framework APIs.

`types.ts` owns the model protocol. `decisions.ts` owns transitions, revision
fences, receipts and stable projection identity. `receipts.ts` correlates
canonical operation/generation rows and historical command answers with their
own pins/attempts/tapes; it never reconstructs an execution grant. `memory.ts` stages changes;
`sqlite.ts` owns real host-connection transactions, immutable BLOBs, namespace
validation, the scoped projection sink and explicit whole-store audit. `retention.ts` owns exact-generation settled
replay compaction, tombstones and irreversible expired markers; raw audit and
BLOBs remain retained. Replay admission expires independently of compaction
eligibility. `codecs.ts` owns fixed entry/request/part/tape
validation and the bounded Zod non-wire sidecar interpretation. `coordinator.ts`
owns private invocation bindings, grant consumption, backpressure, held suffix,
fatal latch and explicit cancellation. The framework entries create actual
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
Station transcript/boot adoption, publication, and live provider fidelity remain
outside this package cut. A completed model tape is never tool execution or
whole-Conversation completion authority.

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
an already-open handle from new admission when unrelated settled headers become damaged, including suspect
membership above 128. Current-run duplicate/mispaired/noncanonical numeric header
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
