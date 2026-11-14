# Agent Runtime Context

This area owns how Station starts, observes, continues, and stops agent work.
The [glossary](../../glossary.md) owns product vocabulary; the
[Session API](../../reference/session-api.md) owns request details.

## Identities and ownership

An Agent is a working identity. Its engine executes it. Station's engine uses
Model connections; external engines own their agent loop. The reserved Agent
named Station Assistant can use a separately selected capable engine. An engine
name, Agent name, and transport name are not interchangeable.

Default Agents are persisted by the [Agent registry](../../../src-server/domain/agent-registry.ts).
Startup can adopt detected native CLIs; a deliberate removal is retained so
detection cannot undo it. Disabled and unavailable engines keep their Agent
records. Do not recreate the retired synthetic “virtual agent” model.

Prompt, skill, and MCP delivery varies by engine. Read the
[capability matrix](../../../packages/contracts/src/engine-capability-matrix.ts)
and [tool-policy delivery](../../conformance/tool-policy-delivery.md).
An external engine can receive supported Station context without giving
Station ownership of its native loop or every tool it executes.

## Follow one execution

| Step | Owner | What to inspect |
| --- | --- | --- |
| Select and resolve an Agent | [Runtime Agent registry](../../../src-server/runtime/agents/runtime-agent-registry.ts) | Identity, current engine binding, and availability |
| Start a Session | [SessionCommandModule](../../../src-server/services/orchestration/session-command-module.ts) | Start/reattach sequencing, command receipt durability, and uncertain provider creation |
| Invoke an engine and compose services | [OrchestrationService](../../../src-server/services/orchestration/orchestration-service.ts) | Real provider caller and its cancellation path |
| Admit a turn without replaying an uncertain effect | [Session execution coordinator](../../../src-server/services/orchestration/session-execution-coordinator.ts) and [durable invocation boundary](../../../packages/monument/src/session-boundary.ts) | Client-turn deduplication, provider acceptance, lifecycle exclusion, and retained uncertainty |
| Record and read history | [EventStore](../../../src-server/services/orchestration/event-store.ts) | Persisted events, projections, and replay |
| Change Session lifecycle | [SessionLifecycleModule](../../../src-server/services/orchestration/session-lifecycle-module.ts) | Transition ownership and concurrency with a new turn |
| Attach an optional Flow run | [Flow policy owner](../../../src-server/services/orchestration/flow-policy-sidecar.ts) | Explicit `metadata.flowDefinition`, eligible definition, evidence, and completion verdict |

