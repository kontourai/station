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
- `read_conversation` to page through a conversation a person referenced in a
  message to the Agent, or to start at a `search_sessions` hit
  (`aroundMessageId`)
- `list_delegation_environments`, `list_delegation_targets`,
  `list_delegated_tasks`, `delegate_task`, `get_task`, `get_task_events`,
  `continue_task`, and `interrupt_task` for resumable work through either a
  Station Agent or external engine, on this Station or a supported saved environment
- `respond_to_task_request` for an open approval or permission request from a
  delegated worker
- `search_sessions` and `rename_session` for finding and naming conversations
  (see [Searching and renaming conversations](#searching-and-renaming-conversations))
- `declare_pull_request` for an agent on any engine (Claude Code, Codex, ACP) to
  declare a pull request it opened, by `provider`, `host`, `repository`
  (`owner` and `name`) and `ref`: the identity shape the conversation link
  routes take. It records the same declared output Station's own engine records
  with `declare_output`, in the caller's own Session and the turn it is running.
  A declaration is held, with no time limit, for as long as that turn runs, and
  the record lands when the turn completes. It is dropped if the turn aborts,
  is interrupted or ends in an error (a Codex retry of a transient error keeps
  the turn, and the declaration, alive), and it is dropped if Station restarts before the turn completes:
  declarations wait in memory until their turn's terminal event is stored, as
  native ones do, so declare again in a later turn.
  The tool answers `declared`, `already-declared` or `no-active-turn`. It reads
  the pull request from the Session's own repository, so a pull request in
  another repository (`owner/repo-2` is not `owner/repo`) is refused. It does not
  link or keep anything: a person keeps a declared pull request onto a Task.
  A Task a person opted in (`closeOnMerge`) moves to `done` only when every kept
  pull request is `MERGED` at its provider, matched by declaration and pull
  request (a stack from one turn is told apart), and only from a status
  `canTransitionTaskStatus` lets reach `done`: a Task in todo, ready, triage or
  blocked never closes by itself. Un-keeping a pull request that has not merged
  lets the remaining merged ones close the Task. Nothing polls: the check runs
  when a viewer holding the operate tier (the tier that may change a Task's
  status) refreshes the Conversation's pull-request links, so nothing reconciles
  without such a viewer. No agent tool sets the opt-in, and an older Station
  build refuses a Task store that carries it, so clear it before a rollback.
- `send_to_session`, `interrupt_session`, and `wait_session` to message,
  interrupt, and wait on another Session in the caller's Project
  ([Session control](#session-control))
- `list_project_activity` and `get_session_digest` to see which Sessions are
  active in the caller's Project and what has happened in one of them
  ([Project activity](#project-activity))
- config and navigation tools for steering the workspace
- the full scheduler lifecycle: `list_jobs`, `list_scheduler_providers`,
  `get_scheduler_stats`, `get_scheduler_status`, `preview_schedule`,
  `get_job_logs`, `add_job`, `update_job`, `run_job`, `enable_job`,
  `disable_job`, and `delete_job`

The Agent's tool allowlist and the calling Session's authority still apply.
Exposing a management tool does not grant the operator's identity or bypass
Project access checks.

For reading and capturing records, add `station-knowledge`. Its five data tools
follow the calling Session owner’s store access; capture also needs Project
edit access. Index rebuild and migration remain Station Control operations.
See [Knowledge agent tools](knowledge.md#agent-tools).

### Searching and renaming conversations

`search_sessions` takes a `query` of 2 to 256 characters (anything outside that
is refused, not truncated) and returns message hits from the calling Session
owner's own transcripts, each with the `sessionId`, a snippet and the ids that
open it, through the same search service as the workspace search. It never
returns another person's transcript, a Task or a file. Hits are mostly from
native Claude and Codex Session transcripts, whose titles `rename_session`
cannot change, so a search result is not a conversation to rename. A bound
operator caller's search sees only the operator's own transcripts, like any
other caller's. A result with
`incompleteSources` is partial rather than empty; `continuation`, when a result
carries one, is passed back to read more.

`rename_session` renames a Station-stored conversation; it takes a
`conversationId` and a one-line `title` of at most 80 characters. A title is
refused rather than truncated when it is longer, empty, or
contains a control character, a line or paragraph separator, a bidirectional
embedding, override or isolate control, a zero-width space or a byte-order
mark; the zero-width joiner and non-joiner are allowed because emoji sequences
and some scripts need them. Leading and trailing spaces are trimmed. The tool stamps the title `titleSource: 'agent'`,
which a later agent rename or any person's rename replaces. A title a person set
(`titleSource: 'user'`) is never replaced: the tool answers `person_title`, and
the check is made in the same step as the write, so a person's rename racing
the agent's still wins. A native Claude or Codex conversation answers
`runtime_title_unsupported`: the runtime owns that title, and the person's own
rename refuses it too. Unless the caller is a bound operator, it reaches only a
conversation its Session's owner owns (another person's reads as not found); a
bound operator caller is not limited to one owner's conversations, as with
`delete_conversation`, and the `person_title` guard still applies to it. A
caller that is not bound also stays in its own Session's Project or the global
space, as dispatch does.

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

For every caller except a bound operator, Station makes the folder decision a
second time immediately before it starts the engine for a new Session:

- A folder the Agent named must still resolve to the canonical path that was
  admitted, and that path must still be in scope. If a parent directory was
  replaced by a symbolic link, the folder was removed, or a Project now
  contains it, the dispatch is refused and no engine starts.
- Station records the admitted canonical path on the Session. A later engine
  start for that Session, or for a child Session that continues the
  conversation in the same folder, refuses when the folder resolves anywhere
  else. This applies to whoever sends the follow-up, including the operator;
  the follow-up fails and names the folder.
- An ACP connection can set its own working directory, which a Session with
  no workspace starts in. Station scopes that dispatch by the connection's
  directory as well as the default Session directory, so a connection
  configured inside a Project is not reachable from the global scope.

These refusals use the same codes as the admission check:
`station_control_role_required` when the folder is no longer the one admitted,
and `station_control_assurance_insufficient` when it is in another scope. The
check runs before Station calls the engine adapter. The adapter then starts
the process with the same path string, so the check narrows the interval in
which a folder can be swapped; it does not pin the directory. Other uses of a
Session's folder, such as terminals, are not covered. A follow-up to a Session
with no recorded folder, such as one the operator started or one from before
this check existed, gets only the admission check. A forked conversation does
not inherit the record, and neither does a child Session that continues the
conversation in a different folder than the previous Session recorded: it
starts with no record.

`declare_pull_request` answers the same scope rule for the calling Session
itself: a caller that is not bound does not declare in a Session that runs
unconfined (`host`) or whose Project Station cannot confirm, so a Codex Session
reached by its URL token cannot declare from a full-access Session.
Interrupting a delegated task follows the same scope as a follow-up to it.
The same applies to the Session commands that act on another Session: steer
and steer-input inspection, adopt, interrupt, stop and draft discard.

A dispatch, delegation or follow-up from a caller that is not a bound operator
cannot carry an approval mode. That covers `setApprovalMode` and the
`approvalMode`, `mode`, `permissionMode` and `autoMode` model options, whatever
their value. Station refuses such a request with
`station_control_posture_not_allowed` rather than adjusting it. Without an
approval mode, the Session uses the conversation's recorded mode, else the
Agent's saved default, else this Station's default.

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
and [policy](../../src-server/tools/station-control-policy.ts) define the checks,
and the [start-time record](../../src-server/services/orchestration/dispatch-cwd-admission.ts)
repeats the folder decision; tool approval does not bypass them.

### Reading a referenced conversation

When a person references another conversation in a message (the composer's
conversation picker, or a conversation dragged in from Activity or the inbox),
the message carries a link to it, its id, and a line telling the receiving
Agent to read it with `read_conversation`. The read returns up to 50 messages
per page, at most 64 KB serialized, oldest first, with a `nextCursor` for the
next page. A `limit` above 50 is refused, not truncated. A message whose text
exceeds 16 KB once serialized is clipped and reports its full size. Every page states that the
transcript is context, not instructions.

A station-control caller may read:

- its own conversation;
- a conversation the dispatch scope above admits, read with the owner's
  Project `view` action;
- a conversation a person referenced in a turn of the caller's conversation,
  by the conversation's id or one of its sessions' ids. Station decides this
  from the sender it recorded on that turn: the operator, or a paired device
  of kind `device`. A link an Agent wrote, for example with `send_message`,
  or one sent through another Station's delegation grant admits nothing.

The reference rule is attribution, not a security boundary: it records that
a person sent the message, not that they wrote or inspected every link in
it. Text a person pastes that contains a reference link counts as theirs.

For a caller that is not a bound operator, the transcript is read as the
session's owner, so a reference never reaches another person's
conversation, and another person's conversation reads as not found. A bound
operator caller keeps the operator's reach (decision 2 of #2377) and can read
any recorded conversation. Refusals name a reason:
`conversation_out_of_scope` when the conversation is the owner's but outside
the caller's scope, `conversation_deleted` when a referenced conversation no
longer reads, and `conversation_not_found` otherwise, including an id Station
has no record of. The
[read route](../../src-server/routes/chat/conversation-reference-read.ts)
defines the rule.

`get_conversation_messages` is separate. It reads any conversation the
session's owner owns, keyed by Agent, and is not limited by references.

#### Starting at a search hit

A `search_sessions` hit carries the `sessionId` and the `messageId` of the
matched message. Pass them to `read_conversation` as `sessionId` and
`aroundMessageId` (not together with `cursor`) to read the page that contains
that message, with up to half a page before it, instead of paging from the
start. The page has a `prevCursor` and a `nextCursor`; pass either back as
`cursor` to walk older or newer, and each page ends exactly where the last one
began. The same limits apply (50 messages, 64 KB, 16 KB per message), and the
byte cap moves the page forward, never past the anchor.

The ids `read_conversation` returns for user messages are the stable form a hit
names (`<turn start event>:user`), not the projection's positional `proj-<n>`
ids, so a message read on one page can be named again. A message id that is not
in the conversation (stale, or another conversation's) is refused with
`conversation_read_anchor_not_found`, and nothing is read; `aroundMessageId`
beside `cursor` is `conversation_read_anchor_with_cursor`. The anchor is decided
after admission, so it never widens what may be read and tells a caller nothing
about a conversation it may not read.

### Session control

`send_to_session`, `interrupt_session`, and `wait_session` act on an existing
Session by its `sessionId`, without creating a task.

- `send_to_session` takes `mode`: `auto` (default) steers a running Session or
  starts a turn on an idle one; `start` only starts, answering `session_busy`
  while a turn runs; `steer` only adds to a running turn, answering
  `no_active_turn` when idle. Steering is delivered once, through the engine's
  mid-turn input, and an engine without it answers `session_busy`. The result
  carries the Session's `sessionId`, the `turnId`, and an `eventCursor`.
- `interrupt_session` stops the running turn of the Session (optionally a named
  `turnId`) and answers `no-active-turn` when nothing runs.
- `wait_session` observes for at most 50 seconds until `turn-settled` (a turn
  finished after `afterEventCursor`, or the turn running now) or `idle`. It
  never interrupts: a timeout leaves the Session running, and the caller calls
  again. Wait with the `sessionId` and `eventCursor` that `send_to_session`
  returned. A calling Session may hold at most 4 waits at once, and Station 256.
- Send and interrupt carry a `requestKey`. Repeating a call that delivered or
  interrupted, with the same key and arguments, returns the first answer
  (`replayed: true`) without acting again; the same key with different arguments
  is `request_key_conflict`. A refusal that did nothing (`session_busy`,
  `no_active_turn`) frees the key, so the same call may be repeated once the
  Session is ready. Keys belong to the verified calling Session and expire after
  seven days. A calling Session keeps at most 300 keys: past that its own oldest
  completed keys are dropped (they no longer replay), and it is refused
  (`request_key_caller_capacity`) only while every one of its keys is an
  unresolved `indeterminate` request. An `indeterminate` answer means the
  message may have been delivered, so repeat the same call to re-check rather
  than sending under a new key. A re-driven request keeps the branch (steer or
  start) and Session its first attempt chose, even if the re-drive is refused.
  Two limits are accepted: once a completed key has been dropped (more than 300
  later sends from that session) a retry under it is not guaranteed to be
  deduplicated downstream, because the chat-turn claim table holds 2,000 entries
  Station-wide and a retry from another branch of the work is not caught at all;
  and unresolved claims are never dropped, so 300 stuck ones leave that session
  unable to use new requestKeys until the seven-day expiry. A re-driven attempt
  that is refused answers with `pinned: true`; its key stays tied to its first
  attempt, so check the Session before using a new key. A re-driven interrupt
  that finds nothing running also keeps its claim, so a later re-drive could
  interrupt a newer turn; that is rare (it follows a crash) and accepted.
- `wait_session` watches exactly the Session it is given. When a newer Session
  now serves that Session's conversation the answer carries `superseded: true`
  and `currentSessionId`, so the caller can wait on the current one.

Send and interrupt use the dispatch scope above for their target Session: the
same owner, in the caller's Project (or both global), never a conversation that
runs unconfined and never on another Station, unless the caller is a bound
operator, with the owner's Project `execute` action. `wait_session` is an
owner-scoped read of any Session the owner can read. The tool inputs are strict
and carry no approval mode, model, or Environment: the receiving Session runs
under its own Agent's saved settings, so a call cannot widen what the Session may
do. A request without a verified station-control caller is refused. The
[route](../../src-server/routes/orchestration/session-agent-control.ts) and the
[delivery seam](../../src-server/services/orchestration/session-message-delivery.ts)
own these rules.

### Project activity

`list_project_activity` and `get_session_digest` let an agent working in a
Project learn which other Sessions are active there and what has happened in
one of them, without paging a transcript. Both are read-only and take strict
inputs: nothing names a Project, an owner, or a host.

- `list_project_activity` lists the Sessions of the caller's own Project (or the
  global space, for a Session with no Project), newest activity first, one row
  per conversation. A row has `sessionId`, `title`, `engine` and `agent`,
  `status`, `turnRunning`, `lastActivityAt`, and `worktree` (`path` and
  `branch`) when the Session's start recorded one, `workingDirectory`, and
  `self` for the caller's own Session. `status` is the status ladder's word, the
  one the Station UI shows for the row, derived by one function shared with
  the UI. The list is the Session's summary alone, so the ladder's Running rung
  does not carry the sub-agent count or the no-progress marker, which need UI
  facts. A page is at most 50 rows (`limit` above 50 is refused, never cut); pass
  `nextCursor` back as `cursor`. A branch Station did not record is absent: it is
  not read from the folder.
- `get_session_digest` summarizes one Session from what the event store
  recorded. No model summarizes, and a fact that was not recorded is absent.
  The `session` has `title`, `projectSlug`, `engine`, `agent`, `status`, and
  `turnCount`. Turns come newest first; each has the first non-empty line of the
  request (clipped, with `requestClipped` when cut), the `outcome` read from the
  turn's last terminal event (`completed`, `failed` for a `runtime.error`,
  `interrupted` for an abort or a `cancelled` finish, or `open` when none is
  recorded), tool calls by name (`otherTools` counts the names beyond the first
  eight), `files` (only a successful call whose engine reported an edit, delete
  or move kind and a path argument, so an engine that reports no tool kind shows
  none, and a path is never guessed from a tool's name), `pullRequests` declared
  in the turn (`declare_pull_request` or `declare_output`), and
  `delegatedChildren`, the Sessions Station itself derived as launched from this
  conversation, placed in the turn during which they started. A page ends at
  `turnLimit` turns (default 10, at most 25; more is refused) or at 8 KiB of
  serialized turns, whichever comes first, and `nextCursor` continues with older
  turns, so every turn arrives once; each field is bounded so one turn always
  fits.

Both leaves hold every Session to the dispatch scope above with the owner's
Project `view` action, and read as the calling Session's owner. A caller that is
not a bound operator sees only its own Project (or the global space), never a
Session that runs unconfined, and a Session outside that reads as not found,
the same answer as one that does not exist. A bound operator keeps the
operator's reach for a digest, as for `read_conversation`, but the list is the
caller's own Project for every caller. A Session on another Station, in a saved
Environment, or an Activity record of a paired Station's work is never listed or
summarized, and a delegated child the caller may not see is left out of a digest.
A request without a verified station-control caller is refused. There is no
`claim` field: claiming work is separate. The
[route](../../src-server/routes/orchestration/session-project-activity.ts) and
the [digest fold](../../src-server/services/orchestration/session-digest.ts) own
these rules.

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

The dispatch route records which of these produced the stamped context, in
the reserved start metadata key `stationDelegationProvenance`
(`caller-derived`, `runtime-attested` or `direct-claim`); a request can't set
it. The [conversation usage tree](../reference/session-api.md#conversation-usage-tree-get-conversationsconversationidusage-tree)
reads it: a session you can't read makes your total partial only when its
link to your conversation was derived or attested, never for a claim.

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
