# Build a Self-Configuring Agent

This guide shows how to build an agent that can set up its own workspace in Station using `station-control`.

## Goal

The agent should be able to:

- inspect the current workspace state
- create or refine skills
- delegate bounded work to another agent
- configure the project enough that the user lands in a useful environment

The concrete example bundle lives in [examples/self-configuring-agent](../../examples/self-configuring-agent/README.md).

## What `station-control` gives you

`station-control` is the built-in MCP server for platform management. It exposes tools such as:

- `list_agents`, `get_agent`, `list_projects`, `get_project`
- `list_skills`, `list_registry_skills`, `install_skill`, `uninstall_skill`, `update_skill`, `track_skill_run`, `record_skill_outcome`
- `send_message` for a lightweight message to a Station agent
- `list_delegation_environments`, `list_delegation_targets`,
  `list_delegated_tasks`, `delegate_task`, `get_task`, `get_task_events`,
  `continue_task`, and `interrupt_task` for resumable work through either a
  Station agent or an Agent app, on this Station or a verified SSH environment
- `respond_to_task_request` for an open approval or permission request from a
  delegated worker
- config and navigation tools for steering the workspace
- the full scheduler lifecycle: `list_jobs`, `list_scheduler_providers`,
  `get_scheduler_stats`, `get_scheduler_status`, `preview_schedule`,
  `get_job_logs`, `add_job`, `update_job`, `run_job`, `enable_job`,
  `disable_job`, and `delete_job`

This means the same agent loop that writes code can also shape its own working environment.

## Recommended setup pattern

1. Start with one orchestrator agent.
2. Give it `station-control` plus only the MCP servers it actually needs.
3. Call `list_delegation_environments`, then `list_delegation_targets` to choose
   a ready worker with the capabilities the task needs. Environment listing is
   secret-free, read-only, and never reconnects; inspecting a selected saved SSH
   Station's targets may reconnect its verified binding, so only that second
   step remains approval-gated. Use `delegate_task` when the work needs a
   resumable task, lifecycle status, or explicit observation and interrupt
   control; reserve `send_message` for lightweight fire-and-forget
   Station-agent collaboration. Delegation discovery returns the same
   secret-free selection state as the UI.
   On coordinator startup or reconnect, call `list_delegated_tasks` to recover
   compact task handles before using `get_task`; the inventory defaults to 50
   results, caps at 100, verifies each environment and Station-user binding,
   and never returns prompts, messages, raw events, or connection details.
   Station injects the calling agent's authenticated user automatically.
   Poll `get_task_events` with its returned `nextCursor` when a coordinator
   needs incremental output. Each page is capped at 100 events and excludes
   prompts, reasoning text, tool inputs/results, approval payloads, provider
   diagnostics, paths, and extension payloads.
4. Keep child sessions isolated with delegation limits.
5. Refine successful skills instead of baking everything into one giant system prompt.

The orchestrator should stay focused on coordination. Child agents should own narrow tasks.
When the orchestrator calls `delegate_task`, Station authoritatively binds the
active conversation as `parentTaskId`; do not ask the model to invent or copy
its own task identifier.

## Wake an agent later

An agent can create a monitor or wake-up through `add_job`. Use a cron schedule
for calendar recurrence, `every` for a fixed interval, or `at` for one future
instant:

```json
{
  "name": "check-deployment",
  "schedule": {
    "kind": "at",
    "timeMs": 1800000000000,
    "deleteAfterRun": true
  },
  "agent": "station",
  "prompt": "Inspect the deployment and report only new failures."
}
```

The scheduled execution is a new attributable Agent run using the stored
prompt; it does not silently resume the conversation that created it. Creating
the job also does not grant unattended tool authority. Any standing grant must
target the server-issued scheduled-job principal, and a delete/recreate gets a
new identity. Use `get_job_logs` or the Runs surface to observe the result.

## Delegate from chat

Open a project chat and choose **Delegate** in its task-context bar. Station
loads the Project's execution default before discovering workers. **Change
routing** lets you choose an Agent, a Station and a model override. A configured
remote stays selected while its inventory loads or its connection fails; Station
does not replace it with **This Station**. If the Project defaults cannot be
loaded, retry that read or make an explicit Station choice.

Remote environments are re-verified and connected to load their available Agents
before launch. Discovery for a different environment cannot supply the selected
worker list. A failed remote discovery keeps the task draft and offers retry;
choosing **This Station** explicitly permits a local launch. An explicit choice
survives later Project-default and inventory updates. Project settings likewise
retain the selected remote while their saved-environment list loads.

Delegation uses the persisted orchestration task contract. Its result can be
observed, interrupted and resumed through the owning execution environment.

Because **Delegate** is opened from a chat's task context, the sheet identifies
the new task as a **Child worker of** that chat and sends its session ID as the
parent linkage. The result is the same resumable task exposed by
`delegate_task`, not a separate UI-only job. Use **Open task** from the
confirmation to follow its existing session, approvals, output, and interrupt
controls.

## Example agent

Use the example `agent.json` as a starting point:

