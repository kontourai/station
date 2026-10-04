# Build a Self-Configuring Agent

Use `station-control` to let an Agent inspect Station's project records, refine
existing skills, and delegate a bounded task. Tool availability and approval
policy determine which changes it can actually make.

## Goal

The example supports:

- inspect project and Agent metadata
- refine an existing writable skill
- delegate bounded work to another agent
- report changes that need a person or an additional authorized tool

The concrete example bundle lives in [examples/self-configuring-agent](../../examples/self-configuring-agent/README.md).
It does not provide filesystem inspection, create a new skill, or change Project
configuration by itself. Those require a separately authorized surface; the
example does not grant one implicitly.

## What `station-control` gives you

`station-control` is the built-in MCP server for platform management. It exposes tools such as:

- `list_agents`, `get_agent`, `list_projects`, `get_project`
- `list_skills`, `list_registry_skills`, `install_skill`, `uninstall_skill`, `update_skill`, `track_skill_run`, `record_skill_outcome`
- `send_message` for a lightweight message to a Station agent
- `list_delegation_environments`, `list_delegation_targets`,
  `list_delegated_tasks`, `delegate_task`, `get_task`, `get_task_events`,
  `continue_task`, and `interrupt_task` for resumable work through either a
  Station Agent or external engine, on this Station or a supported saved environment
- `respond_to_task_request` for an open approval or permission request from a
  delegated worker
- config and navigation tools for steering the workspace
- the full scheduler lifecycle: `list_jobs`, `list_scheduler_providers`,
  `get_scheduler_stats`, `get_scheduler_status`, `preview_schedule`,
  `get_job_logs`, `add_job`, `update_job`, `run_job`, `enable_job`,
  `disable_job`, and `delete_job`

The Agent's tool allowlist and the calling Session's authority still apply.
Exposing a management tool does not grant the operator's identity or bypass
Project access checks.

### Dispatch authority

Station checks an Agent's dispatch against its verified Session caller:

- A bound caller acting for the operator retains the operator's reach, subject
  to the route's existing Session authorization.
- Other bound callers can reach only their own owner's Sessions on this Station,
  with that owner's `execute` action in the target Project.
- Other verified callers also stay within their calling Session's Project or
  global scope and cannot reach a conversation that runs unconfined (`host`).

Here, `bound` describes verified caller assurance, not a selected approval mode.
A plain folder target belongs to the deepest Project whose canonical working
directory contains it; otherwise it is global. A missing or unreadable folder
does not establish a scope. With no workspace, Station checks the default
Session directory. Conversation follow-ups use the newest started Session's
scope and check unconfined execution across the conversation's lineage,
including reserved successors.

Interrupting a delegated task follows the same scope as a follow-up to it.
The same applies to the Session commands that act on another Session: steer
and steer-input inspection, adopt, interrupt, stop and draft discard.

A dispatch, delegation or follow-up from a caller that is not a bound operator
cannot carry an approval mode. That covers `setApprovalMode` and the
`approvalMode`, `mode`, `permissionMode` and `autoMode` model options, whatever
their value. Station refuses such a request with
`station_control_posture_not_allowed` rather than adjusting it. A new Session
runs with its Agent's saved default; a follow-up keeps the conversation's
recorded mode.

Saved-Environment discovery and remote dispatch require a bound operator caller.
Remote task listings, task reads, event reads, and interrupts carry the same
restriction.
For a non-operator caller, `respond_to_task_request` requires bound assurance,
the same task owner, and that owner's Project `approve` action. Global-scope
approval requires a bound operator. The separate Session `respondToRequest`
command remains restricted to a bound operator when called through
station-control.

These rules apply to station-control callers. The operator UI, paired Devices,
and Station's own server code retain their separate authorization boundaries.
The [scope owner](../../src-server/runtime/mcp/station-control-dispatch-scope.ts)
and [policy](../../src-server/tools/station-control-policy.ts) define the checks;
tool approval does not bypass them.

## Recommended setup pattern

