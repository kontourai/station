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
prefills the current project, Agent app, and effective model. The compact sheet
also lets you choose a Station agent or a saved SSH environment; remote
environments are re-verified and connected when selected so the sheet can load
that Station's actual Agent apps, Station agents, readiness, and model catalog
before launch. Unavailable targets remain explained rather than silently
falling back to a similarly named local runtime. Model changes stay under
**Options** so switching to another target uses that target's default unless
you explicitly override it. Station agents and Agent apps both launch through
the persisted orchestration task contract, so either kind can be observed,
interrupted, and resumed locally or through a verified SSH environment.

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

## Delegation rules

Station now enforces child-agent isolation for delegated sessions:

- delegated children inherit a depth counter
- blocked tools and allowlists can be enforced per child
- delegated children can be denied approval-bound tools entirely

That gives you a safe default for “planner delegates to worker” patterns without giving every child full platform control.

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
