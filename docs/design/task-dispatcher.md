# Task Dispatcher

> **Reading status: current architecture note retaining the original boundary description.**
> The [dispatcher](../../src-server/services/projects/task-dispatcher.ts) and
> [composition](../../src-server/services/projects/task-dispatch-composition.ts)
> are the current owners. Composition now also accepts execution-authority and
> live-work publication inputs alongside the adapters described below; see the
> [Module map](../architecture/module-map.md#taskdispatcher-and-taskgraph).
> This note is not an exhaustive caller, cancellation, or authorization audit.

`TaskDispatcher` owns dispatch through one operation:
`dispatch(taskId, intent)`, returning a `DispatchOutcome` for the modeled
dispatch and recovery outcomes. A missing
task is explicitly `not-found`; contention and terminal lifecycle states are
separate outcomes. Callers learn
neither graph reservation phases, assignment-claim cleanup, provider selection,
nor telemetry ordering.

`composeTaskDispatcher` supplies the owner. `TaskGraphService` provides adapters
for durable graph transitions, assignment claims, remote sessions, telemetry and
execution authority; composition can also supply live-work publication.
The dispatcher orders transactions and compensation; the graph owns durable facts.

Cancellation is part of the Interface. The claim Adapter receives the same
signal and must observe it before external work. If an abort or deadline wins
after claim admission began, even a late successful claim is ownership-unknown,
so the outcome is `indeterminate` and reconciliation—not a blind retry—is
required. Before any external claim has begun, abort returns retryable
`aborted` only after the reservation is durably restored. Once a provider start
request has crossed its Adapter, cancellation or timeout is likewise
`indeterminate`: the remote Implementation may have created a session.

Every confirmed release of a prior assignment claim is persisted immediately.
It is never deferred to a later association write, because that write might not
happen. A failed release or reservation restoration is likewise `indeterminate`,
never presented as retryable success.

A Task dispatch runs as the Task's Agent: the dispatch's `agentId`, else the
Agent the Task records
([#4005](https://github.com/kontourai/station/issues/4005)). The remote-sessions
Adapter resolves it with the same resolver a foreground `/chat` start uses
(`resolveTaskDispatchAgentStart`), within the dispatch deadline and before the
reservation, any assignment claim or any provider effect. A dispatch that names
no provider, such as the project page's Dispatch button, starts the Agent's own
engine and model; a dispatch that names one must name the Agent's engine. The
start records the same Environment and Agent binding as `/chat`, so the Session
takes `/chat` follow-ups and conversation-inbox entries. It runs in the
Project's working directory, in the shared checkout, and keeps its native
transcript.

An engine start naming no Agent, an unknown or unavailable Agent, an engine
that is not ready, a model that cannot launch, a provider other than the
Agent's engine, or a directory other than the Project's is refused as `failed`
with nothing written; none of these can leave the Task `indeterminate`. So is a
start the session service rejected before any provider effect (its receipt is
`rejected`, for example a model that cannot launch or engine start capacity);
any other start failure stays `indeterminate`.

Only a dispatch with no Agent at all, or one that asks for `task-dispatch`,
seeds a `task-dispatch` Session and starts no engine; a seeded dispatch that
names an Agent this Station does not have is refused. External monitors ask
for `task-dispatch`: nothing on the monitor path sends the Task's prompt as a
turn (`MonitorTaskTurnSupervisor` only observes and bounds turns), so a started
engine would sit idle. The board intent and the e2e room control keep their
existing shapes.
