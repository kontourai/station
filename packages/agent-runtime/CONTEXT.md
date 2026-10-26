# Model runtime context

This experimental model-only package owns pinned framework entry/request bytes,
one-shot dispatch grants, completed normalized tapes, aborted partial audit,
and output projection readiness. Station remains a future consumer. It imports
only public Monument contracts and pinned optional framework APIs.

`types.ts` owns the model protocol. `decisions.ts` owns transitions, revision
fences, receipts and stable projection identity. `receipts.ts` correlates
canonical operation/generation rows and historical command answers with their
own pins/attempts/tapes; it never reconstructs an execution grant. `memory.ts`
stages changes and copies each resolved body before validation or another await;
`sqlite.ts` owns real host-connection transactions, immutable BLOBs, namespace
validation and the projection sink. `retention.ts` owns exact-generation settled
replay compaction, tombstones and irreversible expired markers; raw audit and
BLOBs remain retained. Replay admission expires independently of compaction
eligibility. `codecs.ts` owns fixed entry/request/part/tape
validation and the bounded Zod non-wire sidecar interpretation. `coordinator.ts`
owns private invocation bindings, verified entry-byte custody at startup and
restore, grant consumption, backpressure, held suffix, fatal latch and explicit
cancellation. The framework entries create actual
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
