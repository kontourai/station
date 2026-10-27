# Event content spill: keep runtime events small, store large values once

> **Reading status: accepted direction, implemented on
> `feat/event-content-spill-20261026` (not yet merged).** Owner decisions on
> the original open questions are recorded in [Owner decisions](#owner-decisions);
> where the implementation differs from this note, see
> [Implementation status](#implementation-status). Current behavior is owned by
> [EventStore](../../src-server/services/orchestration/event-store.ts), the
> spill planner ([event-content-spill.ts](../../src-server/services/orchestration/event-content-spill.ts))
> and the [Module map](../architecture/module-map.md). Line references in the
> problem and reader sections are to `origin/main` at `2ae604ccc1c`. Claims
> marked **(source)** were inferred from reading the code path.

## Problem

EventStore refuses every canonical runtime event whose compact JSON exceeds
`MAX_EVENT_STORE_INGRESS_BYTES` (64 KiB, `event-store.ts:467`) or whose shape
exceeds depth 32, 512 keys or 512 array items (`event-store.ts:475-477`). The
check is `BoundedEventStoreIngressProjector` (`event-store.ts:1085-1420`), run
twice by `prepareEventIngress` (`event-store.ts:3826-3910`): once on the raw
event and once on the persisted form after attachment projection. It is
Station's own backstop (station#2210), not an engine limit.

Ordinary engine content exceeds it:

| Event | Producer with no bound **(source)** | Outcome today |
| --- | --- | --- |
| `request.opened` | Claude `toolInput` (`claude-adapter.ts:4005-4061`); ACP `rawInput` (`acp-adapter.ts:2937-2965`); station-agent `toolArgs` (`station-agent-adapter.ts:767`); Codex raw params (`codex-adapter-events.ts:217-322`) | Refused. The adapter still holds the request in its pending map, nobody sees it, and the engine waits forever. That is the production wedge. |
| `turn.completed.outputText` | Claude `message.result` (`claude-adapter-events.ts:1132`), Codex accumulated output (`codex-adapter-notifications.ts:306`), station-agent delta sum (`station-agent-adapter.ts:1484`) | Refused, so the turn terminal is lost (reported as reproduced on the abandoned `fix/oversized-turn-terminal-20261024` branch; not re-run here). |
| `turn.started.prompt` | `CHAT_INPUT_MAX_CHARS` admits 200,000 characters (`src-shared/chat-input-limits.ts`) | Over 64 KiB is refused at the store **(source; not executed)**. |
| `tool.started.arguments` | Codex `fileChange.changes` (`codex-adapter-events.ts:717-733`), station-agent (`station-agent-adapter.ts:675-680`) | Refused. |
| `tool.completed.output` | station-agent passes output through unbounded (`station-agent-adapter.ts:721-737`) | Refused. |
| `content.text-delta` | Live adapters do not chunk (`claude-adapter-events.ts:869`, `codex-adapter-notifications.ts:177`, `acp-adapter-events.ts:237`); the coalescer emits a single oversized delta whole (`delta-coalescer.ts` `offer`) | Refused. |
| `plan.updated.entries`, `extension.notification.payload` | ACP | Refused when large or wide. |

The cost of a refusal depends on the path:

- **Live adapters.** The error escapes `publishObservedEvent`
  (`orchestration-service.ts:10892`) into `consumeAdapterEvents`
  (`orchestration-service.ts:10665`). Its catch logs "Provider adapter event
  stream stopped", publishes `adapter-event-stream-interrupted` to every
  thread on that adapter and restarts consumption (`orchestration-service.ts:10788-10870`).
  The offending event is gone.
- **Attached-session follow.** It logs, skips the event and advances
  (`attached-session-follow-service.ts:1230-1300`, station#2210).

The only per-adapter guard is #4118's Codex refusal
(`codex-adapter-transport.ts:932-965`). It refuses approvals over 48 KiB or
deeper than 30 / wider than 512 back to Codex ("split the operation") and
publishes `codex-approval-request-too-large`. That was the right call under
the 64 KiB constraint. Claude, ACP and station-agent have no such guard.

There are also two read-side gaps that the same design should close:

- A `request.opened` between 24,577 bytes and 64 KiB is stored and delivered
  live, but every window read strips it to identity fields
  (`snapshotEvent`, `event-store.ts:1854-1985`, `elided: 'byte_limit'`). After
  a reload `openApprovalRequests` (`src-ui/src/hooks/orchestration/pendingRequestRows.ts:39`)
  no longer sees its `requestId`, so neither the strip nor the toast can
  answer it **(source)**.
- Conversation fork reads the bounded window
  (`src-server/routes/chat/conversations.ts:351`) and ignores `elided`, so a
  `turn.completed` over 48,000 bytes silently drops out of a fork **(source)**.

## Rejected approaches

| Approach | Why not |
| --- | --- |
| Shorten strings and structures at admission with visible markers (PR #4121, `fix/ingress-structural-projection-20261024`) | A person can approve content they cannot fully see, and the shortening rules sit on top of an arbitrary cap. Every new producer needs new rules. |
| Per-adapter refusal (extend #4118 to Claude, ACP, station-agent) | Stops the wedge but refuses ordinary work. The agent is told to split an operation it often cannot split (one `Write` of one file). |
| Raise the ceiling | The backstop exists so a hostile or runaway value cannot become one SQLite row, one SSE frame and one window read. Window reads (24,576 bytes per event, 56,000 per page) would still strip the event. |
| Store a long reply as a reference to the turn's persisted deltas (`fix/oversized-turn-terminal-20261024`) | Worth weighing, but it only covers `outputText`. It is also not exact: Claude's `outputText` is only the final answer and differs from the streamed text, which is why the projection reconciles them with `startsWith`/`endsWith` (`packages/shared/src/runtime-event-projection.ts:1353-1387`). Session sources emit no `outputText`. The generic mechanism below covers this case exactly at the cost of storing the reply text twice, which is already true for replies under 64 KiB. |

## Decision summary

1. **Spill, don't refuse.** At ingress, EventStore moves large values out of
   an allowlist of content fields into a new table,
   `orchestration_event_content`, in `orchestration.sqlite`. The event keeps a
   typed reference with a byte-bounded preview in the value's place.
2. **Same lifetime, same transaction.** Content rows are keyed by
   `(thread_id, digest)`, written in the append's savepoint, deleted by
   `deleteThread` in its transaction, and carried by every backup of
   `orchestration.sqlite`.
3. **Resolution is opt-in and batched.** Only the readers that owe their
   caller exact content resolve references, with one batched lookup per read.
   Session-wide replays stay unresolved, so hot paths never load bodies.
4. **Deltas are split, never spilled.** Oversized text and reasoning deltas
   are cut into chunks measured on the serialized event before
   `publishObservedEvent`. The coalescer caps merged deltas in bytes.
5. **References cannot be forged.** Any inbound object using a reserved key is
   escaped unconditionally. Resolution is single-level and never interprets a
   stored body. The live path must pass its prepared ingress to the append.
6. **Approvals load whole before Allow is enabled.** The server refuses an
   accept of a spilled request unless the client names the digest of the
   stored, reference-bearing payload it loaded.
7. **#4118's Codex refusal is removed.**
8. **Residual refusal declines, it does not stop the stream.**

## Owner decisions

Recorded 2026-10-26, answering the phase 1 open questions:

| Question | Decision |
| --- | --- |
| Absolute ceiling | 16 MiB per event. |
| Per-thread quota | None. Add metrics (spilled bytes and values, by method and provider). |
| One-click approve of a spilled request | The CLI and MCP agent approve tools fetch the content and send the stored-payload digest automatically. Push notifications and toasts offer "Review", not Allow. |
| Deltas | Split, never spilled. |
| Hosted mode | The content route works in hosted mode under the window reads' tenant authority. |
| Older clients | Showing a reference object, and a 409 on one-tap approve of a spilled request, is acceptable. |
| Request `title` / `description` | `description` is spillable; `title` stays inline. |

## Storage

### Chosen: a thread-scoped table in `orchestration.sqlite`

```sql
-- src-server/domain/migrations/024-event-content.ts
CREATE TABLE IF NOT EXISTS orchestration_event_content (
  thread_id   TEXT NOT NULL,
  digest      TEXT NOT NULL,   -- 'sha256-' + hex of (kind || NUL || UTF-8 body)
  kind        TEXT NOT NULL CHECK (kind IN ('string', 'json')),
  body        TEXT NOT NULL,   -- the string itself, or compact JSON of the subtree
  bytes       INTEGER NOT NULL,  -- UTF-8 bytes of body
  PRIMARY KEY (thread_id, digest)
) WITHOUT ROWID;
```

Reasons:

- **Lifetime.** A content row must live exactly as long as the events that
  reference it. The only physical event deletion is `deleteThread`
  (`event-store.ts:13742`, the `DELETE FROM orchestration_events` at `:13843`).
  It already deletes thread-scoped side tables in one `BEGIN IMMEDIATE`
  transaction. The closest precedent is `orchestration_html_reply_pages`
  (`src-server/services/orchestration/html-reply-pages.ts:21`, deleted at
  `event-store.ts:13772`). One more `DELETE FROM orchestration_event_content
  WHERE thread_id = ?` there makes deletion complete and atomic.
- **Atomicity.** Rows are inserted inside the append savepoint
  (`appendIngressedEvent`, beside `recordAttachmentRefs` at
  `event-store.ts:4246`). A rolled-back append leaves no content. The only
  orphans possible are rows left by a downgrade that deleted a thread with an
  older Station; a startup sweep removes them (see
  [Retention](#retention-deletion-and-migration)). A file store cannot give that: attachment blobs are
  written before the append and rely on retention to reclaim orphans
  ("server-only blob writes, unreferenced if the append fails and bounded by
  retention", `orchestration-service.ts:12627-12630`).
- **Backup and move.** `STATION_HOME_SQLITE_STORES` lists
  `data/orchestration.sqlite` (`packages/shared/src/station-home-store-registry.ts:266`),
  so home archives and cloud moves carry content with its events.
- **SQL readers can join it.** Several readers use `json_extract` in SQL,
  including the transcript-search worker on its own connection. A table lets
  them resolve with a plain `LEFT JOIN`, with no registered function.
- **Determinism.** The digest is computed from the kind and value (the kind is
  in the preimage, so the string `{"a":1}` and the object `{"a":1}` never
  collide), so the same event spills to the same bytes. The planner is
  versioned (`spilledContent.v`) so a future planner change is a visible
  identity change, not a silent replay conflict. The exact-replay check in `appendIngressedEvent`
  compares the stored payload text (`existing.payload !== serializedPayload`,
  `event-store.ts:4209`) and keeps working. Rows are `INSERT OR IGNORE`.
- **Isolation.** Keying by thread means a reference only ever resolves
  against content its own thread stored. The cross-thread binding problem the
  attachment store had to solve (#2483, `event-store.ts:3508-3520`) does not
  arise.

### Rejected: the attachment blob store

`AttachmentBlobStore` (`src-server/services/orchestration/attachment-blob-store.ts`)
expires blobs after 90 days or past 512 MiB (`:29-32`, retention at
`:276-315`). An approval's arguments or a turn's reply that disappears after
90 days, while the event that references it remains, is the content loss this
work exists to remove. The store also writes outside the append transaction,
deduplicates across threads (so deletion needs the ref-count walk at
`event-store.ts:13914-13923`), and only the HTTP route can read it, not SQL.
Its retention suits pasted images that are explicitly allowed to fade to a
chip. It does not suit event content.

### Rejected: a column on `orchestration_events`

A `content` column next to `payload` would make every `SELECT payload` that
today reads a small row read megabytes, unless every query was audited. It
also cannot deduplicate a value repeated in a thread, such as the same file
content in `tool.started.arguments` and `request.opened.payload.toolInput`.


## Reference shape

### In the stored and live event

A spilled value is replaced in place by:

```ts
// packages/contracts/src/runtime-event-content.ts (new subpath)
export interface RuntimeEventContentRef {
  readonly $stationContent: 1;
  readonly ref: `sha256-${string}`;
  readonly kind: 'string' | 'json';
  /** UTF-8 bytes of the full value (the string, or its compact JSON). */
  readonly bytes: number;
  /** For strings: UTF-16 length of the full value. */
  readonly length?: number;
  /** For json: container type and its item or key count. */
  readonly shape?: { readonly type: 'array' | 'object'; readonly size: number };
  /** A head of the value whose JSON encoding is at most 512 bytes. Never the full value. */
  readonly preview: string;
}

/** A value over the absolute ceiling. */
export interface RuntimeEventContentUnavailable {
  readonly $stationContent: 1;
  readonly unavailable: 'exceeds-ceiling';
  readonly bytes: number;
}

/** An inbound object that used a reserved key, kept verbatim. */
export interface RuntimeEventContentLiteral {
  readonly $stationLiteral: Record<string, unknown>;
}
```

The envelope gains one computed field. EventStore sets it and never accepts
it from a producer (ingress deletes any inbound value):

```ts
spilledContent?: { readonly v: 1; readonly count: number; readonly bytes: number };
```

The preview is bounded in **bytes**: the longest head whose
`JSON.stringify` is at most 512 bytes, cut on a code-point boundary. 512
UTF-16 units could encode to about 3 KB once escaped.

An object in place is used because of how readers behave:

- **A preview string in place** is silently taken as the whole value by every
  reader that checks `typeof x === 'string'`.
- **A side map with the field removed** makes readers believe the value was
  absent.
- **An object in place** is visible, but it does *not* fail closed in
  general. Readers guarded by `typeof x === 'string'` silently drop it.
  Every such reader is listed in [Readers](#readers) with an explicit
  disposition, and contracts types make the reference a union member so the
  compiler finds them.

Contracts helpers are pure, with the caller supplying the lookup:
`isRuntimeEventContentRef`, `collectRuntimeEventContentRefs(value)`,
`resolveRuntimeEventContent(value, lookup)`, `unescapeRuntimeEventContent(value)`
and `runtimeEventContentText(value)`. The last returns a string for a string
or a reference, so display code never prints `[object Object]`.

`RuntimeEventElisionReason` (`packages/contracts/src/orchestration.ts:1349`)
is unchanged. A spilled value is not withheld from a read; it can be resolved.

### Escaping and forged references

The review found that a forged `$stationContent` object (about 200 bytes) is
under the spill threshold, stays inline, and would resolve as real. It could
then name any digest stored in the thread, and the approval card would show
that content while the engine runs the literal. The rules are:

1. **Escape unconditionally.** During the raw projection, any inbound object
   with an own key `$stationContent` or `$stationLiteral` is stored as
   `{ "$stationLiteral": <object> }`, with its children processed normally.
   So a bare `$stationContent` object in a stored payload can only have been
   written by the planner.
2. **Single-level resolution.** A resolver replaces a planner reference with
   the stored body, parsed for `json`, and does not look inside it. Bodies are
   the original raw value: the planner never spills inside a spilled subtree
   and never escapes inside a body. Then the resolver unwraps
   `$stationLiteral`.
3. **No re-projection of references.** The live path passes its prepared
   ingress to the append (see [Ingress](#ingress-algorithm)). The phase 1
   pending-map fallback is dropped. Re-projection also loses
   `mcpAppResourceUri` (`event-store.ts:3858-3880`). An event handed to
   `appendEvent` that already contains reference objects is escaped like any
   inbound data.

## Spill policy

### Targets

| Name | Value | Why |
| --- | --- | --- |
| `EVENT_STORED_TARGET_BYTES` | 16 KiB | Every stored event stays whole under the window per-event ceiling (24,576, `event-store.ts:1579`) and well inside the SSE replay budget (96,000, `src-server/constants.ts:20`). |
| `SPILL_MIN_VALUE_BYTES` | 1 KiB | A smaller value is never spilled. |
| Stored-form structure | depth ≤ 24, ≤ 256 entries per container | Below the backstop's 32 / 512. |
| `MAX_EVENT_CONTENT_BYTES` | 16 MiB per event, raw | Owner decision. |
| Raw structure | depth ≤ 256, ≤ 200,000 values | Keeps the recursive walk stack-safe and bounded. |
| `MAX_EVENT_STORE_INGRESS_BYTES` | 64 KiB, unchanged | The backstop, now on the stored form only. |

### Allowlist of spillable fields

Only these roots may be spilled. Anything else is inline. If inline fields
alone exceed the backstop, that is the [residual case](#residual-refusal).

| Method | Spillable roots |
| --- | --- |
| `request.opened` | `description`; `payload.toolInput`, `payload.toolArgs`, `payload.rawInput`, `payload.arguments`, `payload.args` (the `TOOL_REQUEST_ARGS_FIELDS`, `packages/shared/src/tool-request-preview.ts:29`); Codex raw params `payload.changes`, `payload.command`, `payload.message`, `payload._meta` |
| `turn.started` | `prompt`, `ambientContext` |
| `turn.completed` | `outputText` |
| `tool.started` | `arguments` |
| `tool.progress` | `output` |
| `tool.completed` | `output`, `error` |
| `plan.updated` | `entries` |
| `extension.notification` | `payload` |

`content.text-delta` and `content.reasoning-delta` are never spilled. Fields
that decide what a person is offered are never spilled:
`payload.inputRequest`, `mcpElicitation`, `questionnaire`, `suggestions`,
`permissionMode`, `claudeAsk`, `decisionReason`, `blockedPath`,
`networkApprovalContext`, `toolName`/`tool`, `toolCallId`, `options`, `title`.
A Claude `AskUserQuestion` keeps its form inline, so it can never become a
one-click Allow.

Within a spillable root, the planner is deterministic, so replay is
idempotent:

1. **Structure first.** Any container over 256 entries, or reaching depth 24,
   is spilled whole, starting from the outermost violating container.
2. **Then size.** While the stored form exceeds 16 KiB, spill the largest
   remaining value (a string, or a subtree, of at least 1 KiB) inside an
   allowlisted root. Ties are broken by JSON path order.

Largest-first keeps small leaves such as `toolInput.dangerouslyDisableSandbox`
inline. Grant derivation does not rely on that: the UI derives grants and
forms from the resolved payload once it is loaded, and server derivations
resolve first.

`tool.completed` events carrying `mcpAppResourceUri` keep their output inline
up to the 24,576-byte window ceiling. This preserves today's MCP App
passthrough in `snapshotEvent`.

### Deltas: split, never spilled

The review measured that splitting with `utf8Chunks(text, 16 KiB)` and adding
the envelope serializes to about 16,670 bytes, which is over the target. Every
full chunk would fall through to spill, and the live delta would become a
reference object. That breaks `streamHandlers.ts:103` (prints `[object
Object]`), the CLI `session-client.ts:996` (drops it) and the projection's
`textBuf += ev.delta`. Two more findings:

- `utf8Chunks` is quadratic: about 823 ms for 4 MiB and 11.1 s for 16 MiB on
  the event loop.
- The coalescer cap is 8,000 *characters* (`delta-coalescer.ts:168`). That is
  about 24 KB of CJK text, or about 48 KB of escaped control text.

Revised rules:

- A new linear chunker, `splitJsonTextByEscapedBytes(text, maxBytes)`, makes
  one pass and counts each code unit's JSON-escaped UTF-8 bytes. It never
  splits a surrogate pair.
- Chunks are at most 8 KiB of escaped text. The OrchestrationService splits an
  oversized delta in the adapter consumption loop, **before**
  `publishObservedEvent`, so each chunk gets its own #3560 retry. The first
  chunk keeps the `eventId`; chunk `k` gets `${eventId}:${k}`. `itemId` is
  unchanged.
- The coalescer cap becomes 8 KiB of escaped bytes, measured with the same
  counter.
- A delta that still exceeds the backstop by another route is a residual
  refusal and is reported as a warning. It is never spilled.

`child-work.updated` also has a `delta` field, a structured object. The split
is keyed on method, not on field name.

## Ingress algorithm

`prepareEventIngress` (`event-store.ts:3826`) becomes:

1. **Raw projection.** The existing descriptor-only walk, against the
   absolute ceilings instead of 64 KiB. It escapes reserved-key objects and
   deletes any inbound `spilledContent`.
2. **Station fields and attachments.** As today (`:3858-3888`).
3. **Spill planning.** Allowlisted roots only. Produces
   `spills: Array<{ digest, kind, body, bytes }>`.
4. **Backstop.** The unchanged 64 KiB / 32 / 512 projector on the stored form.
5. **Snapshot stamps.** If `tool.completed.output` or `error` was spilled,
   `htmlReply` and `stationControlRefusal` are derived from the raw value and
   stamped, so `snapshotEvent` (`event-store.ts:1854`) never derives them from
   a reference. This is required.

`projectLiveEvent` returns an opaque `PreparedEventIngress`. The append
accepts that object (`appendPreparedEvent`) and never re-projects. Content
rows are inserted in the append savepoint next to `recordAttachmentRefs`
(`event-store.ts:4246`, `:5082`).

Message search indexing (`projectMessageSearchEvent`, `event-store.ts:14462`)
receives the raw values, **capped at 256 KiB of indexed text per field**. FTS
v2 and v3 both store and tokenize what they are given, so 16 MiB would cost
about four times that inside the append savepoint. The cap is recorded in
the guide as a search limit.

## Readers

### Resolution seam

Resolution is **opt-in**. The phase 1 plan made hydration the default for
full reads, but those include hot paths that replay whole sessions:
`orchestration-service.ts:9656`, the monitor supervisor,
`session-query-module.ts:502,571`, `interrupted-turn-recovery.ts:754` and
`session-recovery-coordinator.ts:1427`. Loading bodies there would be a
regression.

`EventStore.resolveEventContent(events)` collects references across all the
given events and does one `SELECT … WHERE thread_id = ? AND digest IN (…)`
per thread, chunked under the bound-parameter limit (`event-store.ts:1524`).
Readers call it explicitly. A missing row resolves to
`RuntimeEventContentUnavailable`, never to the preview.

### Readers and their disposition

`O` means the reader opts in to resolution. `J` means a SQL join. `T` means
it takes the text through `runtimeEventContentText` or the projection's
reference handling. `P` means a preview or reference is the intended form.

| Reader | Disposition |
| --- | --- |
| `readCurrentRequestEvent` (`event-store.ts:6885`), `readCurrentInputRequest` (`request-inspection.ts:154`) → input-request route | O |
| `respondToRequest` validation and grant (`orchestration-service.ts:9163-9207`, `11307-11335`) | O, through the request read |
| Approval inbox (`approval-inbox.ts:440-533`) | O: when `spilledContent` is set, it re-reads the request resolved before deriving grants and actions |
| Recovery re-dispatch (`session-recovery-coordinator.ts:490`, `eventById`) | O |
| Delegation output (`delegation-result-delivery.ts:1250`, `listTurnEventsByMethods`) | O |
| `readAssistantTurn` (`session-query-module.ts:556`, turn-bounded) | O |
| Review executor (`orchestration-review-executor.ts:183-230`) | O on the `turn.completed` it parses |
| `get_task_events` (`station-control-delegation.ts:4069`) | T plus a prefix read of at most 8,192 characters, keeping `truncated` honest |
| User input, tool result, basis, digest, prompt lookups (`event-store.ts:798-846`, `8591`, `6248`, `5574`, `6617` `firstTurnStartedWithPrompt`, `6633` `turnPromptsContaining`, `7976` `fetchFirstTurnStartedWithPrompt`) | J: `LEFT JOIN orchestration_event_content` on `json_extract(payload, '$.<field>.ref')`. Length and type checks read the joined body. |
| Transcript-search worker (`transcript-search-queries.ts:285`) | J, with `substr` on the joined body in SQL so the worker never loads a whole body |
| Search backfill (`event-store.ts:14356`) | J, capped like live indexing |
| Server transcript projection (`runtime-event-projection.ts`) on unresolved session replays | T: a reference `outputText` is "not known" (keep the deltas; never replace `textBuf`). Tool `arguments`/`output` render the preview with an explicit `[N bytes not inlined]` marker. |
| `shared/thread-projection.ts:90-140` | T |
| Conversation export (`conversations.ts:2034`) | O (explicit user action) |
| Fork (`conversations.ts:840-1125`) | P. Not hydrated: `FORK_WINDOW_MAX_BYTES` (2 MiB, `conversations.ts:340`) bounds the window, so references stay references, and the seed renders previews with the marker. |
| Engine transcript seeds: handoff, return, pinned context and history continuation (`conversation-lineage.ts` `captureTranscriptContext`, `readConversationTranscriptMessages`) | O through a seed-only reader (`readSessionSeedMessages`): the read check runs first, then the projection reads resolved payloads, so a seed counts a long reply at its real size under its own budget (whole, or disclosed as omitted). Discovery (`readSessionConversation`) and every other `readSessionMessages` caller keep references |
| Answer share, room publication, Discord, intent summary | T through the projection (marked previews). These already carry bounded text. |
| Monitoring bridge (`orchestration-monitoring-bridge.ts:131,161,237`) | T for arguments and output; `length` from the reference |
| `snapshotEvent` | Stamps derived at ingress (above) |
| UI `streamHandlers.ts:103`, `turnHandlers.ts:205`, `planHandlers.ts:26`, `semanticDeliveryBuffer.ts:135-179`, `offlineReading.ts:170-190` | T. Deltas are never references; the rest use the text helper or render a reference chip with "Load full content". |
| `replay/tape-validation.ts:109,118` | T: a reference is a valid shape |
| CLI `operate/derive.ts:100`, `session-client.ts:996` | T |
| `flow-policy-sidecar.ts` | Unaffected: it sees the raw adapter event |

Every reader above that guards with `typeof x === 'string'` would otherwise
silently drop a reference. Each gets a test with a spilled value.

### Bus emitters must emit the persisted form

Live SSE frames are the bus event. The follow service
(`attached-session-follow-service.ts:1262`) and the platform-mutation gate
(`runtime-initialize.ts:776-777`) emit the raw event today. `appendEvent` and
`appendEventIfAbsent*` return the persisted payload, and both emitters use it.

## Live delivery, windows and replay

- Live SSE carries the stored form: at most 16 KiB, identical to what a
  reload returns.
- Window reads stop producing `byte_limit` for new events. `output_limit`
  stays.
- SSE replay is unchanged.
- The client outbox ([offline-outbound-queue.md](offline-outbound-queue.md))
  replays user turns, not runtime events.
- Remote Stations resolve through the remote content route.

## Approvals and tool details in the UI

### Content route

`GET /api/orchestration/sessions/:threadId/content/:ref` returns the **raw
body**, with no JSON-in-JSON escaping:

- `Content-Type: text/plain; charset=utf-8` for `string`,
  `application/json` for `json`.
- Headers `X-Station-Content-Kind` and `X-Station-Content-Bytes`.
- `?maxChars=N` returns a prefix with `X-Station-Content-Complete: false`.

Authorization uses the window reads' session-read authority, including
hosted tenant scope. The tool-result point read is disabled in hosted mode
(`orchestration.ts:5800`) because it has no tenant-scoped owner; the content
route borrows the window authority instead. Lookup is by `(threadId,
digest)`. The route is added to `src-server/security/pairing-route-scopes.ts`
so paired phones can load approvals. There is no capability flag: a client
only ever sees a reference from a host that stores them, and every such host
serves the route, so a flag would name a state nothing computes.

### Approval card

1. The card renders previews labelled "Loading full request…" and fetches
   every reference in `request.opened`. It also fetches references in the
   bound `tool.started.arguments`, because Codex `fileChange.changes`
   (`codex-adapter-events.ts:726-729`) is shown from there.
2. Allow, Allow for session and the server grant stay disabled until all of
   them resolve. Deny is always enabled.
3. Grant labels and form detection (`runtime-event-projection.ts:1259-1264`,
   `approvalHandlers.ts:133-185`, `pendingRequestRows.ts:139-169`) run on the
   resolved payload once it is loaded. Until then there is no grant button at
   all.
4. Errors show an `ErrorState` with retry.
5. Loaded arguments render whole and scrollable.
6. Toasts offer "Review" (open the card) and Deny, and inbox notifications offer Deny (opening one is the review), for a spilled
   request.

### Server-side guarantee

For a request with `spilledContent`, an `accept`, `acceptForSession` or
server grant must carry two things:

- `expectedRequestEventId`.
- `viewedContentDigest`: sha256 of the **stored** reference-bearing request
  text, plus the references of its bound tool calls (see
  [Fix round 2](#fix-round-2-2026-10-26)). References already hash their
  bodies, so this digest binds the exact content without the client
  recomputing a canonical form of the resolved value.

Otherwise the server answers 409 `request_content_not_loaded`. The client
computes the digest from the stored payload only after every reference has
loaded. That is the capability check that it loaded the content. Decline and
cancel never need either field. Per answering path:

| Path | Decision |
| --- | --- |
| UI card | Sends both after loading. |
| CLI `station approvals` and SDK | Fetch the content, then send both. |
| Delegation approve (`station-control-delegation.ts`) | The delegating agent's tool fetches the binding and echoes its digest, pinning the request event it read. It does not load the bodies or show them to the agent first (see [Fix round 2](#fix-round-2-2026-10-26)). |
| Operations tool (`station-control-operations-tools.ts:1090`) | Same as delegation. |
| Approval-inbox dispatch (`approval-inbox.ts:182,232`) | Notification actions for a spilled request offer only Deny; opening the notification is how it is reviewed and allowed. A dispatched accept without the digest is refused with 409. |

### Other tool details

Spilled `tool.started.arguments`, `tool.completed.output`, plan entries and
extension payloads render the preview with an explicit "Load full content"
action. "Output truncated" stays reserved for `ToolOutputReceipt`.

## Residual refusal

After spilling, the remaining cases are content over 16 MiB or the raw
structural ceiling, a hostile shape, or inline (non-allowlisted) fields over
the backstop. `EventStoreIngressError` gains `eventId`, `method` and
`threadId` fields. `publishObservedEvent` catches it per event, so the stream
keeps running and is not restarted:

| Event | Behavior |
| --- | --- |
| `request.opened` (the error's `eventId` equals the offered event's) | `adapter.respondToRequest(threadId, requestId, 'decline', { declineReason })` and `runtime.warning` `request-too-large-to-show`. |
| Over-ceiling value in an allowlisted root | Stored as `RuntimeEventContentUnavailable`, with a warning. |
| Anything else | Warning naming the event, then skip. |

A coalescer-flushed delta's ingress error carries the delta's own `eventId`,
so it can never be attributed to, or decline, an unrelated request.

## Removing #4118

Delete `codex-adapter-transport.ts:932-965` and its warning code. Update
`codex-approval-delivery.test.ts` and `docs/reference/session-api.md:563-566`.
This lands with the gate and the residual decline, never before.

## Retention, deletion and migration

- `deleteThread` deletes content rows in its transaction.
- **Startup sweep:** `DELETE FROM orchestration_event_content WHERE thread_id
  NOT IN (SELECT DISTINCT thread_id FROM orchestration_events)`, bounded and
  run once at open. It removes rows orphaned when an older Station deleted a
  thread after a downgrade.
- **Metrics:** spilled bytes and values by method and provider; sweep
  removals.
- **Migration:** `CREATE TABLE IF NOT EXISTS`. Existing rows carry no
  references, and every resolver treats "no reference" as inline. There is no
  backfill.
- **Downgrade:** an older Station shows reference objects. Content is
  retained until that Station deletes the thread, and the sweep then reclaims
  it.

## Tests that will prove it

Each test goes through a real seam with the production shapes. Fault
injection follows the repository rule.

1. Ingress:
   - Codex `mcpServer/elicitation/request` with a 38 KB `html_preview` in
     `_meta`, and Claude `Write` with a 1 MB `content`.
   - 600-entry `plan.updated`, 80 KB and 300 KB `turn.completed`.
   - Each stored row is at most 16 KiB.
   - The resolved event deep-equals the input.
   - Inject: planner off.
2. Forged reference round-trips as a literal; never resolves.
   - Inject: escaping off.
3. Kind collision: the string `{"a":1}` and the object `{"a":1}` get different
   digests.
4. Replay idempotency.
   - Inject: nondeterministic order.
5. `deleteThread` and the startup sweep.
   - Inject: delete removed.
6. Live: frame size, content route raw body, 409 without the digest, accept
   with it.
   - Follow-service and platform emitters.
7. Codex adapter: the 38 KB approval is delivered (the #4118 test is
   inverted).
8. Delta: a huge single delta becomes chunks of at most 8 KiB escaped, each
   persisted, never spilled.
   - Linear chunker timing for 16 MiB is under 500 ms.
   - Byte-based coalescer cap with CJK.
9. SQL readers find text past the preview; search hit past the preview,
   within the 256 KiB cap.
10. Residual: a 20 MiB request is declined and a warning is published. The
    stream continues.
11. UI: the approval card keeps Allow disabled until content loads; rendered
    screenshots at 390 and 1440 in both themes.
12. Migration fixture.

## Fix round 1 (2026-10-26)

- **Approval roots are generic.** A `request.opened` may spill its
  description and every payload field except those surfaces read before
  loading (`inputRequest`, `mcpElicitation`, `questionnaire`,
  `requestedSchema`, `toolName`/`tool`, `toolCallId`, `suggestions`,
  `claudeAsk`, `permissionMode`, `options`, `agentId`, and Codex `kind`,
  `networkApprovalContext`, `proposedExecpolicyAmendment`,
  `proposedNetworkPolicyAmendments`). The per-key list in
  [Allowlist of spillable fields](#allowlist-of-spillable-fields) is
  superseded for approvals: Codex `commandActions` repeats the command and
  left 30 KiB approvals over the window ceiling and 70 KiB ones over the
  backstop.
- **Forms are exempt from the viewed-content digest.** A form's answer is the
  person's content, validated against the form itself, which is never
  spilled; accepting runs nothing the spilled fields describe (they are the
  asker's copy of the questions or display text), and a form cannot be
  answered `acceptForSession`. Every form surface therefore keeps working
  without a digest.
- **Session grants** auto-approve later matching requests without showing
  them, spilled or not. This is the existing grant semantics, unchanged.
- **Load full content** is offered on spilled prompts, replies and tool
  arguments or output, and since fix round 2 on plans.
- **Approval inbox** grant labels still derive from the stored payload; for a
  spilled request the card offers only Deny, so no label derived from it is
  offered (accepted gap).
- A turn terminal that cannot be stored even with its reply marked
  unavailable persists with only its identity and outcome.
- **Bound content is gated too.** The server finds the `tool.started`
  events whose call id is the request's `toolCallId` or Codex `itemId`
  (`requestBoundCallIds`). If the request or any of them holds spilled
  content, an allow needs the digest of `viewedContentPreimage(request,
  bound)`: the stored request text plus the sorted references of the bound
  events. A Codex file change's diff lives only in its `tool.started`; the
  request itself is small. The card, the strip (which shows the bound
  call's arguments), the CLI and the delegation tool send it.
- **Lone surrogates.** A spilled string with a lone surrogate is stored as
  the `json` kind, whose escapes keep it exactly; SQLite TEXT and the digest
  would otherwise turn it into U+FFFD.

## Fix round 2 (2026-10-26)

- **One binding definition.** Clients no longer find bound calls
  themselves. `GET /api/orchestration/sessions/:threadId/requests/:requestId/content-binding`
  returns the server's `approvalContentBinding`: the stored request, its
  bound `tool.started` events (the newest 16, the same limit the gate
  reads), whether a digest is `required`, and the digest. The gate uses the
  same function. The UI card, the SDK `loadApprovalContent` and the CLI
  load every reference in the binding, recompute the digest with the shared
  contract `viewedContentPreimage`, refuse a binding that does not match its
  events, and send the server's digest. The delegation tool is the
  exception (intended, an owner decision): it fetches the binding and
  echoes its digest without loading the bodies, so the delegating agent
  approves without being shown the full content; it pins the request event
  it read, so a request that changed since is refused. The route is in the
  pairing scopes and uses the window-read authority.
- **A 409 refreshes.** A `request_content_not_loaded` answer (a bound call
  arrived after the card loaded) refetches the binding and loads again; the
  card's query key includes the references it shows.
- **Toasts and the inbox check bound content.** A request whose gated call
  holds spilled content (a Codex file change) gets Review and Deny in the
  toast and Deny in the inbox. The inbox reads the server binding and fails
  closed: a binding that is missing or unreadable also gets Deny only. A
  card built before a spilled bound call arrived is written again with Deny
  only when that call is stored, or when the server refuses an allow from
  it; a toast re-shown after a refusal offers Review. The chat card marks
  itself as needing a load as soon as the bound call's arguments show a
  reference, before any refusal.
- **Decision fields are pinned** by a test, with `itemId` added. Codex params
  named like a field Station sets (`inputRequest`, `mcpElicitation`,
  `questionnaire`) are dropped from the request payload, so a raw param can
  never make an approval read as a form.
- **Load full content** moves focus to the loaded content (its button is
  gone), and a value whose references change offers the load again instead
  of showing the earlier content. In the person's filled bubble the button
  takes the bubble's foreground.
- **Multi-line text arguments** (a file body, a loaded spilled value) show as
  their own blocks with real line breaks, after the short arguments.
- **Plans.** A single plan entry's text can be stored out of line, not only
  the whole list. `PlanEntry.content` is spillable text, the plan handler
  shows its preview as text, the replay tape accepts it, and the plan panel
  offers Load full content for either form.

## Implementation status

Implemented, with tests through the seams named in
[Tests that will prove it](#tests-that-will-prove-it) and fault injection of
each mechanism (planner, escaping, kind in digest, deletion, sweep, live
ingress reuse, SQL joins, search cap, delta split, byte cap, server gate, card
gate, digest agreement, residual handling, store-marked markers, stored-form
emission, review resolution, the #4118 refusal). Differences from the body
above:

- **No capability flag** (see [Content route](#content-route)).
- **`get_task_events`** shows a spilled reply's preview (at most 512 bytes of
  JSON) marked `truncated`, not an 8,192-character prefix read.
- **Conversation export** does not resolve references yet: exported messages
  carry the marked preview. Accepted gap.
- **Delegation result output** resolves through the opt-in read in its port
  wiring (`runtime-routes.ts`); that wiring has no direct test.
- **Delegated-agent approve tools** send the stored-event digest without
  returning the full content to the agent first.
- **Plan panel** loading has component tests, no browser screenshot.
