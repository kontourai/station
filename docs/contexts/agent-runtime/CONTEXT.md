# Agent Runtime Context

This area owns how Station starts, observes, continues, and stops agent work.
The [glossary](../../glossary.md) owns product vocabulary; the
[Session API](../../reference/session-api.md) owns request details.

## Identities and ownership

An Agent is a working identity. Its engine executes it. Station's engine uses
Model connections; external engines own their agent loop. The reserved Agent
named Station can use a separately selected capable engine. An engine name,
Agent name, and transport name are not interchangeable.

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
| Admit a turn without replaying an uncertain effect | [Session execution coordinator](../../../src-server/services/orchestration/session-execution-coordinator.ts) and [durable invocation boundary](../../../src-server/services/orchestration/session-turn-boundary.ts) | Client-turn deduplication, provider acceptance, lifecycle exclusion, and retained uncertainty |
| Record and read history | [EventStore](../../../src-server/services/orchestration/event-store.ts) | Persisted events, projections, and replay |
| Change Session lifecycle | [SessionLifecycleModule](../../../src-server/services/orchestration/session-lifecycle-module.ts) | Transition ownership and concurrency with a new turn |
| Attach an optional Flow run | [Flow policy owner](../../../src-server/services/orchestration/flow-policy-sidecar.ts) | Explicit `metadata.flowDefinition`, eligible definition, evidence, and completion verdict |

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

## Review a change

Follow the caller into the owning module and its tests. Check response loss,
restart, cancellation, and stale-provider outcomes before calling a start or
continuation successful. Use the [module map](../../architecture/module-map.md)
for focused evidence. Real-engine compatibility and device delivery require
their own observations; fixture tests do not establish either.