1. Start with one orchestrator agent.
2. Give it `station-control` plus only the MCP servers it actually needs.
3. Call `list_delegation_environments`, then `list_delegation_targets` to choose
   a ready worker with the capabilities the task needs, using a bound operator
   caller for saved-Environment discovery. Environment listing is
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
   Station resolves the caller from its Session records; a model-supplied user
   identity grants no authority.
   Poll `get_task_events` with its returned `nextCursor` when a coordinator
   needs incremental output. Each page is capped at 100 events and omits raw
   prompt, reasoning, tool input/result, approval payload, diagnostic, path,
   and extension fields. It retains bounded assistant text and request titles;
   those strings are not scrubbed of paths or other sensitive content the
   worker wrote.
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
the job also does not grant unattended tool authority. A per-job standing grant
must target the server-issued scheduled-job principal, and a delete/recreate
gets a new identity. An agent-wide opt-in is the agent's
`tools.unattendedAutoApprove` list ([Unattended runs](agents.md#unattended-runs));
`tools.autoApprove` patterns such as `station-control_*` cover attended chat. Use `get_job_logs` or the Runs surface to observe the result.

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

A chat linked to a Project has additional placement rules. A paired Station
requires that Project's prepared portable identity and an execution resource;
the receiver verifies its current offer when the task is submitted. This UI
refuses a linked Project on an SSH target and keeps the draft. SSH delegation
without a linked Project is a separate supported path; selecting a remote
computer does not authorize substituting a same-named Project there. See
[machine relationships](machine-relationships.md).

Delegation uses the persisted orchestration task contract. Its result can be
observed, interrupted and resumed through the owning execution environment.

Because **Delegate** is opened from a chat's task context, the sheet identifies
the new task as a **Child worker of** that chat and sends its session ID as the
parent linkage. The result is the same resumable task exposed by
`delegate_task`, not a separate UI-only job. Use **Open task** from the
confirmation to follow its existing session, approvals, output, and interrupt
controls.

## Example agent

Use this as an attended Station-engine Agent after configuring a usable Model
connection and default model in [Connections](connections.md). No engine binding
is declared, so it uses Station's engine. Only the four listed reads are
auto-approved; mutations and delegation remain subject to the normal approval
and authority checks. Start with an existing writable skill and a ready worker.

Use the example `agent.json` as a starting point:

```json
{
  "name": "Workspace Bootstrapper",
  "prompt": "Inspect the current project's Station metadata, suggest useful workflow improvements, refine an existing writable skill when asked, and delegate narrow tasks to ready specialist agents. Explain missing tools or approvals. Prefer small reversible changes.",
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
      "station-control_list_skills"
    ]
  }
}
```

Do not add a `delegation` block to this file.
[`schemas/agent.schema.json`](../../schemas/agent.schema.json) has no
`delegation` field and refuses unknown fields, so a spec that carries one fails
to load: the Agent is unusable, not only unable to delegate. The runtime derives
the default child policy described below; this is not an editable Agent setting.

## Delegation rules

Station records a child's lineage and derives its depth and tool policy at
delegation. Policy delivery also depends on the selected engine: the
Station-engine example below uses Station's pre-tool checks. For other engines,
consult the [tool-policy delivery contract](../conformance/tool-policy-delivery.md)
and current capabilities before relying on the same restrictions. A recorded
delegation context alone is not proof of external tool enforcement or a
filesystem sandbox.

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
lineage and the default policy. Where Station's pre-tool policy is delivered,
the built-in denials prevent a delegated child from:

- calling the matching create, update, delete, add, or remove station-control tools;
- starting a scheduled job with `run_job`, or delegating or messaging further;
- asking a person for tool approval when `denyApprovals` applies. A call already
  allowed by the applicable policy can still run; otherwise it is refused.

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
requires a bound operator caller, derives the child's context, and forwards it
without an attestation. The tool itself never contacts the other Station or
holds its credential: it names the saved Environment to this Station's own
route, and the route forwards the call after its scope check.
The receiving Station stores it as the sending Station's assertion. There is
one known gap: a receiver older than this change strips the unknown
`delegation` field from `POST /api/orchestration/delegations`. On that
receiver the child starts as a root, which is the same as the behaviour before
this change. A `send_message` forward to such a receiver still carries its
context. A station-control request with no verified caller and no runtime
attestation is refused before dispatch; it has no supported forwarding path.

## Skill refinement loop

1. Identify a repeated task and choose an existing writable skill.
2. Request an edit through `update_skill`. Creating a new skill instead uses
   `POST /api/skills/local`; there is no `create_skill` tool in this example's
   management surface.
3. Station's engine adds Agent/conversation source context to `update_skill`
   when it is absent, and the trusted internal route records it as
   `updatedFrom`. This is not a universal, independently verified authorship
   guarantee for arbitrary API callers or external engines.
4. Call `track_skill_run` explicitly to count use. The existence of this tool
   does not mean every skill invocation automatically increments the counter.
5. `record_skill_outcome` can record an explicit success/failure assessment if
   separately exposed to the Agent; it is not in the example's allowlist.

These records support iteration on a workflow. They do not train the model or
independently establish the quality of its work. The
[skill tools](../../src-server/tools/station-control-catalog-tools.ts) and
[routes](../../src-server/routes/agents/skills.ts) own these operations.

## Approval model

Approval-bound tools still respect the human-in-the-loop path.

- canonical Session requests appear in the Inbox and their owning Session;
  the legacy per-Agent chat route has its own SSE approval flow
- an optional guardian review layer can allow, deny, or defer risky tool calls before they reach the human path
- the default child policy includes `denyApprovals`; its delivery follows the
  selected engine's policy contract, not an editable `delegation` JSON block

See the [Agent approval guide](agents.md#tool-approval-flow) for ordering and
the distinction between attended and unattended runs.

## Recommended first demo

Use the example bundle to demonstrate this flow:

1. Configure the model and prepare a writable “review this repo” skill.
2. Ask the bootstrap Agent to inspect the Project metadata and propose a skill edit.
3. Review its tool approval before accepting the edit.
4. Choose a ready worker with the tools the task needs and approve a focused
   delegation. Follow its task handle in the UI; do not assume the worker has
   repository access just because the coordinator can see Project metadata.
