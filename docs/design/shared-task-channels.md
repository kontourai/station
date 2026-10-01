# Shared Task channels

Status: owner-directed delivery program, 2026-09-30. The intended experience
below is a target, not a release claim. [The delivery ledger](../plans/shared-work-delivery.md)
records implemented slices and missing evidence.
Program owner: [#3034](https://github.com/kontourai/station/issues/3034).

## Purpose

A Task is the shared place where a backlog idea becomes an inspectable result.
People discuss it, call agents into the work, decide what to pursue, and review
contributions. The work belongs to the Project and Task rather than a lead
agent's conversation. An ordinary chat remains useful for an immediate request.

Three views read the same work: a Project task board for oversight, a Task
channel for discussion and action, and previews for inspecting a particular
result. Existing personal Boards and Console operating boards keep their own
contracts; a task board does not replace those surfaces.

## User journey

1. Pick an item from a connected backlog or describe an idea. Retain its exact
   source identity; opening an external row does not authorize execution or
   writing back to its tracker.
2. Open the Task channel. A brief holds the objective, questions, constraints,
   and agreed scope. Human discussion can proceed without invoking an agent.
3. Ask a named agent to investigate, propose, build, or review. Show the selected
   context, requester, execution location, limits, and missing prerequisites.
4. Follow visible contributions and decisions. Parallel research may be useful;
   shared file changes require workspace ownership and conflict handling.
5. Inspect a preview, leave feedback bound to that version, and ask for revisions.
6. Review results and evidence. An engine stopping, a Task status of done, a saved
   artifact, and customer acceptance are separate observations.

## Channel interaction

`@agent` is an intentional request, not a trigger hidden in arbitrary prose.
An accessible Ask an agent action offers the same capability. Choosing an agent
does not grant model, tool, compute, or spending authority. Discuss, execute,
and approve remain distinct permissions. An agent request needs a durable
identity and must survive lost acknowledgements without replaying effects.

Typing `@` opens an autocomplete picker scoped to this Project's authorized
agents. Filter by name/role, show readiness and setup reasons, and support arrow
keys, Enter, Escape, touch targets and input-method composition. Selection keeps
the exact agent identity in a removable mention token. Text that merely looks
like a mention is not an execution request. Multiple explicit mentions must
show which work each agent is being asked to do; entering a channel or selecting
a token never starts work. Revalidate Project access, agent identity/readiness
and execution authority at send time. A stale or unavailable selection retains
the draft with a useful recovery action rather than routing to another agent.

Use a compact work card for each request: queued/active/needs-input/settled state,
who requested it, agent, scope, and result. Detailed execution is expandable.
Preserve uncertainty when completion or cancellation cannot be established.
Agents should not respond to every human message or create reply loops.

The shared brief, selected thread, and explicit references establish context.
Private engine transcripts and credentials are not implicitly shared with the
channel or a public audience. Contributors must be able to understand what
context they are sending and what result the agent can return.

## Board and preview

The task board groups recorded canonical Task statuses. It does not infer a
percentage complete from tokens, elapsed time, or agent narration. Later cards
can add observed milestones, active contributions, outstanding decisions, and
preview availability only when an authorized projection establishes them.
Refresh/read failure must remain distinguishable from an empty backlog.

A preview identifies the producing Task, attempt, artifact and exact version.
Feedback retains that identity even when a newer result exists. Previewing
untrusted application output needs an explicit isolation boundary; a URL is
not authority to execute arbitrary code or expose a local server publicly.

## Sharing

Private work, invited collaboration, public viewing, and public proposals are
different modes. Existing Project membership and Task-room capabilities own
invited access. Public viewing must publish a deliberately selected projection
with explicit consent and revocation; it must not expose private transcripts,
tools, paths, secrets, or unpublished artifacts. Public contribution requires
attributable proposals and acceptance, not an anonymous execution grant.

## Existing owners

- [TaskGraph and dispatch](../architecture/module-map.md#taskdispatcher-and-taskgraph)
  own durable Task identity, state, execution admission and relations.
- [Task room](../architecture/module-map.md#projecttaskroom) owns the shared
  document, conversation, presence and versioned changes.
- [TaskRecord](../../packages/contracts/src/task-graph.ts),
  [Project membership](../../packages/contracts/src/project-membership.ts), and
  [shared Task projection](../../packages/contracts/src/project-shared-task.ts)
  keep work, permission and publication contracts separate.
- [Task workspace](../../src-ui/src/views/TaskWorkspaceView.tsx) composes the
  existing panes, recorded answers, outputs and evidence inspection.
- [Project task surface](../../src-ui/src/views/project-page/ProjectTasksSection.tsx)
  owns creation, selection, backlog-provider rows and dispatch controls.
- [Delegation CLI](../reference/cli.md) and ExecutionTarget keep environment,
  agent, workspace and model selection separate from transport and credentials.

Reuse these owners and published sibling-product contracts. Extend a contract
only after the user journey identifies an actual gap.

## Related delivery tracks

Onboarding, managed harness execution, plugins, ongoing responsibilities, model
evaluation and evidence all serve this shared-work journey. A responsibility
should retain its scope, limits and escalation rules across runs; decide whether
it creates Tasks after inspecting the existing Scheduler rather than making a
second scheduler. A specialist offer remains separate from package identity,
execution authority and billing settlement.

OpenAI DevDay is inspiration and an integration opportunity, not proof of
Station compatibility. Assess ChatGPT-plan eligibility, managed Agents API
session/data boundaries, plugin distribution and MCP Events against current
official contracts. Cloud computer use, security scanning and collaborative
artifacts should be evaluated on useful work, intervention, recovery and cost.

## Acceptance

Use a connected backlog item with two distinct human identities and multiple
agents. Demonstrate investigation, a revised brief, a decision, implementation,
independent review, version-bound preview feedback and an accepted result.
Repeat at narrow widths and with keyboard interaction. Include lost response,
restart, revoked membership, unavailable agent, conflicting edits, stale preview,
partial result and ambiguous execution cases. Local tests, browser evidence,
live provider execution, physical devices, hosted checks and release receipts
have different scopes and must be recorded separately.