```json
{
  "name": "Workspace Bootstrapper",
  "prompt": "You set up useful project workspaces. Inspect the current project, create or refine skills when you find reusable workflows, and delegate narrow tasks to specialist child agents. Prefer small reversible changes.",
  "tools": {
    "mcpServers": ["station-control"],
    "available": [
      "station-control_list_agents",
      "station-control_list_projects",
      "station-control_get_project",
      "station-control_list_skills",
      "station-control_update_skill",
      "station-control_track_skill_run",
      "station-control_send_message",
      "station-control_list_delegation_environments",
      "station-control_list_delegation_targets",
      "station-control_list_delegated_tasks",
      "station-control_delegate_task",
      "station-control_get_task",
      "station-control_get_task_events",
      "station-control_continue_task",
      "station-control_respond_to_task_request",
      "station-control_interrupt_task"
    ],
    "autoApprove": [
      "station-control_list_agents",
      "station-control_list_projects",
      "station-control_get_project",
      "station-control_list_skills",
      "station-control_list_delegation_environments"
    ]
  },
  "delegation": {
    "maxDepth": 2,
    "blockedTools": [
      "station-control_update_config",
      "station-control_delete_*"
    ]
  }
}
```

The `delegation` block above is not accepted yet.
[`schemas/agent.schema.json`](../../schemas/agent.schema.json) has no
`delegation` field and refuses unknown fields, so a spec that carries one fails
to load, and a session on that Agent cannot delegate. Remove the block before
you use this example. Every Agent's children get the default policy described
below.

## Delegation rules

Station now enforces child-agent isolation for delegated sessions:

- delegated children inherit a depth counter
- blocked tools and allowlists can be enforced per child
- delegated children can be denied approval-bound tools entirely

That gives you a safe default for “planner delegates to worker” patterns without giving every child full platform control.

### Where a child's lineage comes from

A child's delegation context (its depth, parent, root, and tool limits) is
derived by Station from the delegating session's own records:
its Agent, its conversation, and the context that session was started with
([`request-delegation.ts`](../../src-server/runtime/agents/request-delegation.ts)).
The `_delegation` argument a model writes into `delegate_task` or
`send_message` is ignored. A session already at the depth limit is refused
before any child starts, on every engine.

The default policy is `maxDepth` 2, `denyApprovals`, and the built-in
denials in `BUILTIN_DELEGATION_DENIALS`
([`agent.ts`](../../packages/contracts/src/agent.ts)): `send_message`,
`delegate_task`, `run_job`, and every `add_*`, `create_*`, `update_*`,
`delete_*`, `remove_*`, `connect_*` and `disconnect_*` station-control tool.

**Behaviour change.** Before this, `POST /api/orchestration/delegations`
dropped any context, so every `delegate_task` child started as an unrestricted
root, including children of Station's own engine and of the default Agents
(`station`, `claude`, `codex`). A `send_message` child on another engine
carried whatever context the model wrote, or none. Every such child now gets
lineage and the default policy. A delegated child therefore cannot:

- create, update, or delete Station resources (Agents, skills, jobs,
  Projects), or add or remove anything through station-control;
- start a scheduled job with `run_job`, or delegate or message further;
- do work that needs an approval: approval-bound tools are refused rather
  than routed to a person.

Give such work to a top-level conversation instead of a delegated child.

### Which requests can name a context

- A station-control tool call with a verified per-session credential gets
  the derived context.
- Station's own engine's pooled tool child has no per-session credential. Its
  context is kept only when Station's runtime attested it.
- Any other internal request that is neither verified nor attested starts a
  root.
- A request from outside this Station's process, such as a peer Station, an
  operator credential, or a paired device, may send a `delegation` body on
  `POST /api/orchestration/delegations`, as on `/chat/delegated`. Its context
  is stored as sent. Such a claim can only restrict the session (a depth, tool
  denials, `denyApprovals`) or label it (parent and root ids). A claimed
  `maxDepth` does not raise the depth limit of that session's own children,
  and no server or UI code routes on the parent or root ids.

### Forwarding to a saved Environment

When `delegate_task` or `send_message` targets another Station, this Station
derives the child's context first and forwards it without an attestation.
The receiving Station stores it as the sending Station's assertion. There is
one known gap: a receiver older than this change strips the unknown
`delegation` field from `POST /api/orchestration/delegations`. On that
receiver the child starts as a root, which is the same as the behaviour before
this change. A `send_message` forward to such a receiver still carries its
context. A station-control connection with no verified caller and no
attestation keeps the old forwarding behaviour: `send_message` forwards the
context it was given, and `delegate_task` forwards none.

## Skill refinement loop

The loop is intentionally simple:

1. Agent notices a repeated task.
2. Agent creates or updates a skill (`POST /api/skills/local`, or
   `update_skill` for one it already has).
3. Station records the agent/conversation provenance for that edit.
4. When the skill is used, Station tracks runs through `track_skill_run`.
5. Success/failure outcomes can be recorded through `record_skill_outcome` to
   build a quality signal over time.

This is enough to support self-improving agents without needing a full offline training system.

## Approval model

Approval-bound tools still respect the human-in-the-loop path.

- human approval requests aggregate into the notifications inbox
- an optional guardian review layer can allow, deny, or defer risky tool calls before they reach the human path
- delegated child agents can be configured to avoid approval-bound tools altogether

That combination keeps the bootstrap agent useful without giving it silent unrestricted power.

## Recommended first demo

Use the example bundle to demonstrate this flow:

1. Ask the bootstrap agent to inspect a repo.
2. Let it create a “review this repo” skill.
3. Let it delegate a focused task to a child agent.
4. Watch the workspace update in the UI and the resulting skill appear in Skills.

That is the clearest demo of Station’s “agents managing agents” model.