All automatic recovery, including same-account replay, waits for startup reconciliation. An unreadable scan or unresolved obligation blocks admission across connections until reconciliation succeeds. The start of an outage, a change in its blocking reason, and restored readiness each produce one warning; refusal metrics use bounded reasons, and recovery status projects the blocked admission and next check. Automatic admission retries back off from 60 seconds to a 10-minute cap; due-claim scans retain their independent retry. See the [recovery module](../../architecture/module-map.md#credentialrecoverymodule).

A Session can contain several turns. `idle` means a finished turn between
messages; `completed` closes the Session. Stopped, terminal, and resumable have
different meanings. The [lifecycle contract](../../../packages/contracts/src/session-lifecycle.ts)
owns those predicates and transitions. Preserve that distinction in UI,
approvals, retry logic, and completion reporting.

A conversation can outlive one execution Session. Continuation normally reuses
an at-rest Session; a terminal Session, ended/error engine binding, unsupported
per-turn model switch, or explicit handoff can require a reserved successor.
The [lineage owner](../../../src-server/services/orchestration/conversation-session-lineage.ts)
records that relationship. Reserving a child does not prove its engine started.
Compatible built-in returns can resume an earlier native identity with bounded
intervening context. Durable native ownership prevents old Session aliases from
mutating the transferred thread, and transfer requires confirmed retirement.
An ordinary follow-up after a native return also requires observed completion
of its seed-bearing turn. Failed or uncertain catch-up explicitly refuses the
follow-up instead of silently continuing without that context.
New history-seeded continuations and saved forks follow the same completion
fence, except that a definitively failed or stopped seed turn of an ordinary
(non-native-return) handoff or plain continuation is redelivered by a fresh
successor with a new full seed rather than refused. Known native identities are captured with the prepared invocation. A
first identity learned during the turn must come from its correlated engine
completion, never a later mutable carrier binding; a conflicting report cannot
qualify the seed. A carrier rebind cannot borrow another identity's completion.
The handoff fence runs synchronously again at provider dispatch, including
prepared-turn resumption, after any awaited continuation preparation.
A context-projection failure
retains the canonical terminal and leaves delivery unverified. Opening an owned
saved fork reports `fork-ready` before any provider Session exists.
Provider handoffs retain the Conversation; explicit forks create a new one.
The compact history contract reports these boundaries to tool and SDK callers.
A model change on a Session that never ran a turn stops that predecessor's engine
once the successor has started. The stop runs detached, so it neither delays
nor fails the send. It is decided again when it runs, under the Session's
lifecycle lock: a Session with turn facts, a dispatched or active turn, or that
is again the conversation's current Session is not stopped, so a turn accepted
first wins. A send that has resolved the predecessor but not yet dispatched is
not visible to that check.

Keep the records distinct: a Task records durable work; a command receipt records
acceptance and its durability; a provider boundary records possible execution;
canonical events record what Station observed. A successful command or completed
turn does not by itself prove a Task or review passed. Start failure can occur
after engine creation or during later binding work, and an indeterminate start may have no returned
Session object. Inspect the recorded state before deciding whether to retry.

Delegation carries parent identity, depth, tool restrictions, and approval policy.
Which restrictions reach the engine depends on its capability and tool-policy
delivery contracts; carrying metadata is not proof that every native tool is gated.
Workspace isolation chooses a shared directory or Git worktree; it is not a
substitute for execution permissions. A Flow Agents sidecar records process
state, not the Session transcript or an independent proof of completion.

[Session groups](../../../src-server/services/orchestration/cli-session-group.ts)
retain bounded member identities, logical start reservations and observations
under the current Station credential. Published Flow owns readiness, claims and
joins. A dependent requires provider-proven completion of the exact accepted
initial turn; an absent or `other` finish reason cannot establish it. A later
turn in the same conversation does not change that initial-turn identity.
Dollar/token/physical-attempt guarantees remain unavailable and portable Flow
lineage remains unbound on this path.

Context sync reserves bounded logical attempts before resuming the retained
conversation. Its server-owned activation capability reaches the qualified
Claude launch and send boundaries; ordinary dispatch cannot join that restricted
activation. Exact ACK receipts record received context, not accepted work.
Unsupported engines refuse before a sync attempt, and uncertain effects retain
their hold. This is model-tool restriction, not an OS sandbox or proof that
startup hooks and autonomous effects are suppressed. The
[API contract](../../reference/api.md#cli-session-groups) owns the current bounds
and supported runtime.

The separate [Station-owned report candidate](../../../src-server/services/orchestration/station-report-group-runtime.ts)
uses published Flow rounds and V3 authority with sealed SDK requests, retained
source identity and inference accounting. A returning context operation must
attach to the original live Session; signed turn custody cannot recreate or
rebind that activation. Unknown usage retains its allocation, and cancellation
without exact delivery evidence stays pending. This is separate from the CLI
session-group path above. Positive sync allowances adopt the published
`initial-request` policy, and controlled tests exercise a fresh exact ACK on
the same Session. Full returning-request serving, funded answer-informed
follow-up and live qualification remain open. Source controls do not establish provider, native or
device acceptance; the [report-group API](../../reference/api.md#report-groups)
records the current candidate and its limits.
Metadata-only continuation finalization is currently unavailable and its preview
is not offered. The [publication owner](../../../src-server/services/orchestration/report-rounds-publication.ts)
binds Flow's exact parent lease to operation-owned Home custody. Transaction
facades borrow that lease; fresh Home scopes serve the preliminary and final
metadata reads. Failed cleanup remains owned until a retry confirms release.
The runtime qualification guard remains false. Installed Flow winner
authentication does not establish Station serving readiness.

### Sealed-source Sessions

Fixed SDK report execution is distinct from the ordinary managed framework loop,
even though both use `station-agent`. The summary reader selects the sealed
policy from canonical `session.started` metadata with a known mode and source
digest. A later unmarked reattach does not erase that recorded mode. A resume
cursor is not mode authority; malformed declarations stay restrictive.

The sealed profile declares no steering, crash continuation, native tool replay
or restart recovery of live input registration. Steer and Queue are not another
source-admission path. Fresh effectful Inbox submissions are refused with
`sealed_source_admission_required` before a durable row; display notes remain
separate. The central Inbox owner preserves accepted retries and rechecks entries
that would become fresh work. Public sealed-Session replay remains subject to
its producer checks and is not established by that central-owner guarantee.

Boot excludes these Sessions from the managed durable recovery owner before it
can claim them. Ordinary interrupted-turn projection can close their dead UI
turn without proving a provider outcome or releasing unknown paid usage. Fresh
bounded report/group admission is still required; an interrupted attempt is not
authorization to resend it.

## Review a change

Follow the caller into the owning module and its tests. Check response loss,
restart, cancellation, and stale-provider outcomes before calling a start or
continuation successful. Use the [module map](../../architecture/module-map.md)
for focused evidence. Real-engine compatibility and device delivery require
their own observations; fixture tests do not establish either.

## Experimental model durability package

[`@kontourai/agent-runtime`](../../../packages/agent-runtime/README.md) is a
private experimental workspace consumer of public Monument contracts. Its
model-only journal and real SQLite BLOB/projection adapters retain effective
framework entry/request bytes, fence proven-dead recovery and withhold native
success/tool-enabling output until completion commits. Its helpers construct
real VoltAgent and Strands VercelModel consumers with scripted-transport
conformance owners in the package. Actual tool bodies refuse and block the run. A drain applies its finite initial
outbox window across pages. Under the default policy, full settled replay expires
seven days after settlement. Callers may configure shorter replay and tombstone
windows, with replay retention no longer than tombstone retention.
Eligible records compact only on an authorized write to that exact generation,
after every required journal disposition is acknowledged and applied by the
SQLite sink. Default tombstone protection lasts thirty days from the same settlement time,
followed by an irreversible expired-generation marker. Raw audit and BLOB rows remain retained; the replay
windows do not establish bounded disk usage. Current host authorization and
callback quiescence still govern effects and explicit cancellation.

Station also adopts the root's separately versioned agent-turn journal behind
the off-by-default **Crash-durable Station Agent** preview. The
[owner](../../../src-server/runtime/agents/durable-agent-owner.ts) fences
recovery; [recovery composition](../../../src-server/runtime/agents/durable-agent-recovery.ts)
reinstates current Session authorization, native authority, approval wait and
stream projection around the actual framework loop. Both adapters journal tool
intent and replay safety and consume completed model/tool tapes. Uncertain
model dispatch blocks automatic resend. Disconnect hands delivery and cleanup
to the owner; explicit Stop cancels. Terminal publication uses the recorded
invocation and event identity, including a crash between settlement and
publication. Approval deadlines remain absolute. New durable waits default to ten minutes; `STATION_DURABLE_APPROVAL_TIMEOUT_MS` configures new waits without renewing existing ones. New approval IDs include durable-turn
scope; legacy IDs remain attached to their recorded tool. Registry replies and
cancellations must match that pending Session. Publication consumes the actual
committed decision identity, including when an older ID is restored.

The package's older model-only consumer helpers retain their conservative
tool refusal. The new Station adapter conformance exercises actual native loops
with a scripted provider, separately from those helpers. It is not live-provider,
physical-crash, cache-benefit or release qualification. Text input is the preview's
supported admission form; unavailable configuration holds recovery.


The opt-in agent-turn writer uses packed delta/frame blocks and shared native text while retaining logical frame and provider chunk boundaries. Writer 12 tracks typed body references under a private connection permit. Indexed expiry/garbage queues drain in bounded idle callbacks after admission or settlement, pausing while any turn is running. FULL SQLite commits remain synchronous, so the cooperative work budget is not a hard wall-clock guarantee. Every terminal state retains replay for seven days, then a compact identity tombstone synthesizes the refusing expiry frames. Uncertain nonterminal turns retain their evidence. See the private package README for migration, work budgets, typed corruption/capacity and real-stream steer replay contracts.
