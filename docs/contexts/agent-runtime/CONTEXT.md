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
| Admit a command | [SessionCommandModule](../../../src-server/services/orchestration/session-command-module.ts) | Accepted, rejected, failed, and indeterminate outcomes |
| Invoke an engine and compose services | [OrchestrationService](../../../src-server/services/orchestration/orchestration-service.ts) | Real provider caller and its cancellation path |
| Record and read history | [EventStore](../../../src-server/services/orchestration/event-store.ts) | Persisted events, projections, and replay |
| Change Session lifecycle | [SessionLifecycleModule](../../../src-server/services/orchestration/session-lifecycle-module.ts) | Transition ownership and concurrency with a new turn |
| Attach an optional Flow run | [Flow policy owner](../../../src-server/services/orchestration/flow-policy-sidecar.ts) | Explicit `metadata.flowDefinition`, eligible definition, evidence, and completion verdict |

A Session can contain several turns. `idle` means a finished turn between
messages; `completed` closes the Session. Stopped, terminal, and resumable have
different meanings. The [lifecycle contract](../../../packages/contracts/src/session-lifecycle.ts)
owns those predicates and transitions. Preserve that distinction in UI,
approvals, retry logic, and completion reporting.

Delegation carries parent identity, depth, tool restrictions, and approvals.
Workspace isolation chooses a shared directory or Git worktree; it is not a
substitute for execution permissions. A Flow Agents sidecar records process
state, not the Session transcript or an independent proof of completion.

## Review a change

Follow the caller into the owning module and its tests. Check response loss,
restart, cancellation, and stale-provider outcomes before calling a start or
continuation successful. Use the [module map](../../architecture/module-map.md)
for focused evidence. Real-engine compatibility and device delivery require
their own observations; fixture tests do not establish either.
