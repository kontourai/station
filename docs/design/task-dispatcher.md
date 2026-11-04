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

For `worktree`, each Task has one worktree of its own. Its path and branch are
derived from the Task (`station/task/task-<id>-<digest>` unless the policy
names a branch prefix), so every Session of the Task (a re-dispatch, a retry,
a lead wake or `/chat` follow-up) runs in the same checkout. The
remote-sessions Adapter's `prepare` provisions it after resolving the Agent:
inside the dispatch deadline, before the reservation, any claim or any
provider effect. A provisioning failure is a `failed` dispatch and nothing
starts. Creating a worktree requires a clean Project checkout: a Project
whose checkout has uncommitted changes refuses worktree dispatch until they
are committed or removed (the same rule foreground worktree chats follow).

Provisioning is idempotent per Task:

- a recorded worktree that still exists is reused once git confirms it is
  registered on its branch;
- a recorded worktree that is gone (removed by hand, or left behind when the
  repository moved) is provisioned again: the Task's own branch is checked
  out at its derived path, so its committed work comes back. Only that
  branch's registrations whose folders are gone are forgotten; other
  worktrees' records stay, even when their folders are missing for now. A
  branch still checked out in an existing folder elsewhere is refused;
- a registered worktree at the Task's derived path and branch that is not
  recorded yet is adopted;
- otherwise one is created.

The start moves to the worktree path and records it as `worktree` with
`{ mode: 'worktree' }` isolation; the session service admits that directory
through the process-local execution workspace binding, verified against git
and the owning Task. A follow-up after that capability is gone (a Station
restart) admits the worktree only when the conversation's server-written room
execution binding names the same Task.

**Record.** The worktree is recorded in its own home-root file,
`task-worktrees.json` (Station home state, backed up and rolled back with the
task store), keyed by Task id and bound to the Task's `createdAt`. It is not a
field of the Task record: the task store refuses unknown fields, so an older
Station would otherwise fail to read every Task after a downgrade. An entry
that does not validate, including one whose owner names another Task, is
ignored on its own. The Task's `workspaceBinding` stays the Project checkout
it was created against.

A file that cannot be read at all (corrupt, or from a newer Station) reads as
having no entries, so every Task still opens; writes refuse to replace it, so
no dispatch records a worktree until it is repaired. While it is unreadable,
a Task with a worktree at its default derived path is in an unknown state
(`taskWorktreeUnknown` on the opened Task): its working directory is unknown
rather than the Project checkout, so keeping an output, saving a Task output
and browser capture refuse for it. A Task with nothing there is treated as a
Project-checkout Task.

**The Task's working directory.** Readers that compare or read a Task's files
use one helper, `taskWorkingDirectory`: the Task's worktree when it has one,
else the Project working directory. Keeping a Session's declared output or
pull request compares the Session's directory with it, so a worktree Task can
keep its pull request and close on merge. Browser capture and Task output
snapshots read from it. The opened Task shows the worktree in its existing
"Task worktree" and branch rows, and as `taskWorktree`.

**Custody.** In one Station process, provisioning and recording run in a
per-Task queue, so concurrent dispatches of one Task share one checkout, and
Task worktree creation runs one at a time per repository, so dispatches of
different Tasks do not refuse each other on git's shared state. Foreground
worktree chats provision through a separate, unqueued service, and another
Station process on the same home is not serialized with this one; both rely
on git refusing a second checkout of the same branch or path. The record is
written when provisioning finishes, not when the dispatch stops waiting: a
dispatch that times out or is aborted during provisioning returns `aborted`,
and the checkout that finishes later is still the Task's, reused by its next
dispatch. If the Task finished or was removed in the meantime, the late
checkout is finalized at once. A Station that stops between `worktree add` and
the record leaves a checkout at the Task's derived path, which the next
dispatch adopts. Every git command (and repository open) the provisioning
service runs has a deadline, five minutes by default, after which it is
stopped and refused, so one hung command cannot hold either queue.

**Finishing.** A Session exit never finalizes a Task-owned worktree. Moving the
Task to `done` (by status change, a board or repair action, or close-on-merge)
or `canceled` finalizes it after the transition; the status answer never
waits on git. `canceled` takes the failure branch, so `preserveOnFailure`
(default true) keeps it. Otherwise, with `cleanupOnCompletion` (default
true), the worktree and its branch are removed only when nothing would be
lost:

- no Session in the worktree has a running turn;
- the checkout has no uncommitted or untracked change;
- the branch has no commit that no remote-tracking ref or other local branch
  reaches. A squash merge leaves the branch's own commits off the base, so
  "merged" is not the test; being pushed is.

When any of these fails the worktree and branch are kept and the reason is
recorded and shown on the opened Task (`taskWorktree.kept`: `policy`,
`uncommitted`, `unpushed`, `session-running`, `unsafe-config`, or `failed`).
Finalization and recovery run git through Station's judged copy of the
repository's config, as creation does: `status` and a non-forced `worktree
remove` run clean filters, so a repository (or Task worktree) whose own
config names a program git would run, or pulls in configuration from another
file that is refused, keeps the worktree as `unsafe-config` and runs
nothing. The one exception is deleting the branch: `update-ref` runs against
the repository's real git directory (where links need privilege the judged
copy holds a copy of `packed-refs`, so a deletion there could miss the real
branch), with hooks pointed at a folder that does not exist; it runs no
filters. Finalization then checks the branch is gone and reports the
worktree kept (`failed`) if it is not. A
`session-running` deferral is retried when a turn or Session ends, and once
when Station starts (the deferral is recorded with the worktree, so a restart
does not lose it); nothing else re-runs a kept finalization. A Task that
finishes while the worktree store cannot be read has nothing finalized; the
first retry after the store is readable again (a turn or Session ending, or
the next start) finalizes every finished Task whose recorded worktree was
never finalized. If the store is repaired by deleting it, those checkouts
have no record and are left on disk, never removed by a guess. A recorded worktree that is already gone is
forgotten and its branch left alone.

Not covered: a setup command for a new checkout
([#3759](https://github.com/kontourai/station/issues/3759)) would run in
`prepare` after provisioning and before the start; none runs today. The
running-turn check covers turns in this Station process; work done in the
worktree outside Station is seen only through git status. Task dispatch is
local, so the [remote execution-preparation](remote-execution-preparation.md)
refusal for worktree-isolated receivers is unchanged.
