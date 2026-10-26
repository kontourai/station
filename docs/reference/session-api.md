# Session API: the programmatic chat surface

This is the reference for driving a Station chat session (any agent — Station agent,
External agent, ACP-connected — see [glossary](../glossary.md)) entirely over HTTP, with
no UI in the loop. It is the API-parity contract for the composer: every action a human
takes in the chat dock has a documented, scriptable equivalent here
(`docs/design/chat-composer.md` §4).

For foreground chat, the canonical execution surface is
`POST /api/orchestration/chat`. It accepts an
Environment + Agent target and a message. Station resolves the Agent's engine,
model, and workspace binding on the target Environment. A bound continuation
uses `POST /api/orchestration/chat/:conversationId/continue`; it preserves the
Environment, workspace and current Agent/engine binding. Supported per-turn model
overrides remain explicit choices. Two separate read paths show
what happened: a point-in-time JSON replay and a live SSE feed.

Provider handoffs retain the Conversation ID and append linked execution
Sessions. Returning to a compatible built-in engine can resume its earlier
native thread with a bounded seed of the intervening conversation, after the
previous engine confirms retirement. Unsupported or unbound history uses
bounded replay. An explicit fork creates a separate Conversation.

The compact conversation reader used by `read_conversation` and the SDK's
`readConversation` preserves message Session attribution. Versioned `provenance`
reports the ordered Sessions, providers, handoffs, requested native returns and
explicit fork ancestry. A requested native return is separate from observed
native identity and turn completion. Missing or unavailable provenance means
unknown; history access remains scoped to the caller, including every linked
Session. Pagination and truncation still apply.

Independent [Task room agent requests](../design/task-room-agent-requests.md)
use the existing delegation route with a separate durable request journal.
They do not replace foreground chat or the Task's current-session association.

---

Execution summaries can include `modelRoute: {connectionId, label, endpoint}`.
It is a safe route snapshot from the engine launch: `endpoint` is an HTTP(S)
origin without credentials, and no proxy key is included. Older sessions may
omit it. Changing saved connection settings alone does not rewrite the snapshot;
a new configured execution records its actual route.

## Visual Skill presentation

Installed [Skill experiences](skill-experiences.md) use this same foreground
Session lifecycle. A supported inventory advertises `executionContract: "1.0"`.
An explicit composer send may carry `skillExperience` with pinned installed
identity, validated inputs and a client turn ID. Project Environment defaults are
resolved normally; remote execution is refused for this contract.

`GET /api/orchestration/sessions/:threadId/skill-experience` projects immutable
invocation history across existing conversation lineage. Canonical turns,
requests, answers, decisions and outputs remain the execution facts. A removed
source leaves history readable and refuses subsequent source-backed effects.
Rich frame reads/answers additionally bind `{identity, eventId}` in
`expectedSkillExperience` and require its fresh `agents.invoke` grant. Ordinary
user controls omit that frame-specific admission.

## Start a conversation

```
POST /api/orchestration/chat
Content-Type: application/json
```

```jsonc
{
  "target": {
    "environment": { "kind": "current" },
    "agent": "codex",
    "model": {
      "override": "optional model id",
      "options": { "effort": "high" }
    },
    "workspace": {
      "kind": "project",
      "projectSlug": "station",
      "cwd": "/work/project/subdir"
    }
  },
  "message": "Inspect this change",
  "conversationId": "optional caller-chosen continuation id"
}
```

`workspace.cwd` is optional for a Project target. When supplied, its path must
exist and resolve inside that Project's configured working directory,
including symlink resolution and whole path segments. The example assumes the
selected Project contains `/work/project/subdir`. An outside or unresolvable
override refuses before execution. A separately verified remote workspace keeps
its remote-path admission; the controlling Station does not resolve that path
against its own filesystem.

