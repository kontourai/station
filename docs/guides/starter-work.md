# How Starter Work connects first steps to real work

Starter Work is the small set of first-use actions offered by Home and the
attached-session view. Each action points to an ordinary Task, Session,
approval, review receipt, or Scheduler run. It does not create another work
system or treat completing a tutorial as proof that work passed a gate.

The catalog and launch behavior are owned by
[`StarterRegistry`](../../src-server/services/starter-work/starter-registry.ts).
The [route](../../src-server/routes/starter-work.ts) validates the request;
[`StarterWorkModule`](../../src-server/services/starter-work/starter-work-module.ts)
keeps the durable correlation. Runtime composition mounts this personal-home
feature only where those owners are available. Hosted tenant execution has no
personal-home Starter route.

New Project's start intent is a separate setup choice. **Documents and
knowledge** and **Connected tools** create a Project without a folder/starter
prompt, then open Sources or Tools. **Repository or folder** keeps the existing
starter recommendation; **Blank Project** may select a layout explicitly. The
creation recovery pointer retains this intent alongside its selected starter.
Neither an intent nor an installed layout is a dispatched Task or readiness proof.
All Starter launch routes require the home’s first-run status to be completed.

The technical behavior below accompanies the shorter
[user instructions](../user/getting-started.md#start-your-first-task).

See the [application walkthrough](../learn/walkthroughs.md#projects-and-tasks) for a captured example and its evidence limits.

## Start Your First Task

When Home offers **Start your first task**, it appears only after the durable
first-run decision is completed and Station has confirmed a real Project. The
action opens that Project's guided Starter, retaining its focused title entry
and saved launch identity. This separate onboarding path does not create a
second Task type. General **New Task** entry points instead
[shape an idea in chat](../reference/station-docs.md#tasks-and-the-task-workspace)
and wait for proposal acceptance without dispatching implementation work.
Submitting the guided Starter calls the Starter launch API with a saved operation identity. The server checks readiness,
creates or retrieves the exact Task idempotently, binds it to the Starter,
then requests the ordinary Task dispatcher once. If the initial readiness check reports the Agent as deferred or
unavailable, Station creates no Task and shows the recoverable readiness reason;
retrying reuses the same project-scoped launch identity. After a launch starts,
a response loss or indeterminate dispatch is **NOT_VERIFIED** — Station never
retries that effect automatically. A replay checks current prerequisites and
readiness before looking up the existing Task and launch record. Once those
checks pass, the same identity returns the saved outcome or an indeterminate
result instead of creating a second Task. If the engine became unavailable
after the original launch, the retry can return a setup problem without the
existing Task reference; restore readiness to retry the launch, or reopen the
already created Task through the Project's Task list. Its Session, run, and receipt
owners remain the source for progress rather than Task status. If correlation
cannot be confirmed, the Task still opens with a retry link; retrying that link
never creates another Task.

1. Open a local project.
2. Create a Task for durable work, or start a direct chat for an immediate
   conversation.
3. For a direct chat, write the request in Home's start composer and use its
   defaults. Change the Agent or project chip only when you want another
   Agent, Model, or workspace.
4. Keep gate state, evidence, route-backs, and receipts with the work as it
   progresses.

The Project’s **Tasks** list shows each local Task’s title, recorded status,
and assigned Agent when known. Select its title or **Open Task** to enter its
Task Room. **Details** opens inspection and dispatch controls; the optional board
continues to group Tasks by status. **Refresh tasks** reads current Task records.
Status is not a percentage complete or proof that an Agent is running. Connected
provider items retain their separate read-only behavior.
The Task workspace opens on **Chat** and makes the viewer present. **Brief** is
the autosaved shared plan; its Goal and checklist appear beside desktop Chat.
**Results** collects kept answers, file outputs and pull requests. **Details**
contains identity, local workspace metadata, Basis, references and inspection.
On narrow screens **About** holds the desktop rail context.

If the workspace is not ready, Station keeps the relevant Connections action
visible. Run `station doctor` for a local diagnosis.


## Continue an Attached Session

Open the terminal Session in **Activity**, where it reads like any chat, then
type a message and press Send. Chat asks once, **Continue here?**,
and **Continue and send** continues it there with that message.
Claude and Codex create independent children, so the original terminal Session
can keep running. Codex starts from the latest completed turn Station has
observed; wait for a completed turn if the message box is unavailable. Station
shows the reason above the message box when the engine or source configuration
is unavailable. The
child always runs in the Session's own folder, checked again at continuation:
a worktree Session continues in its worktree under the Project its repository
belongs to, and a **No project** Session continues as a No project chat
confined to its folder once you confirm that choice, and only in a folder
inside your home folder that Station allows (see
[Continue an Attached Session](../user/getting-started.md#continue-an-attached-session)).

Quick review hands its reply to the Chat reader on the same verified Station
and API; the review does not adopt a Session itself. The reader's pending
delivery is revoked when that Station, API, thread or mounted lifetime changes.
A completed response is not permission to open or send in a later view. The
server's durable continuation and retry identity remain separate from whether
that particular reader is still allowed to present the result.

An attached terminal Session stays read only. The first eligible continuation
launches the bounded `continue-session` Starter: Station
validates the exact source Session, reuses the orchestration adoption ledger
with one stable operation identity, and opens the exact Station-owned child
returned by that owner. Retrying an uncertain response reuses that identity
rather than forking another child. Once the one-time starter is bound, later
continuations use the ordinary owner action and do not overwrite its
correlation. The adoption command receipt is inspectable, but it proves only
that continuation was admitted; useful-work completion remains `NOT_VERIFIED`
until the Session's own evidence says otherwise.
If Station cannot read the one-time correlation state, it starts no
continuation; retry after that read recovers instead of guessing an owner path.


## Inspect Approval And Review Evidence

After first run, Home shows inspection cards when **Developer tools** is enabled
on this Device. An inspection action becomes available when Station identifies a
real approval notification or independent-review receipt. The
approval action opens that exact Notifications row without approving or
denying it. The review action opens the exact Project and receipt tuple in
that Project's Review layout at `/projects/<slug>/layouts/review?receipt=...`.
Another Project's receipt with the same ID is never substituted. Older
`/review-queue?receipt=...&project=...` links redirect there; the global
`/review-queue` page itself was retired in favour of the per-Project layout,
and a link that names no Project opens Notifications instead.

These are one-time Starter correlations, not completion checkboxes. Response
loss reuses a deterministic operation identity, reopening a bound card keeps
the original target, and every later observation reads Approval Inbox or
ReviewEvidence again. Owner observations distinguish missing, stale, unavailable
and `NOT_VERIFIED` states. The current Home card has no distinct label for a
`stale` observation. A reviewed receipt is evidence input only and does not
by itself satisfy a gate.


## Run A Scheduled Readiness Check

After first run, with **Developer tools** enabled on this Device, Home can create
the canonical disabled `station-starter-check` job and run it once through the
Scheduler. The job stays disabled unless you explicitly
enable its daily schedule. Station binds the exact Scheduler run before the
Agent can be invoked, so a lost response or retry opens the same receipt and
never starts another check. If Station restarts after binding but before the
Agent begins, **Resume exact check** reuses the operation identity stored in
that binding; it does not create a replacement run. Failed or indeterminate
checks offer **Inspect receipt**, not automatic retry. A completed check proves
execution only; read
its findings and decide what to do rather than treating completion as a passed
gate.

For example, open a repository as a Project, create a Task named “Update the
documentation,” and choose a ready External agent. That work's first execution
is a Session. Reopen the Task later to see its files, evidence, and receipts
together. For a one-off question that does not need that durable history, use a
direct chat instead.


## Follow the implementation

| Responsibility | Code | Focused evidence |
| --- | --- | --- |
| First-run choice and saving optional answers | [FirstRunHomeChapter](../../src-ui/src/components/first-run/FirstRunHomeChapter.tsx), [AboutYouStep](../../src-ui/src/components/first-run/AboutYouStep.tsx) | [First-run tests](../../src-ui/src/components/first-run/__tests__/FirstRunHomeChapter.test.tsx), [answer tests](../../src-ui/src/components/first-run/__tests__/AboutYouStep.test.tsx) |
| Catalog, readiness, dispatch, and replay | [StarterRegistry](../../src-server/services/starter-work/starter-registry.ts) | [Registry tests](../../src-server/services/starter-work/__tests__/starter-registry.test.ts) |
| Task form, saved retry identity, and exact Task navigation | [ProjectTasksSection](../../src-ui/src/views/project-page/ProjectTasksSection.tsx), [operation store](../../src-ui/src/lib/starter-work-operation-store.ts) | [Task-section tests](../../src-ui/src/__tests__/ProjectTasksSection.test.tsx) |
| Durable one-time binding and operation state | [StarterWorkModule](../../src-server/services/starter-work/starter-work-module.ts) | [Module tests](../../src-server/services/starter-work/__tests__/starter-work-module.test.ts) |
| Continuation through the existing adoption command | [Starter Session owner](../../src-server/services/starter-work/starter-session-owner.ts) | [Session-owner tests](../../src-server/services/starter-work/__tests__/starter-session-owner.test.ts) |
| Approval and review observations | [Owner adapter](../../src-server/services/starter-work/starter-owner-adapter.ts) | [Owner-adapter tests](../../src-server/services/starter-work/__tests__/starter-owner-adapter.test.ts) |
| Input validation and HTTP outcomes | [Starter routes](../../src-server/routes/starter-work.ts) | [Route tests](../../src-server/routes/__tests__/starter-work.routes.test.ts) |

These tests cover local state, caller behavior, and failure handling with test
dependencies. They do not prove a live engine completed useful work or a
particular device displayed it. Follow the exact Task, Session, or Scheduler
receipt for that evidence.
