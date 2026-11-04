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
takes `/chat` follow-ups and conversation-inbox entries. It keeps its native
transcript, and runs where the Project's workspace isolation says (below).

An engine start naming no Agent, an unknown or unavailable Agent, an engine
that is not ready, a model that cannot launch, a provider other than the
Agent's engine, a directory other than the Project's, or a Task worktree that
cannot be prepared is refused as `failed` with nothing written; none of these can leave the Task `indeterminate`. So is a
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

## Workspace isolation

A dispatch resolves the Project's workspace isolation as a foreground start
does: the Project's choice, then this Station's default, then `shared`
([#4507](https://github.com/kontourai/station/issues/4507)). A `shared`
Project's Session runs in the Project's working directory, in the shared
checkout, and records `{ mode: 'shared' }`, as before.

For `worktree`, each Task has one worktree of its own, recorded on the Task
as `TaskRecord.taskWorktree` (owner `{ kind: 'task', taskId }`). Its path and
branch are derived from the Task (`station/task/task-<id>-<digest>` unless the
policy names a branch prefix), so every Session of the Task (a re-dispatch, a
retry, a lead wake or `/chat` follow-up) runs in the same checkout. The
remote-sessions Adapter's `prepare` provisions it after resolving the Agent:
inside the dispatch deadline, before the reservation, any claim or any
provider effect. A Task that already records a worktree reuses it once git
confirms it is still registered on its branch; a registered worktree at the
Task's derived path and branch that the Task does not record yet is adopted;
otherwise one is created from a clean Project checkout. A provisioning failure
is a `failed` dispatch and nothing starts. The start moves to the worktree
path and records it as `worktree` with `{ mode: 'worktree' }` isolation; the
session service admits that directory through the process-local execution
workspace binding, verified against git and the owning Task. The Task's
`workspaceBinding` stays the Project checkout it was created against, so the
Task view's availability is unchanged.

Custody: provisioning and recording run in one per-Task queue, and creation
runs one at a time per repository, so concurrent dispatches of one Task share
one checkout and dispatches of different Tasks never refuse each other. The
record is written when provisioning finishes, not when the dispatch stops
waiting: a dispatch that times out or is aborted during provisioning returns
`aborted`, and the checkout that finishes later is still the Task's, reused by
its next dispatch. If the Task finished or was removed in the meantime, the
late checkout is finalized at once. A Station that stops between `worktree
add` and the record leaves a checkout at the Task's derived path, which the
next dispatch adopts.

A Session exit never finalizes a Task-owned worktree. Moving the Task to
`done` (by status change or close-on-merge) finalizes it per
`cleanupOnCompletion` (default: remove the worktree and its branch, then
forget the record). Moving it to `canceled` takes the failure branch:
`preserveOnFailure` (default true) keeps the worktree, its branch and the
record. Finalization is best effort after the transition; a failure is logged
and the record kept. It does not wait for a still-running Session.

Not covered: a setup command for a new checkout
([#3759](https://github.com/kontourai/station/issues/3759)) would run in
`prepare` after provisioning and before the start; none runs today. Custody is
in-process; another Station process on the same home relies on git refusing a
second checkout of the same branch and on adoption. Task dispatch is local, so
the [remote execution-preparation](remote-execution-preparation.md) refusal
for worktree-isolated receivers is unchanged.