A plain-folder workspace (`{ "kind": "directory", "cwd": "..." }`) starts the
engine in a folder that is not confined to a Project, so a paired device needs
the operator's `coding:exec` grant to name one; without it the route answers
`403` with `code: "working-directory-not-granted"` and starts nothing. This
applies to `/chat`, `/chat/delegated`, `/chat/background`,
`/conversations/:conversationId/handoff` and `POST /api/orchestration/delegations`;
the other routes the rule covers are listed in the [API reference](api.md#choosing-a-working-folder).
The operator credential is unaffected, and so is the roundtrip script at the end
of this page when it runs with the operator credential (a paired device's
credential needs the grant).

For a saved Environment use `{ "kind": "saved", "id": "..." }`. The
controlling Station reaches that Environment through its configured peer or SSH
access, rewrites the forwarded target to `current`, and the target Station resolves
its own Agent. Tunnel URLs, provider IDs, and connection IDs are never request
inputs that choose where work runs; the one place a connection ID appears in a
request is the `expectedEngine` precondition below, which can only refuse.
Tunnel URLs are never response data.

Calls made by a station-control Agent also pass the
[dispatch authority checks](../guides/self-configuring-agent.md#dispatch-authority):
owner and Project scope constrain local work, and remote reach requires a bound
operator caller. These checks also cover input replies and follow-ups. They do
not replace the operator UI or paired Device's own request authorization. A new
Session such an Agent starts on this Station with no `workspace` runs in the
calling Session's own Project when that Project has a working directory and
the Session's owner may dispatch there, and a refusal for scope is
`station_control_out_of_scope` with a `reason`.
For a new Session, Station repeats the folder decision immediately before it
starts the engine. If the folder no longer resolves to the admitted canonical
path, or the directory the engine would start in belongs to another scope, the
request returns the same typed `403` and no engine starts.

An Agent that messages, interrupts, or waits on an existing Session uses
station-control's [Session control](../guides/self-configuring-agent.md#session-control)
tools, which call their own agent-only routes under
`/api/orchestration/session-control` rather than the routes above. That guide
also distinguishes ordinary idle from a verified requested-work settlement,
including the history-dependent limit on untagged terminal acknowledgement.
Its read-only companions, `list_project_activity` and `get_session_digest`, call
`/api/orchestration/session-activity` (see
[Station Control Project Activity](api.md#station-control-project-activity)) and
read as the calling Session's owner within the caller's Project.

The response is a foreground handle containing `conversationId`, `sessionId`,
`providerTurnId`, the
resolved Agent target, and an `ExecutionResolutionReceipt` describing the Environment,
Agent, engine kind, provider, and honest model launch plan. When the send started
its Session (a new conversation, a successor, or a handoff target), the handle also
carries `sessionStarted: true`, and the receipt's engine is that Session's. A turn
sent to an already-running Session omits it: the receipt then describes the Agent's
current binding, which can differ from the engine that Session runs on. A validated continuation
without an owned-worktree binding reports its server-read bound directory rather
than the Project's current default, including an accepted-key retry. Owned-worktree
bindings retain the existing repository-root receipt form. Changing the default
affects new Sessions; continuing a qualified retained Session still requires
current authorization for its recorded directory. The receipt itself grants no
authority.

A delegation's dispatch response (`POST /api/orchestration/delegations`) also
carries `resolution.confinement` once its session has started (#2494). It is
the session's confinement record, read back from that session's own
`session.started`: the level, whether it was required, the posture the engine
reported applying at that start (`confined`, `no-mechanism` or
`configured-but-failed`), the mechanism (`codex-sandbox` or `seatbelt`),
workspace access and policy basis. A Seatbelt record also lists the kinds of
writes its profile grants (`writeGrants`). A start that asked for confinement
but ran at Auto with none engaged names why in `fallback`
(`confined-credential-unavailable`, `config-root-pinned`,
`resume-bound-elsewhere` or `workspace-too-broad`). It
describes the start: a later per-turn re-tightening or grant revocation does
not update it until the next start. It is absent when the start recorded none
or its record was not readable when the response was built. A refused start
answers with the refusal's closed code (`confinement_mechanism_unavailable`,
`confinement_workspace_incompatible`, `confinement_not_observed`) and leaves
the conversation able to start again.
A start whose required confinement has no mechanism on this host is refused
before anything starts. See
[confinement providers](../design/approval-posture-server-ordered.md#410-confinement-providers-2494).

### Find out what became of a send

An existing keyed send with different submitted input returns HTTP `409`,
`success: false`, and `code: client_turn_input_conflict`; it does not accept a
new turn. The original input can still replay its provider turn. This applies
to the foreground, background, continue and explicit handoff orchestration routes.
Conversation-wide replay and live-key joins compare retained original proof
before returning a prior turn or reserving a successor Session. Inbox admission
also compares known proof before answering queued; queued placement retains that
server-captured digest through restart. Accepted handoff replay compares retained
original input proof without starting or sending again. While the inbox is actively placing a key, its route guard
may refuse a retry with `client_turn_in_flight` before this comparison; that
transient refusal accepts, queues and replays nothing. The legacy handoff marker
alone binds prepared effects, including trimmed text; it cannot establish the original raw input. Legacy rows
without original digest proof remain unknown, and older binaries cannot enforce
these conflicts. Keys remain optional outside surfaces that already require
one. See [TurnDeduplicator](../architecture/module-map.md#turndeduplicator) for
the exact submission scope, unsupported-input refusal and mixed-version limits.

A send that names its own idempotency key (`clientTurnId`, up to 200
characters) and its `conversationId` can be looked up afterwards, for example
by a device whose connection dropped before the answer arrived, or that was
closed mid-send:

```
GET /api/orchestration/conversations/<conversationId>/turn-deliveries/<clientTurnId>[?projectSlug=<slug>]
```

The lookup is read-only: it never sends, claims or releases anything. An empty
id, a `conversationId` over 512 characters or a `clientTurnId` over 200 is
refused with `400`. A successful lookup answers `200` with `data.outcome`:

| `outcome` | Meaning | Send the same key again? |
| --- | --- | --- |
| `not-received` | Nothing on this Station holds the key for you: no request carrying it is being handled, and no Session of the conversation holds a turn claim for it, except one whose owner died before it began invoking the engine (the next send of the key takes that claim over). Also the answer for a message the conversation's [inbox](#let-station-hold-a-follow-up) refused or that was withdrawn. | Yes — the same key can only ever make one turn. A refused held message is likely to be refused again: read its `reasonCode` in the inbox first. |
| `received` | A request carrying the key is being handled now (its Session may still be starting), or a live owner holds its turn claim. An unresolved claim reads `received` for at most 15 minutes, then `indeterminate` (an engine accepts a turn in seconds). A message the conversation's inbox is sending right now also reads `received`. | No — wait and ask again. |
| `queued` | The conversation's [inbox](#let-station-hold-a-follow-up) holds the message you sent behind a running turn, and Station sends it itself when that turn ends. It is safe to close the app. | No — withdraw it through the inbox instead. |
| `started` | The engine accepted the turn; `data.sessionId` and `data.turnId` name it. | No. |
| `indeterminate` | The turn may have reached the engine and nothing can prove it either way (its owner died after it began invoking, or gave the claim up after a failed engine call). | No — inspect the conversation. |
| `expired` | The turn was sent and retention evicted its record. | No. |
| `unknown` | Nothing here holds the key, and this Station forwards the conversation's sends to another Station or Environment, so it can prove nothing: the Project named by `projectSlug` defaults to another Environment, or this Station process forwarded a keyed send for the conversation (also when the conversation began here). | No — treat it like `indeterminate`. |

An authorized lookup that finds an explicitly settled prepared turn instead
answers `409` with this error envelope, not a successful delivery outcome:

```json
{
  "success": false,
  "error": "This turn was cancelled. A new request requires a new turn key.",
  "code": "client_turn_settled",
  "disposition": "cancelled"
}
```

The actual disposition is `cancelled` or `definitively-refused`. For the latter,
the fixed message is `This turn was definitively refused. A new request requires
a new turn key.` Neither case invents a provider turn ID or represents settlement
as `started`, `expired` or `indeterminate`. An ordinary POST that retries the
retained settled key is also refused with `client_turn_settled`; a deliberate
new request must use a new `clientTurnId`. The successful foreground handle and
lookup DTO are unchanged. This compatibility contract adds no HTTP operation
for preparing, cancelling or resuming a turn.

A conversation you may not read answers like a key nothing holds, so the
lookup reveals nothing about other callers' conversations. Read authorization
precedes claim inspection: an unreadable local conversation still answers
`200` with `not-received`, without a settlement code or disposition. The existing
forwarding rules above still apply to an absence answer. `received` comes
from the request being handled in this Station process, so a Station that
restarted answers from the turn ledger alone; pass `projectSlug` when the send
named a Project, so a Project that runs elsewhere answers `unknown` rather than
`not-received` after a restart too. The lookup is on no Station Control tool's
route table (an Agent cannot call it); a paired device reaches it with
`orchestration:read`. `@kontourai/station-sdk/client` exposes it as
`getTurnDelivery(apiBase, conversationId, clientTurnId, { projectSlug })`.

While a keyed send is being handled it is recorded for this lookup; if more than
1,024 keyed sends are in flight at once, a new one is refused with `503` and
`code: "foreground_delivery_capacity"` before anything runs (send it again).
This applies to `/chat`, `/chat/delegated` and `/chat/background`.

The `turn.started` event a keyed send produces carries the key the client sent
it with, stamped by Station (an engine cannot supply one): the send's
`clientTurnId`, or for a handoff `handoff:<idempotencyKey>`, the key the
handoff dialog names its message by, rather than the conversation-derived key
Station deduplicates the handoff under.

A key is one send for the whole conversation, not only for one of its
Sessions. A continuation can move to a new Session (the one it used ended, or
the request names a model its engine cannot switch to mid-Session), so before
it may do that Station reads the turn ledger for the key across every Session
of the conversation. Known original input is compared before replay or a new
provider effect: changed input returns `client_turn_input_conflict`. Matching input, or legacy unknown proof,
can replay a started turn (`providerTurnId`); authorized staged attachments
are bound to that turn. Staged bytes are authorized against the earlier claim's
Session and read without binding before digest comparison, including retained,
dead-invoked and reclaimable claims. The production continuation uses the caller's
read authority across every materialized Session; an unavailable or unreadable
lineage fails closed before key inspection or staged hydration. The same rule
applies before inbox admission and to the recorded sender's inspections during
placement and abandoned-start recovery; an unavailable result is never an empty
ledger or permission to send. Only after a safe start or replay is chosen
are they bound to its actual Session; tombstones retain no input proof.
An identical key another attempt still holds
joins that attempt: the retry waits (bounded) for its turn and answers with
it, or is refused `409` with the retryable `code: "client_turn_in_flight"` if
it does not resolve in time. That includes a claim the delivery lookup calls
`indeterminate` only because it is old, its owner alive or unknown (#3660): it
may still deliver. Only a key that may have reached the agent with nothing left
to resolve it (the attempt gave it up after a possible effect, its process
died after it may have invoked the engine, or its record expired) is refused
`409` with `code: "foreground_message_indeterminate"`. Nothing new is sent in
any of these cases. A handoff is deduplicated under its own key and is not
part of this check.

### Let Station hold a follow-up

A follow-up sent to a conversation whose turn is still running is refused
today, and the client holds it until the turn ends. A send to `POST /chat` that
adds `"whenBusy": "queue"` (with its `conversationId` and `clientTurnId`)
asks Station to hold it instead, in the conversation's durable inbox. The
message is stored before the answer arrives, so it survives a closed tab,
another device and a restart.

- When the conversation is busy (its current Session has a turn open, or
  earlier follow-ups are still waiting), the send is held and answered `202`
  with `data.outcome: "queued"` and the held `entry`. Otherwise it is sent at
  once, with the usual receipt. A send refused because the engine opened a turn
  itself (`provider_turn_in_progress`) or is still starting
  (`provider_session_starting`) can be held before its keyed dispatch begins.
  If the keyed dispatch has begun and is definitively refused, it closes that
  key: HTTP `409`, `success: false`, `code: "client_turn_settled"`, and the
  actual `disposition`. It is never queued again under that key. A new explicit
  user request needs a new key; clients must not generate one automatically.
- The same body sent again under the same key, while the conversation is still
  busy or holds other messages, answers the same entry (`sent`, with its
  `turnId`, once Station sent it). Sent when the conversation is idle and
  holds nothing, it takes the live path, whose turn claim answers with the
  turn already started. The same key with a different message is refused
  `409` with `code: "client_turn_input_conflict"` when original submitted
  identity is known; queue submissions against older entries without that proof
  retain the inbox's `inbox_key_conflict` payload comparison. A live retry by the same sender under
  a waiting key also stays in the inbox: matching input returns its existing
  `202` receipt, and different known input returns the typed conflict before
  any provider effect. A send to `POST /chat` or
  `POST /chat/<conversationId>/continue`, held or not, under a key
  the inbox holds for someone else in a state it may still send (`queued`,
  `sending`, `unconfirmed`) is refused `409` with `code: "inbox_key_held"`,
  so nobody takes the turn another person's message waits for. Only a caller
  who may read the conversation is told so; anyone else gets the dispatch's
  ordinary refusal for a conversation they may not read. While Station is
  sending a held message (from the moment its send begins, and past the point
  where Station gives up waiting for it, below), a send under its key that
  would take the live path is refused `409` with the retryable
  `code: "client_turn_in_flight"`. That goes to its own sender (anyone else
  is refused `inbox_key_held` first), or to anyone once the message is
  dismissed: dismissing it does not stop a send already under way, so the
  key stays refused until that send answers or Station restarts. Retry with
  the same key after that. While a conversation is moving to a new Session,
  Station cannot hold a follow-up, so a `whenBusy` send then takes the live
  path too. An inbox holds at most 50 unsettled
  messages; past that a send is refused `409` with
  `code: "conversation_inbox_full"`.
- Only a plain continuation can be held: no attachments, approval pick, input
  reply, visual skill start, engine or Agent-definition precondition
  (`expectedEngine`, `expectedDefinitionFingerprint`), delegated or background
  send, and no target on another Station. Its `target.agent` and
  `target.workspace` must name exactly the conversation's binding, since that
  binding is what the message is sent through later. The sender must be one
  Station would let send it then: the conversation's owner, or a reader the
  personal Station lets continue it, from a paired device or personal access
  token that is still live and still holds the scope `POST /chat` requires
  (`orchestration:operate`). A device or token tied to an account also needs
  that account enabled; Station checks this through its own local-account
  directory, so a Station without one (an account-tied person signed in
  through any other provider) never holds a follow-up from an account-bound
  device, and that send takes the live path. Any other busy send, and every send to a Station
  without an inbox (a hosted Station, or one that predates it, which ignores
  the field), is answered as before.

Station sends held messages one at a time, in the order received, each after
the turn before it ends, as the person who sent it, through the conversation's
persisted binding. Just before sending it checks again that the sender may
still send to the conversation and that their device is still paired with
the scope to (for one tied to an account, that the account is enabled and
was not signed out everywhere since the message was queued); otherwise the message is `refused` (`not_permitted` or
`device_not_permitted`) and nothing is sent. It never stores a full-access
grant: an engine restarted to take a held message starts confined. Each
message keeps its `clientTurnId`, so the
[delivery lookup](#find-out-what-became-of-a-send) follows it, and Station
reads that same ledger, across every Session of the conversation, before each
send: a message an earlier attempt already started is settled `sent` without
sending it again, even when the conversation has since moved to a new
Session. A message that may have reached the agent without Station being able
to prove it (it stopped mid-send) is `unconfirmed`: it is never sent again,
and the messages behind it wait until someone dismisses it. One whose send
did not answer within ten minutes is `unconfirmed` with `start_deadline`
until Station can tell: it becomes `sent` if the ledger shows its turn
started, or waits again if no Session took its key, but only once that send
has answered, so the abandoned send and a new one never run together. A
send that never answers at all leaves its message `unconfirmed`, holding the
messages behind it, until someone dismisses it or Station restarts (after a
restart the old send is gone, and the ledger decides). While a held message
waits on a Session that is starting, Station looks again when the Session
reports a change, and on a schedule (2, 10, 30 and 120 seconds, then every two
minutes): at most 30 such re-checks until a message is sent or a new one is
accepted. A held message whose key another attempt still holds, including a
claim that is only old (owner alive or unknown, which may still deliver),
stays `queued` and is never sent twice. It holds the messages behind it until
that attempt resolves or its sender withdraws it.

```
GET    /api/orchestration/conversations/<conversationId>/inbox
DELETE /api/orchestration/conversations/<conversationId>/inbox/<clientTurnId>
```

`GET` lists the conversation's held messages (`ConversationInboxEntry`:
`state` is `queued`, `sending`, `sent`, `unconfirmed`, `refused` or
`cancelled`, with `position` among those still waiting, and for a `refused`
or `unconfirmed` one a `reasonCode` and a fixed `reason`, never the refusal's
own text). `reasonCode` is one of `not_permitted`, `device_not_permitted`,
`may_have_been_sent`, `start_deadline`, `unreadable_entry`, `session_ended`,
`execution_engine_changed`, `provider_session_start_failed`,
`model_not_advertised`, `continuation_workspace_unbound`,
`continuation_workspace_direct_mismatch`,
`continuation_workspace_project_context_missing`,
`continuation_workspace_corrupt_worktree_binding`,
`continuation_workspace_worktree_gone`,
`continuation_workspace_different_project`,
`continuation_workspace_worktree_moved`, or `start_refused` for any other
refusal. Every client of the conversation sees the same list, except that
someone else's message that may still be sent (`queued`, `sending`,
`unconfirmed`) is shown without its `clientTurnId`. A
conversation you may not read, or a Station without an inbox, answers `404`.
`DELETE` withdraws a waiting message (its sender only), or dismisses an
`unconfirmed` or `refused` one (anyone who may send to the conversation, so
one person's possibly-sent message cannot hold everyone's). Anyone else gets
`404`. A message being sent right now answers `409` with
`code: "inbox_entry_sending"`, and one already sent `inbox_entry_sent`.

Committed inbox transitions emit `orchestration:inbox-changed` with
`{ conversationId }` on `/api/orchestration/events`, only to readers of that
Conversation. The general `/api/events` route does not relay it. The UI
invalidates that exact inbox query, with a 30-second foreground safety poll
when no entries are pending or uncertain. Queued, sending and unconfirmed
entries use 2 seconds (10 seconds on an explicitly constrained network).
Background polling pauses; HTTP 401/403/404 stops interval retries.

Deleting the conversation deletes its held messages. `@kontourai/station-sdk/client`
exposes these as `queueExecutionMessage`, `listConversationInbox` and
`cancelConversationInboxEntry`.

### State the engine you expect

A client that shows an Agent to a user knows which engine the Agent ran on *when
it was shown*. A request may state that as a precondition:

```json
{ "expectedEngine": { "kind": "station" } }
```

or `{ "kind": "connection", "connectionId": "<engine connection id>" }`. It has
the shape of the receipt's `engine`, and it never selects: the target Station
still resolves the Agent's binding itself. When that resolution names a
different engine, the request is refused with `409` and
`code: "execution_engine_changed"` before anything is started or reserved, and
the message names the two engines. Absent, no expectation is stated. The fields
are strict: nothing beside `kind` (and `connectionId` for a connection) is
accepted, so it cannot carry an endpoint or credential.

The Station UI states it only on a chat's first send, only to this Station
(an explicit current Environment, not a Project's default Environment), and
only when its Agent catalog snapshot is settled; it re-reads the catalog and
asks the user to look again after a refusal. A receiver from before this field
ignores it, so a caller that needs the guarantee must know its receiver's
version.

### Preserve an Agent profile with an execution override

`ExecutionTarget.agent` normally contains the clean Agent ID. An explicit
receiver-owned execution binding uses this discriminated variant:

```json
{
  "kind": "agent-execution-override",
  "agent": "reviewer",
  "executionAgent": "codex",
  "expectedDefinitionFingerprint": "<receiver-computed SHA-256>"
}
```

`agent` remains the authored profile; `executionAgent` must be a registered
execution default on the destination Station. It selects the engine connection
and its account, never a caller-provided URL or credential. The profile's
instructions, skills and tool policy must be deliverable; missing delivery is a
refusal rather than a substituted profile. The optional fingerprint fences the
loaded authored definition, excluding execution and display provenance. It does
not verify installed tool or skill contents. An older string-only receiver
rejects this object instead of silently ignoring an engine selector.

Accepted execution/handoff receipts and conversation-open projections retain the
binding and expected fingerprint. Continuation reconstructs them from persisted
session metadata. Changing the engine on a bound conversation requires an
explicit handoff; omitting the override on that handoff restores the authored
binding and model default.

The optional conversation-open `execution.environment: { kind: "current" }`
requires the authorized current child's persisted start Environment identity to
match this receiver's existing Environment record. Peer activity, foreign,
legacy/unknown or unavailable identities omit it. It does not consult mutable
Project defaults or borrow the predecessor's identity. The UI uses this fact to
restore current-Station placement without reinterpreting an existing binding.

## Continue a conversation

Continuation retains the original Environment/workspace and follows the current linked Session:

```jsonc
POST /api/orchestration/chat/<conversationId>/continue
{
  "message": "Continue",
  "ambientContext": "optional, max 4000 chars",
  "attachments": "optional ChatAttachmentInput[], max 5",
  "clientTurnId": "optional idempotency key"
}
```

There is no replacement target on continuation. Station loads the persisted
binding, verifies the caller and current Environment, resolves the current Agent,
and only then sends the turn. Optional `model.override` and `model.options` apply
only when that engine supports them; omission retains the current model choice.

On either route, when the bound engine is an ACP engine, a send whose
attachments it cannot take (its handshake did not advertise image input, or a
non-image file) is refused before any engine effect with
`code: "attachment_input_unsupported"`. The same request is refused again, so it
is not a retry candidate. Staged uploads the refused send had bound are released
from that turn, so the same references can be sent on another turn. Codex and Muse refuse a non-image file with a plain
error that carries no code.

A start or send that Station cannot run under the chat's approval mode on
OpenCode is refused before any engine effect with
`code: "acp_approval_governance_refused"`: OpenCode's resolved rules override
Station's, the chat runs an agent Station does not govern
([which side decides](../guides/acp.md#which-side-decides-which-calls-ask)), or
the project's OpenCode configuration declares code OpenCode runs at launch
([what the modes cannot govern](../guides/acp.md#what-ask-and-auto-cannot-govern-on-opencode)).
The message names the setting and says what picking Default would do in that
chat. A refused start keeps that code: it is checked before Station claims the
start, so it is never reported as a start that may have happened
(`SESSION_START_INDETERMINATE`). The same request is refused again until that configuration or the
chat's mode changes, so it is not a retry candidate.

A send that starts a new ACP session on a model the engine's fresh session
options did not offer is refused with `code: "model_not_advertised"`. The start
is settled, not uncertain: the thread is not fenced behind an inspection, the
receipt is `rejected`, and the refused session has ended with the engine's
refusal as its cause. It is not a retry candidate as sent. Sending again in the
same conversation (another model, the same one, or no override) continues in a
successor session; a start naming a model on the refused session id itself is
refused.

A completed turn does not discard the conversation. If the next turn needs a new
execution Session, it remains linked beneath the same Conversation. Station-native
prompt history reads existing authorized native memory segments across that
lineage. This preserves structured messages without copying earlier records into
the new Session or changing its approval/write identity. Earlier harness or Agent
legs contribute their authorized user/assistant transcript, not provider-private
tool state. An explicit empty-context boundary excludes earlier model context even
while the historical transcript remains visible. Callers never supply native
memory paths or another Session's memory identity.

## Lifecycle control commands

`POST /api/orchestration/commands` is a control surface, not an execution selector.
It accepts `adoptSession`, `interruptTurn`, `steerTurn`, `steerTurnOnce`, `inspectSteerInput`, `respondToRequest`,
`setApprovalMode`, `discardDraft`, and `stopSession`. Commands use the execution
Session ID as `threadId`, not an assumed copy of the Conversation ID.
Public `startSession` and `sendTurn` commands do not exist; adapter dispatch remains
an internal service primitive.

### `respondToRequest`

Resolve an in-flight tool-approval/permission prompt — the programmatic equivalent of
clicking Allow/Deny on an approval card. Requests surface as `request.opened` canonical
runtime events (see [Reading session activity](#reading-session-activity)); resolve them
by `requestId`.

Codex approval events larger than 48 KiB are refused on the wire before they
enter the approval inbox. Station emits `codex-approval-request-too-large` and
asks the Agent to split the operation. It never offers approval over truncated
command or permission details.

For Codex, this is Station's canonical string ID. The
[adapter](../../src-server/providers/adapters/codex-adapter-transport.ts)
maps it to Codex's original wire ID and preserves that ID's value and type in
the reply. Numeric `0` and string `"0"` are different IDs: converting between
them previously left an approval resolved in Station while Codex kept waiting
([#562](https://github.com/kontourai/station/issues/562)). The
[adapter tests](../../src-server/providers/__tests__/codex-adapter-rpc-id.test.ts)
cover explicit decisions, session grants, interrupt cancellation, and unsupported
requests through simulated process streams; they are not a live Codex receipt.

```jsonc
{
  "type": "respondToRequest",
  "threadId": "string, required, min length 1",
  "requestId": "string, required, min length 1 — from the request.opened event",
  "decision": "'accept' | 'acceptForSession' | 'decline' | 'cancel'",
  "sessionGrantScope": "'server', optional, only with acceptForSession"
}
```

Harness questions and a tool server's form elicitation carry a
`station.input-request/v1` form as `payload.inputRequest` on `request.opened`
(see [shared input request helpers](shared.md#input-request-helpers)). An
event stored before #3390 carries `payload.questionnaire` instead and is read
as the same form. To answer, send the exact `expectedRequestEventId` and one
of `accept` (with `content`, keyed by field name), `decline` or `cancel`;
`acceptForSession` is refused:

```json
{
  "type": "respondToRequest",
  "threadId": "session-id",
  "requestId": "request-id",
  "expectedRequestEventId": "opened-event-id",
  "decision": "accept",
  "content": {
    "target": "0",
    "checks": ["1", { "custom": "Smoke tests" }],
    "name": "Ada"
  }
}
```

A choice field takes an option value, a multi-choice field a list of them,
and a field with `allowCustom` also takes `{ "custom": "text" }` in an
option's place. Accepted content is validated against the form the person was
shown: an unknown or missing required field, or a value outside its type,
length, format, range or choices, is refused with a reason before the
request is resolved; nothing is coerced or cut to fit. Limits are 32 fields,
64 options per field and 12,000 characters per text answer. A decline or
cancel cannot carry content. Claude answers map back to question text; Codex
answers retain question IDs and the original RPC ID; cancellation sends Codex
an empty answer map.

The pre-#3390 `answers` field (`{ "question-id": { "optionIds": [...],
"custom": "..." } }`) is deprecated since 0.9.0 and remains accepted in
0.10.0 for compatibility. It is translated to `content` and validated the
same way; new callers should send `content`, never both.

`blocking: false` means an optional question: opening or resolving it does
not change turn progress. Snapshots expose `blockingOpenRequestIds` separately
from all `openRequestIds`; older hosts omit that field and retain the legacy
blocking interpretation. A snapshot carries ids only, so after a reload a
client reads the conversation's newest turn to rebuild each open approval's
tool, preview and grant label. When a request is not in that turn, the client
follows the event window's `nextCursor` to older turns, at most three further
pages of five turns, and stops as soon as every open request is found. It keeps
a generic placeholder when the host cannot supply the request, including one
older than that bound. Request inspection sets `requiresAnswers` so clients
route to the Session instead of offering a generic approval button.

A tool server's form elicitation during a Station-agent turn (#3284) is the
same form request, with source `mcp:<serverId>`:

```json
{
  "type": "respondToRequest",
  "threadId": "session-id",
  "requestId": "elicitation-id",
  "expectedRequestEventId": "opened-event-id",
  "decision": "accept",
  "content": { "name": "Ada", "age": 36 }
}
```

Accepted content is validated against the form the person was shown: an
unknown or missing required field, or a value outside its type, length,
format, range or choices, is refused with a reason before the request is
resolved. Values are never coerced or truncated (text at most 12,000
characters). `decline` and `cancel` cannot carry content. Inspection sets
`requiresAnswers` for these requests too. The
[MCP host design](../design/mcp-ui-host.md#mcp-client-feature-support) records
the supported form subset.

`acceptForSession` also grants later calls to the same tool in that Session.
The grant never covers an escalation beyond the call. In a Claude Session, a
request that suggests a directory, reports a blocked path or matches a user
ask rule still prompts. Answering one for the session mints no tool grant and
forwards only the engine's directory suggestions, and the same holds for
every Read, Glob, Grep and LSP request. For a plain file edit outside plan
mode and full access it forwards only the engine's `acceptEdits` mode change
and mints no tool grant. Sent through this command, which carries
`setApprovalMode` authority, it also records an `auto`
`session.approval-mode-set` decision for the conversation once the engine has
taken it, as a `setApprovalMode` of Auto based on the decision standing
before the answer would. If any decision was recorded after the answer was
sent, that decision stands and nothing is recorded. It is not recorded over a
standing Auto or full access. It then lasts until the next approval-mode
decision. Through the delegated-task respond route for a task on this Station,
or the inbox, the same answer is sent as `accept` and records nothing. A
delegated answer for a task on a saved Environment reaches that Station as
this command, and that Station applies the same rule. Where nothing can be
forwarded, for a file edit in plan mode or under full access, and for
`ExitPlanMode`, `acceptForSession` counts as `accept` (#2915, #2916). In an
ACP Session it also counts as `accept` for a plan exit (a `switch_mode` tool
call or `ExitPlanMode`), which mints no Station session grant (#2933). On an
OpenCode Session Station governs, `acceptForSession` on a file edit is sent to
the engine as `accept`, and Station keeps the grant itself, because OpenCode's
"always" for an edit covers every later edit. Station's grant never covers an
edit of OpenCode configuration or outside the project (#3924). A
`cursor/create_plan` plan review is a form, so `acceptForSession` is refused
for it like any form.
The ACP response mapper prefers the agent's `allow_once` option. If the
agent offers only `allow_always`, it falls back to that option; Station's
one-call decision therefore does not guarantee one-call behavior in the
agent. Claude's own plan exit uses its separate response mapping (#2916).

`sessionGrantScope: 'server'` widens an `acceptForSession` answer from the one
tool to every later call to the built-in `station-browser` server in that
Session. A Claude Session offers it only on a request whose `request.opened`
payload carries `stationBrowserServer: true`, which the adapter sets only for an
authentic call: the engine-generated `mcp__station-browser__<tool>` name, the
built-in in-process server delivered to that Session, and no authored tool
server using the id, and an engine `init` report listing exactly one
`station-browser` server whose source is `sdk` (fail closed when the source is
absent or the name is shared; the grant also covers subagents in the Session).
A server merely named like it, an ACP-reported name or a
Session without the built-in server never gets the flag. The grant lives with
the Session record, as the per-tool grant does: it is not shared with another
Session or server, and a stopped or restarted Session starts with none. It
covers only plain calls, so an escalation still prompts. The server choice
does not mint an independent tool-name grant or SDK permission rule: every
later call still passes the current browser authenticity check. It does not change
the #90 N2 policy: auto mode and `tools.autoApprove` patterns such as `*` or
`station-*` still never cover a sensitive browser tool. A request without the
flag, an answer that omits the field (every older client) and every other
decision keep the per-tool `acceptForSession` behaviour; an engine that does
not read the field, and a Station that predates it, grant the one tool. The
inbox offers it as the `acceptForSessionServer` action, which sends the same
typed decision. The delegated-task respond route does not accept the field.

A Claude Session also treats these as escalations that always prompt, even
under a tool grant or an agent's `autoApprove` of `*` (#2932): the sandbox
network-host ask (`SandboxNetworkAccess`), which offers no session option and
names the host in its title, so every new host prompts; a call with
`dangerouslyDisableSandbox: true`; a request whose `decisionReason` is
exactly `dangerouslyDisableSandbox`, `requiresUserInteraction` or `Your
organization requires approval for this tool`; and a request flagged
`suppressAlwaysAllowRule`, `defaultToNo` or `requiresUserInteraction`. Agent
SDK 0.3.278 forwards the first two; Station reads `requiresUserInteraction`
from the engine's own request. `request.opened` carries the sanitised
`decisionReason` and any of the flags that are set.

An approval-guardian allow is held to the same rule (#2947). In a Claude
Session it answers a plain call with no `request.opened`, unless an effective
authored `askBeforeUse` rule requires approval; an escalation, a
plan exit or a question opens a request even when the guardian allowed the
call. In an ACP Session it answers no plan exit, question or sandbox
network-host ask.

Station also reads the engine's structured reason and classifier facts for
each ask from the engine's `can_use_tool` request (#2932). The current SDK
forwards reason and interaction fields, while the tap retains the classifier
approval fact and the complete recorded ask. The same rule applies: these
always prompt, under a tool grant or `autoApprove`
of `*`, and offer no session option unless the engine suggested a directory
to forward.

- An ask with a reason type other than `other` and `subcommandResults`: an
  ask rule (`rule`), a safety check (`safetyCheck`), a sandbox override, a
  path outside the working directories, and the mode, hook, classifier,
  permission-prompt-tool and headless-agent types, plus any type a later
  engine adds.
- An ask whose `classifier_approvable` is set, which the engine does exactly
  when a safety check is involved, in any part of a chained command too.
- An ask with a `decision_reason_code`.
- Every PowerShell ask. PowerShell wraps an ordinary command and one with a
  security warning in the same `subcommandResults` shape.
- A chained Bash command (`subcommandResults`: `a && b`, `a; b`, a pipeline)
  whose request carries `classifier_approvable`, any `decisionReason` text, a
  `matchedAskRule`, a blocked path, a directory suggestion, a sandbox
  override or an ask flag.
- An ask of type `other` whose reason is not exactly `This command requires
  approval`, the text Claude Code 2.1.278 sends for an ordinary single Bash
  command.
- An ask whose request Station could not read. This fails closed: a changed
  or missing request costs a prompt, never a grant.

An ask with no reason type is a plain call: that is what the engine sends for
an ordinary MCP tool call, WebFetch, and a file edit inside the working
directories. A Bash or PowerShell ask with no reason type prompts: the
ordinary Bash ask carries `other`, and the Bash asks the engine sends without
a type are path checks, which carry a blocked path. `request.opened` carries the result as `claudeAsk`: an object
with `decisionReasonType`, `classifierApprovable` and `decisionReasonCode`
where the engine set them, or `null` when the request could not be read.
Other engines send no `claudeAsk`.

A chained Bash command with none of those signals is a plain call, so a Bash
grant or an `autoApprove` pattern answers it. The engine does not send the
reasons of a chain's parts, which leaves an accepted gap. A safety check on
any part always prompts, and an ask rule on a single command always prompts.
Inside a chained command these carry no signal and are answered: (i) any
`permissions.ask` rule that applies to the chain or to one of its parts,
exact or prefix, whenever more than one part needs approval; (ii) a write or delete outside the working directories in an
`&&` or `;` chain, or in a pipeline with an output redirect; (iii) a part's
warning that is not a safety check. These gaps exist on `main` today, and
closing them needs the engine to send the nested reasons (the
[delivery boundary](../conformance/tool-policy-delivery.md) has the captured
shapes). The ordinary Bash ask is recognised by its text: if a later engine
rewords it, ordinary Bash calls prompt until Station is updated.

A session answer never writes the engine's settings files: every forwarded
suggestion is sent with `destination: 'session'`.

The command records the decision: the adapter publishes `request.resolved`
when Station records it, on every engine. Whether the engine then received it
is a separate fact (#2880), declared per adapter as
`approvalAcknowledgement` and stamped on each decision's `request.resolved`
as `acknowledgement`:

- `engine` (Codex, Muse): a later `request.delivery` event reports
  `outcome: 'acknowledged'` when the engine closes the request after
  Station's well-formed reply, or `outcome: 'unacknowledged'` with `reason:
  'no-acknowledgement'` (none within the adapter's window, or the session
  ended first; Station does not re-send) or `'invalid-reply'` (Station refused a reply outside the
  engine's decision vocabulary and never sent it). A late `acknowledged`
  supersedes an earlier `unacknowledged`. "Acknowledged" never means the
  engine applied the decision as given; Muse's `engineStatus` carries the
  engine's own outcome. A request Codex closes itself before Station
  answers resolves `cancelled` with `response.reason: 'closed-by-engine'`
  and no `acknowledgement`; a later decision on it is refused. A close that
  crosses Station's reply in flight still reads `acknowledged`, although
  Codex discarded that reply: its close does not say which came first.
- `in-process` (Station's own engine): consumed in-process; no delivery
  event follows.
- `none` (Claude Code, ACP): the protocol has no acknowledgement, so
  delivery is not reported.

An open request in the attention inbox closes on `request.resolved`, so an
answered request leaves the inbox when the decision is recorded; an
unacknowledged decision surfaces as a `runtime.warning` on its session, not
as a reopened request.

A request also closes, with no decision, when the turn it belonged to is
aborted. Two aborts count, and they settle different sets
([`requestIdsSettledByTurnAbort`](../../packages/shared/src/request-settlement.ts)):

- **Station restarted mid-turn.**
  [Interrupted-turn recovery](../../src-server/services/orchestration/interrupted-turn-recovery.ts)
  records `request.resolved` with status `expired` and `response.reason:
  'turn-interrupted'` for every request still open that was opened since the
  dead turn started and before any other turn started, then aborts the turn
  (`turn.aborted` with `recoveryTerminal`). The session reads `needs_input` with transition reason
  `runtime_exit`, not `review_pending`. A turn still running at a normal stop
  takes the same path on the next boot: the `session.exited` Station writes as
  it shuts down (`reason: 'orchestration_shutdown'`) does not retire the
  turn's boundary, so recovery finds it as it would after a crash. The session
  stays `closed` with its folder and resume cursor, so the next message
  continues the conversation. No `session.state-changed` reopens a `closed`
  or `dead` session, whatever its source; only a new `session.started` does. A log written before recovery recorded
  those resolutions holds the abort with the request still open; every server
  read treats that request as settled all the same.
- **A live turn was stopped**: `turn.aborted`, or the
  `turn.completed` with `finishReason: 'cancelled'` an engine publishes to
  confirm a stop. This settles only a request whose `request.opened` names
  that turn in `turnId`. Claude Code stamps it on the main thread's requests,
  and Muse and Station's own engine on their turn's; a request with no
  `turnId` (Codex and ACP today, and a subagent's on Claude Code or Muse) is
  left open by this rule, because work that outlives the turn may still be
  waiting on it. Separately, the adapters read for this change (Claude Code,
  Codex, ACP) resolve the requests they hold `cancelled` when they stop a
  turn or session, a subagent's included on Claude Code; that publication,
  not this rule, is what normally closes them.

A turn that fails without being aborted (`runtime.error` or `session.exited`
alone) settles nothing, and neither does an ordinary `turn.completed` or a
request opened before the turn started.

A settled request is refused by Station itself: `respondToRequest` returns
`409` with code `request_event_changed`, with or without
`expectedRequestEventId`, and no adapter is called.
[Request inspection](#inspect-an-exact-attention-request) reports it `resolved`. The session summary
(`pendingReview`, `openRequestIds`), the attention inbox, the request's
replayed outcome, and the CLI's `approvals list` and `operate` leave it out.
A client that folds raw events without the shared rule still sees it open.

### Other command types

The remaining controls are defined by
`src-server/routes/orchestration/orchestration.ts`:

- `steerTurn`: `{ type: 'steerTurn', threadId, input, turnId?, clientInputId? }` sends steering
  input where the engine supports it. An ACP engine without a native steer
  method is steered by cancelling and re-prompting the running turn; that
  steer's `turn.started` carries `steerInterruptedRun: true`.
  On this server, a stable `clientInputId` makes acknowledgement retries safe: a durable claim
  precedes the adapter call, confirmed same-ID input returns its stored result,
  and an unresolved or mismatched claim returns `outcome: 'indeterminate'`
  without invoking the engine again. Retain the original `threadId`, `turnId`
  and input on retry. Never turn an indeterminate steer into an automatic new
  turn; retain it for review. The digest-only claim survives restart and is
  removed with its Session. Calls without this optional ID retain the legacy
  behavior and cannot claim transport idempotency.

- `steerTurnOnce`: `{ type: 'steerTurnOnce', threadId, input, turnId?, clientInputId }`
  requires a stable ID and normalizes to the same internal `steerTurn` command
  before authorization and dispatch. Older servers reject this distinct wire
  type before any engine invocation; they cannot silently discard the ID. The
  receipt's `commandType` remains `steerTurn`. Use this variant for retry-safe
  clients that may connect to older servers.
- `inspectSteerInput`: `{ type: 'inspectSteerInput', threadId, input, turnId?, clientInputId }`
  reads the original journal identity and returns `steered`, `indeterminate` or
  `not-received`. It creates a standard command audit receipt, but never resolves
  an adapter or invokes an engine. Inspect uncertain delivery first; only
  `not-received` permits a protected same-ID first attempt. An unsupported lookup
  or unresolved claim must remain held.

- `setApprovalMode`: `{ type: 'setApprovalMode', threadId, approvalMode,
  basedOnSequence }` records an ordered posture decision. `basedOnSequence` is
  required: use the latest observed decision sequence, or `null` when none was
  observed. A stale basis refuses the change. An engine with no approval
  control refuses it; on ACP that is decided per connection, and only an
  engine whose approval rules Station sets at launch (OpenCode) has one
  ([which side decides](../guides/acp.md#which-side-decides-which-calls-ask)).
- `discardDraft`: `{ type: 'discardDraft', threadId }` asks the server to verify
  and discard a Draft; it is not a general Session deletion. After committed
  thread deletion, the server emits `orchestration:sessions-changed` with an
  empty payload on the orchestration SSE stream. This invalidates connected
  clients' lists only if they could read the Session before deletion. The server
  captures that audience before removing ownership records, keeps it internal
  through commit, and rechecks request authority at delivery. A thread-filtered
  stream receives only its own deletion; the general `/api/events` route never
  relays this notice. Deleting a nonexistent thread emits nothing. The same
  post-commit notification covers attached-alias and other
  thread cleanup paths. It is a live invalidation, not a durable replay event;
  reconnect/list reads and the client's safety poll recover a missed notice.

The other lifecycle controls are `adoptSession`
(`{ type: 'adoptSession', sourceThreadId, idempotencyKey?, target? }`, create an independent continuation of a
read-only attached session; a UUID idempotency key safely replays the same
Continue intent and returns the existing continuation with
`alreadyAdopted: true`; `target` is described below),
`interruptTurn` (`{ type: 'interruptTurn', threadId, turnId? }`, cancel an in-flight turn),
and `stopSession` (`{ type: 'stopSession', threadId }`).

External transcript observation does not grant control of the original terminal
process. The engine capability matrix declares independent continuation support;
known unsupported and unknown engines keep the conversation's message box
disabled with a reason. The adoption owner enforces the same declaration before
invoking an adapter, then checks current source, Project, ownership, and runtime
requirements. A native continuation declaration does not guarantee readiness of
any particular source.

Codex rollout observation reads the local `CODEX_HOME/sessions` directory
(`~/.codex/sessions` by default) through bounded, read-only pages. It imports
supported turn boundaries, user messages, assistant text, public reasoning
summaries, tool activity, cumulative token snapshots, and compaction markers.
Every discovered transcript enters the shared follower
([`AttachedSessionFollowService`](../../src-server/services/orchestration/attached-session-follow-service.ts)),
which attributes it with `resolveAttachedSessionProject`: first a Project whose
working directory contains the transcript's cwd (longest root; two Projects on
one root are `ambiguous` with both named), then a Project whose working
directory is in the same git repository, read from the `.git` entry and its
`commondir` pointer without running git
([`attached-session-repository.ts`](../../src-server/services/orchestration/attached-session-repository.ts)).
The cwd's path inside its worktree is compared with the Project's path inside
its own, so any worktree of the repository matches. A transcript neither
step claims is followed with `projectAttribution: 'unattributed'` and no
`projectSlug`; the summary then carries neither field. An unattributed result
never replaces an attribution the log already records, unless a project that
attribution names is no longer configured while the project set is non-empty
(an empty set, which `listProjects()` also returns when the projects
directory is missing, is not treated as a deletion). A repository match counts only a
genuine checkout: a real `.git` directory that is its own common directory, or
a linked worktree whose git-written `gitdir` back-pointer names that `.git`.
A symlinked `.git` or a submodule's `.git` file matches by folder only.
Discovery reads these folders (the real path of each cwd and Project
directory, and the repository walk) in one helper process
([`attached-session-path-probe.ts`](../../src-server/services/orchestration/attached-session-path-probe.ts)),
never on the server's main thread. When that process answers nothing for
1.5 seconds, as on a network or FUSE mount that has stopped responding, it is
killed and replaced, and every folder it still owed is unread for that poll.
An unread folder takes no part in matching: a transcript in one is followed
as `unattributed` (which never replaces a recorded attribution), and a
Project whose directory is unread is not matched. A folder that does not
exist is different: it keeps its path as written. The folder the process was
stuck on is not read again for 60 seconds, nor while that process is still
alive. At most four killed helpers may still be alive before no new one
starts; until one exits, which is logged, only folders under one they hung on
are unread, and every other folder is matched as a missing folder is. A
transcript in an unread folder that the log already files under a Project is
still followed under it even where unattributed transcripts are not. The next
poll that reads the folder corrects a new transcript's
attribution. `adoptSession` still resolves its folder, and walks to its
repository, with synchronous `realpath` and `lstat` calls on the main thread
([`attached-session-continuation-place.ts`](../../src-server/services/orchestration/attached-session-continuation-place.ts)),
so adopting a transcript whose folder is on a hung mount can still block the
server. The
local operator owns every attached transcript whatever its attribution, so the
operator's paired devices with `orchestration:read` can read it through
`personalConversationAccess`. Imported turns enter the owner-scoped message
search projection. `AppConfig.attachedSessionsOutsideProjects: false` stops
following unattributed transcripts from the next poll, already listed ones
included; it deletes no imported event, search entry or read grant. A hosted runtime
(`STATION_HOSTED_TENANT_REGISTRY_FILE` set) never follows unattributed
transcripts. It does follow attributed ones, but without a tenant binding no
account can read them.

A poll that finds no new event and no change to the stored attachment writes
nothing. A real change (new events, cursor, source handle, affinity, completed
turn boundary) stamps `updatedAt` with the latest imported source-event time,
or the creation time when there is none, never the poll time. Server-owned
facts on the row (model, persistence posture, tenant and lineage) are kept only
while the source subject (provider, kind, native id and source-home affinity)
is unchanged. A transcript new to a thread id, or a changed subject, is
imported only after startup session recovery has finished, and never under a
thread that is quarantined, failed recovery, or holds a tenant binding. If
recovery fails, no new subject is imported until restart, while existing
attachments keep following; each refusal counts as a `rejected_candidate`
discovery outcome.

`adoptSession` decides where the child runs from the transcript's cwd at
adoption time, not from the stored attribution
([`attached-session-continuation-place.ts`](../../src-server/services/orchestration/attached-session-continuation-place.ts)).
The cwd must still exist as a directory; it is symlink-resolved and attributed
again with `resolveAttachedSessionProject` and a fresh repository lookup, and
checked once more just before the engine is started. The child's cwd is always
that resolved folder, and the engine is confined to it under the request's
`workspace`/`host` grant as for any adoption. Station never relocates a
conversation to another folder.

- Attributed (by folder, or by repository from a worktree outside the Project
  folder): the child records the Project's `projectSlug` and `localProjectId`.
  `target` may be omitted or `{ kind: 'project', projectSlug }` naming that
  same Project; `{ kind: 'own-folder' }` is refused.
- Ambiguous: refused, naming the candidates.
- Unattributed: refused unless `target` is `{ kind: 'own-folder' }`, which
  creates a No project child (no `projectSlug`) confined to the cwd. That is
  refused on a hosted runtime. Otherwise the resolved cwd must be strictly
  inside the resolved home folder (`noProjectFolderRefusal`), and not inside a
  dot-folder directly under home (every one, not a list of credential
  stores), `~/Library` or `~/AppData`, not the system temporary folder or a
  folder containing it, and not overlapping the Station runtime home. The
  recorded cwd must not reach its folder through a symbolic link inside the
  home folder, so the folder the person confirmed is the one the child runs
  in. A different letter case or Unicode normalization of the same folder,
  and links above the home folder (a linked or automounted home), are
  accepted. Every refusal message names no path.
  `{ kind: 'project', projectSlug }` is refused, because the cwd is not part of
  any Project.

Every adopted child records its resolved folder as
`dispatchCanonicalCwd`, so a later engine start for it (a restart's
recovery) refuses a folder that no longer resolves there
(`assertDispatchCwdUnmoved`).

An adopted child also records the execution binding a chat started from the
dock records: the engine's own Agent (`agentSlug`, `targetKind: 'agent'`,
`targetId`, `connectionId`, found by the rule New Chat's Enable uses, never
created by adoption), this Station's `environmentId`, and itself as its
`conversationId`. A child in a Project also records
`workspaceIsolation: { mode: 'shared' }`. `GET /api/conversations/:id/open`
then resolves it, and a `POST /api/orchestration/chat` follow-up whose
workspace names only the child's Project continues it in its recorded
`dispatchCanonicalCwd` (the Project folder, a folder inside it, or a
worktree), never the Project folder instead. A follow-up that names a folder
or an isolation meets the ordinary exact checks. A later Session of the
conversation, started after the child's engine exited, starts in that same
recorded folder, even a worktree outside the Project folder, only while the
folder still resolves to the record and still passes adoption's check (the
Project folder or a genuine worktree of its repository); otherwise it is
refused as outside the Project. When the engine has no Agent
on this Station, the child is created without a binding: Activity continues
it, and the dock reports why it cannot open it.

A refusal of the folder or Project answers 400 with
`code: 'continuation_place_refused'` and `retryable: false`: the same request
is refused again until the folder or the Projects change, so clients show the
reason and offer no retry. The Starter Work launch reports it with
`retrySafe: false`. An engine that fails its readiness check before
anything is created answers 400 with `code: 'continuation_engine_not_ready'`,
`retryable: true` and the engine's readiness report in `error`; the Starter
Work launch settles it as `failed` with `retrySafe: true`. Other adoption
failures keep their retryable answers.

`target` accepts only these two shapes; any other field, such as a path, is
refused at the route. The Starter Work `continue-session` launch accepts the
same `target`.
Encrypted content and subagent sidechain traversal are outside this importer.
Additional user input after observed assistant or tool activity keeps the same
native turn identity and is marked as steering. When the rollout does not
establish that phase, the text remains in a bounded diagnostic without a guessed
initial-input or steering classification.
A tool-output body alone does not establish success or failure; it is retained
as observed progress without inventing a verdict. Discovery and parser limits
are reported as incomplete observations. Cursor progress is saved after the
page's events, so an interrupted import replays through durable event-id
deduplication.
Import loops yield after 32 completed operations or 16 ms of elapsed work,
whichever comes first. Each event is committed before publication, and the
page cursor advances only after the page is stored. A single synchronous
SQLite operation can exceed that work budget; it is not a latency guarantee.

Grok observation reads `GROK_HOME/sessions` (`~/.grok/sessions` by default)
through the same bounded, read-only follower
([`grok-session-source.ts`](../../src-server/providers/sessions/grok-session-source.ts)).
Each session's `updates.jsonl` is Grok's append-only log of ACP session updates,
so a byte offset resumes it. The working directory comes from the session's
`summary.json`, never from its folder name, which Grok shortens to a lossy
slug-plus-hash for long paths. A session is listed once its log holds a user
prompt; this excludes the prompt-less sessions Station's own engine probes
leave behind. Subagent child sessions are not listed. A Station chat on the
Grok engine runs through ACP; the follower treats the Grok session named by its
resume cursor as Station-owned and does not import it again. Prompts, reasoning,
assistant messages, tool calls and results with their success or failure,
plans, per-turn token usage, stop reasons and compaction markers are imported;
a mid-turn interjection is a steer. Where Grok records what the user typed
separately (`displayText`, for interjections and locally expanded slash
skills), Station shows that rather than the model-facing text. A new prompt
after a turn that never recorded its completion ends that turn as aborted and
its open tools as unresolved. User text Grok writes without a prompt index while
a turn is open (interjections, echoed host turns and direct `!command` runs) is
imported as a steer on that turn and never starts or aborts one. A
rewind appends a marker rather than removing turns; Station keeps the rewound
turns, because a live follower has already published them and the event log
has no retraction. The marker is recorded as an extension notification and
shown in the transcript as a quiet line ("Rewound to an earlier prompt"), after
its turn when it arrives during one; compaction markers from both sources are
shown the same way ("Context compacted"). A log
or summary in an unrecognized shape is skipped with one logged warning per
file kind, never guessed at. Discovery skips every working directory that is one of
Station's own ACP workspaces, for this or another Station home (the layout
`runtime/acp-workspaces/<session|probe>/<digest>` that
[`managed-acp-workspace.ts`](../../src-server/services/acp/managed-acp-workspace.ts)
creates), before reading it. Of the rest, it re-reads a working directory's
folder list only when it changed, newest first, and per poll reads at most
131,072 entries, stats at most 16,384 folders and inspects at most 1,024. New
folders in a changed working directory and folders with new activity come
first, so a new session is found on the poll it appears. The index holds at
most 131,072 folders; past that it slides over the tree no faster than it can
inspect, so an untouched old session in such a tree can take a few minutes to
appear. A single working directory with more session folders than that is
only partly listed.

Before observing a Claude transcript page, the follower persists its initial
window start (the last 2 MiB by default, or an explicit zero for a smaller file)
through the yielding EventStore write path. Failed page writes replay from that
anchor even after the file grows, the source is rediscovered, the follower's
bounded cache evicts the thread, or Station restarts. The anchor is reusable
only for the same source handle and configuration-home affinity. It stores no
page contents and cannot recover deleted or truncated source bytes. If the file
shrinks below the saved offset, the source logs a warning and the follower pins a
new initial window on the next poll so following resumes; bytes before that window
remain outside retention. Records without a `uuid` are identified by byte offset,
so after a rewrite one may be skipped as a duplicate or imported twice. A legacy attachment without configuration-home affinity keeps
its migration anchor in memory until its first read that does not throw,
preserving the old durable cursor and affinity when the read throws. Codex and Grok start at byte zero;
OpenCode starts before the first message in its ordered database query. Their
cold cursors do not move with append-only growth.

Claude transcript observation also persists a bounded, source-owned ancestry map
with its cursor. Late turn-duration records close their known parent turn;
unknown or evicted parents leave the current turn's usage accumulator intact.
An older aggregation cursor without ancestry uses one bounded look-behind to
recover identities after its exact active user boundary. It replays no counters
or events; a boundary outside that window remains unknown.
An event-limited page that stops within a record retains that record's incoming
turn and usage state so replay resumes coherently. The per-turn conversation
window retains all per-turn Claude and Muse usage observations within its
existing bounds; it coalesces session-cumulative Codex observations to the latest
snapshot. See [Profile usage](../guides/monitoring.md#profile-usage-and-paired-people)
for measurement scopes and remaining coverage limits.

Claude and Codex continuation require a verified source configuration identity.
The local sources expose an opaque reference to the configured home; the native
adapter resolves that reference again before use. A replaced or mismatched home
refuses continuation instead of falling back to another account. Source identity
is a provider-neutral contract: remote sources can supply their own connection
identity without exposing a filesystem path.

Codex continuation forks an independent native thread at a completed turn
observed in Station's durable history. The original terminal session remains
read-only in Station and can keep running independently. Until a completed
boundary exists, the message box that continues it stays disabled with a reason. Claude
uses its SDK's independent session snapshot; it does not claim the same native
turn-cutoff semantics. Both paths retain the source binding in the adoption
ledger before native child creation and retain unresolved cleanup for recovery
rather than blindly retrying an ambiguous fork.

Codex continuation requires an available, authenticated local Codex adapter.
The adapter validates the native fork and completed-turn cutoff; its fixture
tests do not establish compatibility with a particular installed CLI version.
This audit has not run a live native fork. Forked Codex
sessions can replay inherited cumulative usage. Station marks continuation
usage unavailable until it can establish a durable child-only baseline, rather
than reporting inherited tokens as new spending. This limitation does not
prevent transcript observation or continuation.

`STATION_EXTERNAL_CODEX_SOURCE_ROOT`, `STATION_EXTERNAL_CLAUDE_SOURCE_ROOT` and
`STATION_EXTERNAL_GROK_SOURCE_ROOT` can select separate history roots for
observation. Each root contains the engine's `sessions`, `projects` or
`sessions` directory, respectively. Grok observation otherwise uses `GROK_HOME`,
then `~/.grok`; Grok sessions offer no continuation. Discovery does not change the
process environment or ordinary launch configuration. Continuation has an
additional binding: Codex adoption and resume set the child process's
`CODEX_HOME` to the verified source home, ahead of a credential-profile home.
That home therefore also supplies the continued process's account/configuration.
Claude continuation requires the source home to match the SDK's globally
configured home; an independently overridden observation root is not enough.
Without an override, observation uses `CODEX_HOME` or `CLAUDE_CONFIG_DIR`, then
the engine's default home directory. `STATION_EXTERNAL_OPENCODE_SOURCE_ROOT`
selects the folder holding OpenCode's session database for observation only;
OpenCode sessions have no continuation. See the
[Codex adapter](../../src-server/providers/adapters/codex-adapter.ts) and
[Claude source-home check](../../src-server/providers/adapters/claude-adapter.ts).

### The receipt envelope

A dispatch that reaches the command owner normally returns a receipt describing
acceptance, rejection or failure. Early schema/authentication/authorization
failures can occur before a receipt exists. Acceptance is not turn completion:

```jsonc
// 200, command accepted
{
  "success": true,
  "data": /* command-specific result or null */,
  "receipt": {
    "commandId": "uuid, generated server-side",
    "threadId": "string",
    "commandType": "adoptSession | interruptTurn | steerTurn | inspectSteerInput | respondToRequest | setApprovalMode | discardDraft | stopSession",
    "status": "accepted | rejected | failed",
    "createdAt": "ISO 8601 timestamp"
  }
}

// 400, command rejected/failed — receipt present only when the dispatch got far
// enough to mint one before throwing (OrchestrationCommandDispatchError)
{
  "success": false,
  "error": "string",
  "receipt": { /* same shape, status: 'rejected' | 'failed' */ }
}
```

Persisted receipts can be queried independently. A response may instead report
`receiptStatus: "unavailable"`: the effect may have occurred while its receipt
could not be made durable. Foreground execution can return
`outcome: "indeterminate"` and `code: "foreground_message_indeterminate"` with
the known Session/receipt detail. Inspect that Session; do not resend the
request merely because it returned an error or the receipt lookup is empty.
A transport failure after dispatch can also leave the outcome uncertain.
In the [chat UI](../../src-ui/src/hooks/orchestration/queueDrain.ts), an intermediary's
error page during a queued send leaves the message in the queue; the page does
not establish a Station refusal. An uncertain
[Agent change](../../src-ui/src/components/chat-dock/ConversationHandoffDialog.tsx)
also retains its request. Use **Check status** or the
offered retry for that request rather than starting another handoff.
These endpoints establish recorded receipt state, not permission to retry:

```
GET /api/orchestration/commands/receipts?threadId=<threadId>   # list, optionally filtered
GET /api/orchestration/commands/receipts/:commandId            # single receipt, 404 if unknown
```

---

## Model selection

There is no separate "select model" command. A new execution request may include
`target.model.override` and `target.model.options`. The target Agent's engine binding
decides whether those controls are supported; unsupported controls fail before
dispatch. Continuation accepts the corresponding `model.override` and `model.options`
without changing the Conversation's Environment/workspace or Agent/engine binding.

---

## Exact Agent identity

Every session, receipt, event, conversation query, project reference, layout,
and approval carries the selected persisted Agent's clean `AgentId`. External
engine connections own a same-text default Agent through
`config/agent-registry.json`; model-only connections do not. Station performs
exact-ID matching and no alias resolution. Connections are configuration and Agent
authoring resources, never execution selectors.

## Reading session activity

Two distinct endpoints exist for two distinct jobs — do not use one where the other is
correct:

| Endpoint | Shape | Use it for |
| --- | --- | --- |
| `GET /api/orchestration/sessions/:threadId/events` | JSON array, one-shot response | A point-in-time replay of everything persisted so far. Not a stream — call it again to see new events (or use `event-page` below to poll a cursor). |
| `GET /api/orchestration/events` | `text/event-stream` (SSE), long-lived connection | The live feed. Optional `?threadId=<id>` query param narrows it to one session; omitted, it streams every session the caller can read. |

### Exact inventory input detail

`GET /api/orchestration/sessions/:threadId/inputs/:eventId?turnId=...`
returns `{success:true,data:{sessionId,eventId,turnId,input:{prompt,attachments}}}`
for the exact authored input. Attachment entries contain name, media type and
size, not attachment bytes. The existing Session query owner resolves the
input by event identity; the route checks Session, event and turn identity and
rechecks the current principal and Session permission after the read. Missing
or refused inputs return the same 404. An unavailable owner or JSON result
over 256 KiB returns 503. Every response is private/no-store. Hosted mode is
unavailable until it has a tenant-scoped input reader. This read neither loads
the full transcript nor changes an inventory descriptor or a kept reference.

A host that serves this read advertises `capabilities.sessionInventoryInputRead:
true` on its public handshake; a hosted deployment omits it, because its route
refuses every read. A host built before the read answers the path 404, the same
as a refused read, so a client checks the flag before reading and, when it is
absent, says the host can't show input details and suggests updating it. A whole-Session inventory lists an
authored input only for a `turn.started` with non-whitespace prompt text or
attachments (one shared rule, `isAuthoredInputContent`, for the listing and this
read); a turn recorded with neither (for example an imported Codex turn without a user
message, or a turn the engine opened on its own) is not listed, because this
read would refuse it.

### Bounded session detail

`GET /api/orchestration/sessions/:threadId?view=window-v1&turnLimit=10`
returns the existing `OrchestrationSessionEventWindow` protocol: `protocolVersion: 1`,
the authoritative `session` summary, chronological `events: {sequence, event, elided?}[]`,
`hasMore`, optional `nextCursor`, and `watermark`. Sequences are global stream
sequences. The first page prioritizes the newest turns; pass `nextCursor` back
as `cursor` to read older events. This is the same cursor scheme as
`/event-window?direction=newest`, so turn-start anchors may repeat across pages.
Merge by event identity and sequence rather than concatenating anchors.

`turnLimit` is 1–20 (default 10). The existing 150-event and 64,000-byte response
bounds apply, with explicit payload elision. Attachments retain blob references;
fetch retained bytes through the authorized attachment route. Invalid view or
query shapes return 400; absent and unauthorized Sessions return the same 404.
A malformed opaque cursor is refused by the existing event-window reader.
A page is partial when `hasMore` is true; it cannot establish lifetime usage.

Omitting `view` keeps the legacy full-detail contract, and `/events` keeps full
replay for existing clients. New detail readers can use the bounded view without
fetching full history. Conversation windows also authorize each lineage member
through summary facts, without materializing its transcript.

### Events replay (`GET /sessions/:threadId/events`)

```jsonc
// 200
{ "success": true, "data": [ /* CanonicalRuntimeEvent[], oldest first */ ] }
// 404 if the threadId is unknown or not readable by the caller
{ "success": false, "error": "Session not found" }
```

This is accepted canonical history, not a copy of every raw provider emission.
Publication can coalesce streaming updates and reject invalid events before
append; storage failure is not successful publication. History includes lifecycle events
(`session.started`, `session.configured`, `session.state-changed`, ...), turn events
(`turn.started`, `turn.completed`, `turn.aborted`), and content events
(`content.text-delta`, `content.reasoning-delta`, `tool.*`, `request.*`, ...). See
`packages/contracts/src/runtime-events.ts` for the full `CanonicalRuntimeEvent` union —
that file is the source of truth for shapes, not this doc.

For paging through a live-growing event log without re-fetching everything, use
`GET /api/orchestration/sessions/:threadId/event-page?afterSequence=<n>&limit=<1-100>`,
which returns `{ session, events: {sequence, event}[], hasMore, nextSequence }`.

**A polling gotcha:** if you call `/events` immediately after the foreground execution
endpoint returns, you may see only lifecycle events — the accepted turn may not have
produced its `turn.completed`/`content.text-delta` events yet. This is a timing race,
not proof of completion or failure. Poll with a deadline for the returned
`providerTurnId`, checking `turn.completed`, `turn.aborted`, errors and open
requests. Accepted/coalesced publication is owned by the orchestration service;
a timeout or missing terminal event must remain unverified, not inferred success.

### Conversation usage tree (`GET /conversations/:conversationId/usage-tree`)

One conversation's usage with its children, as a
[`ThreadUsageTree`](../../packages/contracts/src/thread-usage-tree.ts). The
root holds the conversation's own turns (every session in its lineage). Its
children are the engine subagents those sessions reported and the sessions
launched from the conversation, nested recursively and read one depth level
at a time. Each child carries its own figures and a `relation` for tokens and
for cost: `added` (in the total), `included-in-parent` (the parent's figure
already contains it) or `not-reported` (not in the total, which is then
partial). `total` lists why it is partial in `partialReasons`.

A session is a child of the conversation when its launch names any session of
the conversation's lineage as its parent:

- by its delegation context (`metadata.delegation.parentConversationId`).
  When a Claude Code or Codex session calls `delegate_task` through its
  session-bound station-control (Claude Code's in-process server, Codex's
  per-session HTTP server), Station derives it from the calling session's own
  record. For Station's own agent, the runtime attests it from the
  conversation it ran the tool call in. Neither comes from the request. On a
  direct request it is the requester's own claim. A paired-Station dispatch
  record keeps the same value as `metadata.parentConversationId`;
- otherwise by `metadata.parentTaskId`, which a request may set itself. A
  delegation context naming another conversation always wins over it.

A task launched through a caller-less station-control process (a stdio child
with no per-session credential, as a Strands-runtime agent uses) carries no
delegation context. Unless its
request named `parentTaskId`, it is not found as a child and the total doesn't
show it as missing.

Tokens: `totalTokens` is input + output as each engine reported them; cache
reads and writes are listed separately and are not added. `total.tokens`
says what the summed input means in `cacheInclusion`: `excluded` (every engine
reports uncached input), `mixed` (two declared conventions that differ were
summed), or `not-established` (any other case, including an engine whose
convention is unverified or undeclared; unknown is never called different). A subagent's own figure goes where its
engine's meaning puts it: tokens used become `totalTokens`, a Claude Code
subagent's last-request size is `lastRequestTokens`, and an undeclared
engine's figure is `unverifiedTokens`. Only `totalTokens` is ever added.

Cost stays in buckets: reported cost by currency, Station estimates by
currency and price snapshot. Buckets are never summed together, and reported
cost is never mixed with estimates.

The read is authorized like the conversation transcript: every session in a
conversation's lineage must be readable. A session you can't read is never
read, named or figured. What happens to it depends on how its launch came to
name your conversation, which the dispatch route records at launch in the
reserved start metadata key `stationDelegationProvenance` (a request can't
set it; Station strips any value a caller supplies):

- `caller-derived` (from the calling session's own record) or
  `runtime-attested` (Station's own runtime vouched for it): the session is
  real work of your conversation that runs under another owner. In hosted
  mode that happens when Station can't attribute the dispatch to a bound
  caller (for example a Codex session calling through its URL token), so the
  delegate is the Station operator's. It is counted as not visible: no node,
  and the total is partial with one line saying how many such tasks there are.
  The stamp counts only on the session's start record, beside the parent it
  names.
- `direct-claim` (passed through from a request outside this Station's
  process, such as an operator, device, hosted-user or peer Station
  credential), or no stamp (a launch from before it existed, or a
  `parentTaskId`-only link): the link is only a claim, so the session is
  ignored, neither shown nor counted as missing. Counting it would let anyone
  mark someone else's total partial.

A delegate that ran on a
paired Station is shown from this Station's own record, with `not-reported`
usage, and no peer is contacted. Responses are `Cache-Control: private,
no-store`. `404` means no conversation you can read. `422` means the tree is
past a bound (200 nodes, delegates nested 8 deep, 5,000 usage observations,
or more than 1,000 session records naming one level's parents) and is refused rather
than cut. Each level resolves parent naming through the indexed session-parent-mentions
projection, maintained with canonical event writes and backfilled from retained
start and configured events. Naming and provenance grant no read or lifecycle authority.

### Reading assistant turn content programmatically

For ACP-connected and other streaming-capable providers, assistant text arrives as a
sequence of `content.text-delta` events (`{ itemId, delta }` chunks that must be
concatenated in event order to reconstruct the full message — a single delta chunk may
split a word or a nonce in half). Reconstructing that by hand from raw events works but
is unnecessary busywork: **`GET /api/orchestration/sessions/:threadId/messages`** already
does it for you, via the same shared projection (`projectRuntimeEventsToMessages`,
`packages/shared/src/runtime-event-projection.ts`) the native-SDK chat refresh path
uses:

```jsonc
// 200
{ "success": true, "data": [ /* ConversationMessage[] */ ] }
```

```ts
// packages/shared/src/conversation-message.ts
interface ConversationMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  parts: MessagePart[]; // { type: 'text', text }, tool-invocation parts, etc.
  metadata?: { timestamp?: number; model?: string | null; modelOptions?: {...} };
}
```

A message can have several text parts interleaved with tools or other structured
parts. For a text-only diagnostic, collect every text part in order:

```ts
const text = message.parts
  .filter((part) => part.type === 'text')
  .map((part) => part.text)
  .join('');
```

Keep the original ordered `parts` for faithful display; concatenation loses the
tool/text boundaries. Match assistant messages by `metadata.turnId` to the
handle's `providerTurnId` when proving one turn, so an earlier answer cannot
satisfy a later check. The shared projection assembles streamed text and handles
aggregate `turn.completed.outputText` where appropriate.

### Usage-limit recovery (`/sessions/:threadId/usage-limit`)

When a Claude Code or Codex turn stops on a provider usage limit, Station
records a recovery intent for the Session (see `ConnectionRecoveryProjection`
in [contracts](contracts.md)). These routes serve the chat banner:

- `GET /sessions/:threadId/usage-limit` answers `{ recovery }`: the Session's
  latest recovery projection when it came from a usage limit, with `autoResume`
  (whether it will resume on its own at the reset) while the stop waits, or
  `null`. `autoResume` is the `usageLimitAutoResume` setting unless the person
  chose for this stop (`autoResumeChoice`, below).
  It carries no event list and sits at the Session read tier.
- `POST /sessions/:threadId/usage-limit/resume` ("Resume now") starts sending
  the stopped turn again at once, whatever the setting and before the reset. It
  runs the same pre-dispatch checks as the timer: a newer turn, an open request
  or a closed Session retires the stop with that `outcomeReason` instead. If
  the provider refuses the replay with the same limit, the replay arms its own
  wait for the reset, so an early click does not end the wait. That re-arm
  needs a reset at least a minute away; a past or sooner reset ends the stop as
  `failed` instead, and so does a fourth refusal in a row for the same
  conversation (a user turn resets the count), so a refusing provider cannot
  loop the resume.
- `POST /sessions/:threadId/usage-limit/cancel` ("Cancel auto-resume") retires
  a waiting stop unsent with `outcomeReason: "user-canceled"`. That retires the
  whole stop, so Resume now is no longer offered for it either; the user sends
  a message to continue.
- `POST /sessions/:threadId/usage-limit/resume-at-reset` ("Resume at
  <reset>") and `POST /sessions/:threadId/usage-limit/hold` ("Don't resume")
  decide a stop still waiting for a known reset, for that stop alone, in place
  of the setting: the projection then carries `autoResumeChoice` (`resume` or
  `hold`) and the matching `autoResume`. Nothing is sent now, the choice
  survives a restart, and every pre-dispatch check still applies at the reset.
  A held stop keeps Resume now. Either answers `not-waiting` for a stop with
  no known reset or one no longer waiting.

Every POST answers `{ result, recovery }`: `result.kind` is `resumed` (the
dispatch started; whether the provider accepts it shows later in `recovery`,
which can still read `failed` if the dispatch is rejected), `failed` (it could
not be dispatched at all, for example its attachment bytes are gone), `canceled`, `retired`
(with `reason`), `chosen` (with `choice`) or `not-waiting` (nothing was left
to act on), and `recovery`
is the projection afterward.

They need the operate scope and the Session's own person, which is the same
check as sending the next turn: in a personal home, any of that person's own
devices holding the operate scope may act (a shared personal-home Session
admits them); in a hosted deployment the strict owner and tenant check applies.
No station-control tool maps these routes, so an agent's internal token is
refused.

### Subagent transcript (`GET /sessions/:threadId/child-work/:childId/transcript`)

An engine subagent's own conversation, read-only. `threadId` is the session
that reported the subagent and `childId` is its child-work id. The server
finds the transcript from that session's persisted child-work facts (the
`transcript` reference on the `ChildWorkItem`), so the request carries no
file path, and the read works the same after a server restart. Reads are
authorized like the session's other reads and are never cached
(`Cache-Control: private, no-store`).

Query: `offset` (message index, default `0`) and `limit` (messages per page,
`1`–`50`, default `30`). The response's `data` is a `ChildWorkTranscriptPage`:
`entries` (prompt and reply text, tool calls, tool results; inline image data
replaced by a placeholder, then each text cut at 4,000 characters and flagged) and `nextOffset` when another page follows.
`404` means no transcript for a session you can read; `503` means the engine
no longer has it.

Only Claude subagents have a transcript today. Claude Code keeps it under the
config home the session's engine was spawned with (its app-home or credential
profile, a connection's config home, or the global one); the adapter records
that config home with the reference, so a profile session's transcript is
read from its own profile. Symbolic links below that config home are refused
by checks made immediately before the file is opened; the checks are not
atomic against a concurrent swap by a process running as the same user.
Codex child threads have no transcript reference.

The transcript is shown in file order, so it can include what Claude Code's
own reader hides: a branch abandoned by a retry or an edit, and a compaction
summary. A single record of any type larger than 4 MiB is skipped and shown
as one `too-large` entry.

### Live SSE feed (`GET /events`)

```
GET /api/orchestration/events              # all sessions the caller can read
GET /api/orchestration/events?threadId=X   # filtered to one session
```

A connect without a usable cursor takes the snapshot path. A valid numeric
`Last-Event-ID` can instead replay the authorized gap and catch up without an
initial snapshot. Retain the server's SSE `id` and stream epoch; send the epoch
back as `X-Station-Stream-Epoch`. A changed epoch, invalid/ahead cursor or gap
outside the replay budget requires snapshot recovery. The
`orchestration:caughtUp` marker carries the safe resume cursor (and epoch when
available) after the replay/snapshot boundary, before buffered live delivery.
Do not assume the first frame is a snapshot; keepalive frames may arrive while
history is being read. Each connection buffers at most 8 MiB of serialized live
payloads and 16,384 frames before caught-up. At caught-up, the frame cap becomes the
backlog remaining at that moment plus 1,024 frames; the 8 MiB byte cap continues. Overflow discards that buffer and
replays persisted events in pages of at most 64 rows and approximately 1 MiB
(one larger ingress-bounded event may occupy its own page). Recovery stays on
the same connection, so CLI observers do not see a false completion. A snapshot
reconciles compacted activity/projection notifications; per-session read access
is checked again before queued content is written.

Station's SessionDetail subscribes to the tab's shared orchestration feed and
filters canonical events by Session id. Closing a detail releases its local
subscription. The shared transport retains the server cursor and epoch across
retries; a snapshot fallback reloads each mounted detail's bounded history.
History starts after capability discovery and does not wait for SSE to open.
The same-tab subscription needs no BroadcastChannel or SharedWorker. Tabs still
own separate shared feeds; scheduler, monitoring and Task-room feeds remain
separate connections.

Snapshot and caught-up session summaries use the same scope as the stream:
`?threadId=X` includes only X; the global stream includes all readable sessions.

Live `orchestration:event` frames carry `{ event: CanonicalRuntimeEvent }`;
`threadId` filters the stream and caller authorization still applies. Coalesced
activity may also arrive as `orchestration:activity`, without a durable cursor.
The separate bare `/events` feed carries ephemeral notifications and cache
invalidation hints. It bounds its queue to 1,024 frames or 8 MiB and compacts an
overflow into `data:changed` with `{ "resync": true }` while keeping the connection.
The UI invalidates its whole query cache so future query keys also recover.
Transient effects such as toasts, navigation and approval prompts may be dropped
on overflow and are not replayed. The initial
`acp:status` frame repairs status changes missed while disconnected.
The SDK consumer compares the full last-applied status for that server authority,
including changes missed while disconnected, before invalidating status queries. It has no SSE
IDs or replay promise: EventBus events are not persisted, and replaying effects
would require a retained, authority-aware protocol. Use durable owner APIs for
state and the orchestration feed for cursor-based conversation recovery.

Ignore `ping` for application state. Use the JSON replay or message projection
for bounded diagnostic polling; a live feed is not evidence that all provider
output was persisted.

---

## `/api/agents/:id/chat`

`POST /api/agents/:id/chat` accepts a persisted clean Agent ID. Station-engine
Agents use the native Station runtime. An external-engine default or custom
Agent receives HTTP 409 directing the caller to `POST /api/orchestration/chat`;
the per-Agent route does not redispatch the request. The
route never decodes an Agent ID into a connection ID and never manufactures an
Agent from connection state. Missing and unavailable Agents return distinct,
actionable diagnostics.

---

## Local nonce diagnostic and curl walkthrough

This diagnostic requires an already-running Station, an existing configured
Agent, a paired bearer credential, and a directory visible at the same path to
both this shell and the Station host. Configure and authenticate the engine
separately; the script does not install connections, enroll credentials, or
approve tools. It executes two real turns and can incur provider cost.

```bash
export STATION_API_BASE=http://127.0.0.1:3311
export STATION_AGENT_ID=opencode
export STATION_SESSION_CWD=/absolute/path/to/local/workspace
# Supply STATION_API_CREDENTIAL from your existing paired credential.
node scripts/session-api-roundtrip.mjs
```

The script creates a private nonce file, starts a canonical chat, waits for the
exact provider turn to complete and return the nonce, then continues the returned
Conversation and verifies the second turn using its returned Session ID. It
removes its nonce directory afterward. Open requests, aborted turns, missing
identities and uncertain dispatches fail without approval or automatic retry.
The conversation itself is retained. Its mocked schema/caller tests establish
protocol behavior, **not live engine proof**. A live run is verified only by its
own completed result for that instance and engine.

The same sequence can be inspected with `curl` and `jq`:

```bash
set -e
: "${STATION_API_BASE:?set the running Station API base}"
: "${STATION_API_CREDENTIAL:?set a paired Station bearer}"
: "${STATION_AGENT_ID:?select an existing Agent}"
: "${STATION_SESSION_CWD:?use a directory visible to this shell and Station}"
BASE="${STATION_API_BASE%/}"
NONCE_DIR=$(mktemp -d "${STATION_SESSION_CWD}/.session-api.XXXXXX")
trap 'rm -rf "$NONCE_DIR"' EXIT
NONCE=$(openssl rand -hex 24)
NONCE_FILE="$NONCE_DIR/nonce.txt"
printf '%s' "$NONCE" > "$NONCE_FILE"
chmod 600 "$NONCE_FILE"

api() {
  curl --fail-with-body -sS --max-time 120 \
    -H "Authorization: Bearer $STATION_API_CREDENTIAL" \
    -H 'Content-Type: application/json' "$@"
}

# Wait for this returned provider turn, not an earlier answer in the Session.
wait_for_turn() {
  for attempt in $(seq 1 60); do
    EVENTS=$(api "$BASE/api/orchestration/sessions/$SESSION_ID/events")
    if printf '%s' "$EVENTS" | jq -e --arg turn "$TURN_ID" \
      '.success == true and any(.data[]; .turnId == $turn and .method == "turn.completed")' >/dev/null; then
      TEXT=$(api "$BASE/api/orchestration/sessions/$SESSION_ID/messages" | jq -r --arg turn "$TURN_ID" \
        '[.data[] | select(.role == "assistant" and .metadata.turnId == $turn) | .parts[] | select(.type == "text") | .text] | join("")')
      case "$TEXT" in *"$NONCE"*) return 0;; esac
      echo 'Completed turn did not return the nonce.' >&2
      return 1
    fi
    sleep 2
  done
  echo 'No verified completion: inspect errors and open requests in Station; do not resend automatically.' >&2
  return 1
}

BODY=$(jq -n --arg agent "$STATION_AGENT_ID" --arg cwd "$STATION_SESSION_CWD" \
  --arg message "Read the file at $NONCE_FILE and reply with its exact contents." \
  '{target:{environment:{kind:"current"},agent:$agent,workspace:{kind:"directory",cwd:$cwd}},message:$message}')
FIRST=$(api -X POST "$BASE/api/orchestration/chat" -d "$BODY")
CONVERSATION_ID=$(printf '%s' "$FIRST" | jq -er '.data.conversationId')
SESSION_ID=$(printf '%s' "$FIRST" | jq -er '.data.sessionId')
TURN_ID=$(printf '%s' "$FIRST" | jq -er '.data.providerTurnId')
wait_for_turn

# Only continue after the first turn completed. A new Session may be returned.
NEXT=$(api -X POST "$BASE/api/orchestration/chat/$CONVERSATION_ID/continue" \
  -d '{"message":"Repeat the exact file contents from your previous answer."}')
SESSION_ID=$(printf '%s' "$NEXT" | jq -er '.data.sessionId')
TURN_ID=$(printf '%s' "$NEXT" | jq -er '.data.providerTurnId')
wait_for_turn
```

For an approval, inspect the Session's `request.opened` event and current exact
request state before making an explicit decision. Send `respondToRequest` with
`threadId: SESSION_ID`, the `requestId` and, for an exact inspector,
`expectedRequestEventId`. A pending request can prevent the walkthrough from
completing; the diagnostic deliberately does not answer it for you.


## Review work in the attention inbox

`/api/attention` projects supported attention sources for the caller, including
the two that used to be reachable only from `/review-queue`:

- `kind: 'proposed-change'` — one pending proposed change, derived from
  `status: 'pending'` on the proposed-change store. Its `source.proposedChangeId`
  is what the existing `POST /api/proposed-changes/:id/approve|reject` routes
  act on; the projection itself decides nothing.
- `kind: 'gate-review'` — one Survey/Flow gate review session with items awaiting
  a recorded decision, derived from `pendingDecisions > 0` on the same aggregate
  `GET /api/survey-flow-reviews` serves. It carries no decision affordance:
  continuation runs through the review workbench
  (`POST /api/projects/:slug/flow/runs/:runId/reviews/continue`).

`pendingDecisions` is counted by the review service. It is not
`summary.unresolved`: an escalated or resolved item can still lack a decision
and keep continuation blocked. The
[attention projection](../../src-server/services/projects/attention-projection.ts)
also reports unreadable gate-review sources separately from an empty queue.

Neither is projected for a hosted tenant read. The proposed-change store and
the review aggregate carry no tenancy predicate, so a tenant-scoped read has no
standing to see them.

Items carry `projectSlug` when the projection could derive one from the item's
own source. It is absent, never guessed, for a generic notification-backed
approval or a project-less session. Per-project counts are derived from
`items` by counting that field under the same pending predicate as
`pendingCount` (`attentionCountForProject`, `@kontourai/station-contracts/attention`);
the server publishes no per-project number for a client to trust.

`needs_input` and `review_pending` items carry `environmentKind: 'peer'`, plus
the saved `environmentName` when recorded, when the session is this Station's
lifecycle record of a delegated task that runs on a paired Station. The value
is read from the session's own `delegation.environmentKind`, the same field the
Activity detail uses to withhold local controls. The item's thread names only
that record, and the server refuses a local turn on it. Such an item therefore
links to the Activity detail instead of the chat dock. Clients show where to
answer it instead of offering a local reply. The field is absent for work this
Station runs. A server that predates the field omits it; a reply sent to a peer
record through that server is still refused, not delivered elsewhere.

The same record also opens in Activity from every work-item surface: Home's
continue action and lists, the dock inbox, the mobile task switcher, the
Sessions list, and a project's live work. Its agent slug and conversation id
are the paired Station's, so rehydrating it as a local chat would show an empty
transcript whose composer cannot reach the task. Home's work items carry
`delegationEnvironmentKind: 'peer'` for this. The workspace Home projection
record names that field, so a Home role grant made before it no longer covers
the projection, and Home falls back to the built-in view until the grant is
approved again.

The paired Station's own open request reaches this Station through its
delegated-task status read (`GET /api/orchestration/delegations/:taskId`,
field `pendingRequest`). Each status refresh records it on the peer record as
`delegation.peerPendingRequest` (id, type, title, `observedAt`). The record is
cleared when the paired Station reports no open request, or answers `respond`
for that request id. The attention item then carries `peerRequestReference`:
`environmentId`, `taskId`, `requestId` and `requestType`. These ids name the
request on the paired Station. It never carries `requestReference` or
`inputReference`, so local request inspection and `respondToRequest` cannot use it.

`viewerCanRespond` models two gates this Station applies before the handler of
the answering route: the credential and pairing-scope gate for that path, then
the station-control dispatch scope. That is `respond` with `approve` for a
decision, and `continue` with `execute` for an input answer. The handler can still refuse, for example an inbound
delegation peer, hosted mode, or an environment that is not the task's
recorded host. Absent means unknown, and clients offer nothing. For an
`approval` or `permission` request with `viewerCanRespond: true`, clients post
`{ requestId, decision, environmentId }` to that route; the paired Station
re-checks the request is open and decides it there. When the paired Station
answers 403, the route reports "The paired Station refused this decision" in
this Station's words; the paired Station's own diagnostics are not relayed.
`confirmation` requests keep the note.

### Bound answers to a paired Station's question

An `input` request is answered with a bound follow-up instead of a decision,
because `respond` carries a decision, not text. A Station that advertises
`capabilities.delegatedInputAnswers: true` in its public handshake
(`GET /.well-known/station/v1`) accepts an optional `expectedInputRequest` on
`POST /api/orchestration/delegations/:taskId/continue`:

```json
{
  "message": "Use the staging bucket",
  "environmentId": "environment-peer",
  "expectedInputRequest": {
    "threadId": "<the task's current Session on the serving Station>",
    "requestId": "<its open request id>",
    "requestEventId": "<its request.opened event id>"
  }
}
```

The executing Station delivers the message only as the answer to that
request: the binding must name the task's current Session and an input request
that is still open there, and the orchestration service checks it again right
before invoking the engine. Otherwise the route answers HTTP 409 with
`code: "input_request_changed"` and nothing is sent. A bound answer cannot
also carry `model` or `modelOptions`, because a model change can start a
successor Session before the binding is checked. That combination answers
HTTP 400 with `code: "input_binding_model_change"`. A Station forwarding the
answer first reads the selected Station's handshake. It sends the binding only
when the handshake names that environment and advertises the capability,
refusing with HTTP 409 and `code: "input_binding_unsupported"` otherwise. An
older Station would drop the unknown field and deliver an unbound turn, so it
never receives one. A forwarded `input_request_changed` keeps its code; the
serving Station's prose does not cross.

A Station with the capability also adds to the delegated-task snapshot's
`pendingRequest`: `eventId`, `body` (the question as `presentOpenRequest`
presents it), and, for a read it serves itself, `callerCanRespond`. That last
field models the HTTP boundary and station-control dispatch scope of the
answering route for the reading credential: `continue` with `execute` for an
input request, `respond` with `approve` otherwise. A delegator records these
fields on its peer record (body bounded to 4,000 code points; the binding stored
only whole and within 1,024 code points per id). The attention item's
`peerRequestReference` then carries `threadId`, `requestEventId` and
`callerCanRespond`. Clients offer an answer box only for an `input` request
with that binding, `viewerCanRespond: true`, and `callerCanRespond` not
`false`. Without the binding, the item keeps the note. When `callerCanRespond`
is absent, clients offer the action and show any refusal.

The route forwards a decision only to the environment this Station recorded as
hosting the task. A body naming another environment is refused before any
outbound request. The recorded host is read with the caller's own read
authority, so a task record the caller cannot read names no host. A request id
longer than 512 Unicode code points is not stored, so the item shows the note.
A title longer than 512 code points is cut with a trailing ellipsis.

Both kinds link into the item's own Project Review layout at the exact item —
`/projects/<projectSlug>/layouts/review?change=<id>` and
`?review=<reviewSessionRef>`, alongside Starter work's
`?receipt=<receiptId>`. All three are minted by one derivation,
`projectReviewLayoutHref` (`@kontourai/station-contracts/layout`); the Project
is the path, so the layout is already scoped to it and the selector names only
the item. The retired `/review-queue?…&project=<p>` spellings redirect there,
and one naming no Project goes to `/notifications`. A stale link shows a
notice; Station does not open a different item in its place.

## Inspect an exact attention request

Request-backed approval and permission items in `/api/attention` may carry
`requestReference: { threadId, requestId, requestEventId }`. Preserve that exact
reference when opening an inspector:

```text
GET /api/orchestration/sessions/:threadId/requests/:requestId?eventId=:requestEventId
```

This protected read returns `open`, `changed`, `resolved`, or `unavailable`.
Only `open` includes bounded, redacted presentation, engine identity, current
answerability, and `canRespond`. The route rechecks request-principal and Session
read authority and uses private/no-store caching. It reads the indexed current
request event and canonical lifecycle facts instead of replaying Session history.
An oversized or inconsistent stored request is unavailable, not partially trusted.

After an explicit decision, use the existing response command and include the
inspected event identity:

```json
{
  "type": "respondToRequest",
  "threadId": "session-id",
  "requestId": "request-id",
  "expectedRequestEventId": "opened-event-id",
  "decision": "accept"
}
```

`expectedRequestEventId` is optional for existing clients. Exact inspectors always
send it. The server rechecks it after adapter resolution, immediately before the
response effect. A replaced or reopened request returns HTTP 409 with
`request_event_changed`; an unverifiable request or lost authority returns 409
with `request_verification_unavailable`. Both retain a rejected command receipt
and cause no adapter response. The comparison identity is not an authorization
grant. Freeform input and lifecycle-only attention retain their existing surfaces.

An event comparison prevents answering a replaced request; it is not an
idempotency key for provider effects. A transport failure after dispatch can leave
the decision outcome uncertain. The inspector never retries a decision. It retains
uncertain exact-event attempts in its existing QueryClient mutation cache across
closing and reopening the dialog. A fresh same-open inspection cannot re-enable
decisions; a resolved or changed event releases the uncertainty. Expired authority
records are pruned when another inspector opens. Successful decisions use ordinary
cache expiry. At 64 uncertain attempts for one Station authority, further inspector
decisions are refused rather than evicting uncertainty into permission to retry.
Open the session to confirm an uncertain outcome. A client restart clears this
in-memory history; cross-client or restart-safe effect deduplication remains the
adapter's responsibility.

Before starting work, agents can use `search_conversations` and
`list_active_work` to find related existing and in-flight work. See
[work discovery](../guides/self-configuring-agent.md#find-related-work-before-starting)
for input bounds, caller scope, incomplete search results and recorded workspace
fields, and the [HTTP leaves](api.md#station-control-work-discovery).
