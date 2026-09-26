# Session API: the programmatic chat surface

This is the reference for driving a Station chat session (any agent — Station agent,
External agent, ACP-connected — see [glossary](../glossary.md)) entirely over HTTP, with
no UI in the loop. It is the API-parity contract for the composer: every action a human
takes in the chat dock has a documented, scriptable equivalent here
(`docs/design/chat-composer.md` §4).

There is one execution surface: `POST /api/orchestration/chat` accepts an
Environment + Agent target and a message. Station resolves the Agent's engine,
model, and workspace binding on the target Environment. A bound continuation
uses `POST /api/orchestration/chat/:conversationId/continue`; it preserves the
Environment, workspace and current Agent/engine binding. Supported per-turn model
overrides remain explicit choices. Two separate read paths show
what happened: a point-in-time JSON replay and a live SSE feed.

---

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
      "cwd": "/optional/verified/override"
    }
  },
  "message": "Inspect this change",
  "conversationId": "optional caller-chosen continuation id"
}
```

For a saved Environment use `{ "kind": "saved", "id": "..." }`. The
controlling Station reaches that Environment through its configured peer or SSH
access, rewrites the forwarded target to `current`, and the target Station resolves
its own Agent. Tunnel URLs, provider IDs, and connection IDs are never request inputs
or response data.

The response is a foreground handle containing `conversationId`, `sessionId`,
`providerTurnId`, the
resolved Agent target, and an `ExecutionResolutionReceipt` describing the Environment,
Agent, engine kind, provider, and honest model launch plan.

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
It accepts `adoptSession`, `interruptTurn`, `steerTurn`, `respondToRequest`,
`setApprovalMode`, `discardDraft`, and `stopSession`. Commands use the execution
Session ID as `threadId`, not an assumed copy of the Conversation ID.
Public `startSession` and `sendTurn` commands do not exist; adapter dispatch remains
an internal service primitive.

### `respondToRequest`

Resolve an in-flight tool-approval/permission prompt — the programmatic equivalent of
clicking Allow/Deny on an approval card. Requests surface as `request.opened` canonical
runtime events (see [Reading session activity](#reading-session-activity)); resolve them
by `requestId`.

```jsonc
{
  "type": "respondToRequest",
  "threadId": "string, required, min length 1",
  "requestId": "string, required, min length 1 — from the request.opened event",
  "decision": "'accept' | 'acceptForSession' | 'decline' | 'cancel'"
}
```

### Other command types

The remaining controls are defined by
`src-server/routes/orchestration/orchestration.ts`:

- `steerTurn`: `{ type: 'steerTurn', threadId, input, turnId? }` sends steering
  input where the engine supports it.
- `setApprovalMode`: `{ type: 'setApprovalMode', threadId, approvalMode,
  basedOnSequence }` records an ordered posture decision. `basedOnSequence` is
  required: use the latest observed decision sequence, or `null` when none was
  observed. A stale basis refuses the change.
- `discardDraft`: `{ type: 'discardDraft', threadId }` asks the server to verify
  and discard a Draft; it is not a general Session deletion.

The other lifecycle controls are `adoptSession`
(`{ type: 'adoptSession', sourceThreadId, idempotencyKey? }`, create an independent continuation of a
read-only attached session; a UUID idempotency key safely replays the same
Continue intent and returns the existing continuation with
`alreadyAdopted: true`),
`interruptTurn` (`{ type: 'interruptTurn', threadId, turnId? }`, cancel an in-flight turn),
and `stopSession` (`{ type: 'stopSession', threadId }`).

External transcript observation does not grant control of the original terminal
process. The engine capability matrix declares independent continuation support;
known unsupported and unknown engines retain a disabled **Continue in Station**
control with a reason. The adoption owner enforces the same declaration before
invoking an adapter, then checks current source, Project, ownership, and runtime
requirements. A native continuation declaration does not guarantee readiness of
any particular source.

Codex rollout observation reads the local `CODEX_HOME/sessions` directory
(`~/.codex/sessions` by default) through bounded, read-only pages. It imports
supported turn boundaries, user messages, assistant text, public reasoning
summaries, tool activity, cumulative token snapshots, and compaction markers.
Only transcripts attributed to configured Projects enter the shared follower.
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

Claude and Codex continuation require a verified source configuration identity.
The local sources expose an opaque reference to the configured home; the native
adapter resolves that reference again before use. A replaced or mismatched home
refuses continuation instead of falling back to another account. Source identity
is a provider-neutral contract: remote sources can supply their own connection
identity without exposing a filesystem path.

Codex continuation forks an independent native thread at a completed turn
observed in Station's durable history. The original terminal session remains
read-only in Station and can keep running independently. Until a completed
boundary exists, **Continue in Station** stays disabled with a reason. Claude
uses its SDK's independent session snapshot; it does not claim the same native
turn-cutoff semantics. Both paths retain the source binding in the adoption
ledger before native child creation and retain unresolved cleanup for recovery
rather than blindly retrying an ambiguous fork.

Codex continuation requires an available, authenticated local Codex adapter;
native fork conformance is verified against Codex CLI 0.146.1. Forked Codex
sessions can replay inherited cumulative usage. Station marks continuation
usage unavailable until it can establish a durable child-only baseline, rather
than reporting inherited tokens as new spending. This limitation does not
prevent transcript observation or continuation.

`STATION_EXTERNAL_CODEX_SOURCE_ROOT` and `STATION_EXTERNAL_CLAUDE_SOURCE_ROOT`
can select separate read-only history roots. Each root contains the engine's
`sessions` or `projects` directory, respectively. These overrides affect
transcript observation only; they do not change the CLI's authentication or
execution configuration. Without an override, observation uses `CODEX_HOME`
or `CLAUDE_CONFIG_DIR`, then the engine's default home directory.

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
    "commandType": "adoptSession | interruptTurn | steerTurn | respondToRequest | setApprovalMode | discardDraft | stopSession",
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
history is being read.

Live `orchestration:event` frames carry `{ event: CanonicalRuntimeEvent }`;
`threadId` filters the stream and caller authorization still applies. Coalesced
activity may also arrive as `orchestration:activity`, without a durable cursor.
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

`/api/attention` carries every item whose meaning is "a human must decide",
including the two that used to be reachable only from `/review-queue`:

- `kind: 'proposed-change'` — one pending proposed change, derived from
  `status: 'pending'` on the proposed-change store. Its `source.proposedChangeId`
  is what the existing `POST /api/proposed-changes/:id/approve|reject` routes
  act on; the projection itself decides nothing.
- `kind: 'gate-review'` — one paused Survey/Flow gate review session with
  unresolved items, derived from `summary.unresolved > 0` on the same aggregate
  `GET /api/survey-flow-reviews` serves. It carries no decision affordance:
  continuation runs through the review workbench
  (`POST /api/projects/:slug/flow/runs/:runId/reviews/continue`).

Neither is projected for a hosted tenant read. The proposed-change store and
the review aggregate carry no tenancy predicate, so a tenant-scoped read has no
standing to see them.

Items carry `projectSlug` when the projection could derive one from the item's
own source. It is absent, never guessed, for a generic notification-backed
approval or a project-less session. Per-project counts are derived from
`items` by counting that field under the same pending predicate as
`pendingCount` (`attentionCountForProject`, `@kontourai/station-contracts/attention`);
the server publishes no per-project number for a client to trust.

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
