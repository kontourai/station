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

The response is a foreground handle containing `conversationId`, `sessionId`, the
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
It accepts `adoptSession`, `interruptTurn`, `respondToRequest`, and `stopSession`.
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

Three more command types exist on the same union but are outside this doc's session-lifecycle
scope — see the zod schemas in `orchestration.ts` for their exact shapes: `adoptSession`
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
A tool-output body alone does not establish success or failure; it is retained
as observed progress without inventing a verdict. Discovery and parser limits
are reported as incomplete observations. Cursor progress is saved after the
page's events, so an interrupted import replays through durable event-id
deduplication. This observation path does not enable Codex native continuation.

### The receipt envelope

Every lifecycle-control dispatch — success or failure — returns a receipt so a caller can prove a command
was accepted even if the eventual effect is asynchronous:

```jsonc
// 200, command accepted
{
  "success": true,
  "data": /* command-specific result or null */,
  "receipt": {
    "commandId": "uuid, generated server-side",
    "threadId": "string",
    "commandType": "adoptSession | interruptTurn | respondToRequest | stopSession",
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

Receipts are also independently durable and queryable after the fact — useful for a
script that dispatched a command and wants to re-confirm it later without re-reading the
whole session:

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

Every event the session has ever produced is persisted here — lifecycle events
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
not a limitation of the endpoint: every canonical event is
unconditionally appended to the durable event store (`EventStore.appendEvent`, no
per-method filtering), so the assistant's response *will* show up on a subsequent poll
once the turn actually completes. Poll until you see it, with a timeout.

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

An assistant turn's full text is `message.parts.find(p => p.type === 'text')?.text` —
already assembled from every `content.text-delta` in that turn (with a fallback to
`turn.completed.outputText` for providers that only emit the aggregate, never streamed
deltas). This is the recommended read path for turn content; no new route was added for
this slice because this one already exists and does the job.

### Live SSE feed (`GET /events`)

```
GET /api/orchestration/events              # all sessions the caller can read
GET /api/orchestration/events?threadId=X   # filtered to one session
```

On connect, the stream immediately emits one `orchestration:snapshot` event (the current
session read-model list), then streams `orchestration:event` events as they occur —
each one `{ event: CanonicalRuntimeEvent }`, the same event shapes as the replay
endpoint, filtered by `threadId` when the query param is set. A `ping` keepalive event
fires periodically; ignore it. Use this for a live dashboard/tail; use the replay
endpoint (or `/messages`) for "did the turn finish yet" polling in a script, since a
one-shot JSON GET is simpler to poll with a plain `fetch`/`curl` loop than managing an
SSE client.

---

## `/api/agents/:id/chat`

`POST /api/agents/:id/chat` accepts a persisted clean Agent ID. Station-engine
Agents use the native Station runtime; an external-engine default or custom Agent
enters the same binding-based orchestration path used by session commands. The
route never decodes an Agent ID into a connection ID and never manufactures an
Agent from connection state. Missing and unavailable Agents return distinct,
actionable diagnostics.

---

## Complete curl walkthrough (external engine over ACP, end to end)

This is the exact sequence proven live against a running instance — see
`scripts/session-api-roundtrip.mjs` for the scripted version this doc's proof standard
requires (`docs/design/chat-composer.md` §4: "a scripted nonce-grade round-trip against
a live instance using only documented endpoints").

```bash
PORT=3311
BASE="http://localhost:${PORT}"
THREAD_ID="session-api-demo-$(date +%s)"

# 1. Install the OpenCode ACP connection (builtin registry entry; one-time per
#    connection id — 409 if it already exists, which is fine to ignore).
curl -sS -X POST "${BASE}/acp/registry/opencode/install"

# 2. Start the default Agent persisted for that engine connection and send
#    the first turn through the canonical execution target.
curl -sS -X POST "${BASE}/api/orchestration/chat" \
  -H 'Content-Type: application/json' \
  -d "{
    \"target\": {
      \"environment\": { \"kind\": \"current\" },
      \"agent\": \"opencode\",
      \"workspace\": { \"kind\": \"directory\", \"cwd\": \"/tmp\" }
    },
    \"conversationId\": \"${THREAD_ID}\",
    \"message\": \"Read the file /tmp/session-api-nonce.txt and reply with its exact contents.\"
  }"
# -> { "success": true, "data": { "conversationId": ..., "resolution": ... } }

# 3. Send a follow-up through the persisted Environment + Agent binding.
curl -sS -X POST "${BASE}/api/orchestration/chat/${THREAD_ID}/continue" \
  -H 'Content-Type: application/json' \
  -d '{"message":"Confirm that value once more."}'
# -> { "success": true, "data": { "conversationId": ..., "resolution": ... } }

# 4. Poll for the assistant's reply (assembled text, not raw deltas).
curl -sS "${BASE}/api/orchestration/sessions/${THREAD_ID}/messages" | jq \
  '.data[] | select(.role == "assistant") | .parts[] | select(.type == "text") | .text'

# (Alternative: poll the raw replay and search for the nonce across every
#  content.text-delta's `delta` field, concatenated in order — this is what
#  /messages already does for you.)
curl -sS "${BASE}/api/orchestration/sessions/${THREAD_ID}/events" | jq \
  '.data[] | select(.method == "content.text-delta") | .delta' | tr -d '"\n'
```

If the model needs to approve a tool call mid-turn, poll step 4's `/events` (or the SSE
feed) for a `request.opened` event and resolve it:

```bash
curl -sS -X POST "${BASE}/api/orchestration/commands" \
  -H 'Content-Type: application/json' \
  -d "{
    \"type\": \"respondToRequest\",
    \"threadId\": \"${THREAD_ID}\",
    \"requestId\": \"<requestId from request.opened>\",
    \"decision\": \"accept\"
  }"
```


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
