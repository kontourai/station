# Event content spill: keep runtime events small, store large values once

> **Reading status: proposal (phase 1 design, not implemented).** Nothing in
> this note is shipped. Current behavior is owned by
> [EventStore](../../src-server/services/orchestration/event-store.ts) and the
> [Module map](../architecture/module-map.md). Line references are to
> `origin/main` at `2ae604ccc1c`. Evidence is source inspection unless stated
> otherwise; this phase executed no tests. Claims marked **(source)** are
> inferred from reading the code path and have not been reproduced.

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

1. **Spill, don't refuse.** At ingress, EventStore moves large values (a string
   or a whole subtree) out of the event into a new table,
   `orchestration_event_content`, in `orchestration.sqlite`. The event keeps a
   typed reference with a short preview in the value's place.
2. **Same lifetime, same transaction.** Content rows are keyed by
   `(thread_id, digest)`, written in the append's savepoint, deleted by
   `deleteThread` in its transaction, and copied by every backup that copies
   `orchestration.sqlite`.
3. **Full reads resolve at the row mapper.** The reads that already owe their
   caller the complete event (`mapEventRow(row, hydrate = true)`,
   `event-store.ts:4028-4058`) resolve references the same way they hydrate
   attachments today. Bounded reads (windows, SSE replay, event pages) keep
   references. This makes most server readers correct with no change.
4. **Split deltas instead of spilling them.** A text or reasoning delta is a
   fragment by definition. Splitting one oversized delta into ordered chunks
   with deterministic event ids loses nothing and keeps every delta
   concatenator unchanged. Spill remains the fallback.
5. **Approvals load whole before Approve is enabled**, and the server refuses
   an accept that does not name the digest of the full request the client
   loaded.
6. **Remove #4118's Codex refusal.**
7. **Residual refusal declines, it does not stop the stream.** An event that is
   still unstorable after spilling (over an absolute ceiling, or hostile shape)
   is handled per event: a request is declined to the engine with an honest
   warning; other events persist with an `unavailable` reference.

The direction asked whether the attachment blob store should hold this
content. It should not; see the next section.

## Storage

### Chosen: a thread-scoped table in `orchestration.sqlite`

```sql
-- src-server/domain/migrations/024-event-content.ts
CREATE TABLE IF NOT EXISTS orchestration_event_content (
  thread_id   TEXT NOT NULL,
  digest      TEXT NOT NULL,   -- 'sha256-' + hex of the UTF-8 body
  kind        TEXT NOT NULL CHECK (kind IN ('string', 'json')),
  body        TEXT NOT NULL,   -- the string itself, or compact JSON of the subtree
  bytes       INTEGER NOT NULL,
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
  `event-store.ts:4246`). A rolled-back append leaves no content, so no orphan
  sweep is needed. A file store cannot give that: attachment blobs are
  written before the append and rely on retention to reclaim orphans
  ("server-only blob writes, unreferenced if the append fails and bounded by
  retention", `orchestration-service.ts:12627-12630`).
- **Backup and move.** `STATION_HOME_SQLITE_STORES` lists
  `data/orchestration.sqlite` (`packages/shared/src/station-home-store-registry.ts:266`),
  so home archives and cloud moves carry content with its events.
- **SQL readers can join it.** Several readers use `json_extract` in SQL,
  including the transcript-search worker on its own connection. A table lets
  them resolve with a plain `LEFT JOIN`, with no registered function.
- **Determinism.** The digest is computed from the value, so the same event
  spills to the same bytes. The exact-replay check in `appendIngressedEvent`
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
  /** Discriminant. A key no engine schema uses; see "Forged references". */
  readonly $stationContent: 1;
  readonly ref: `sha256-${string}`;
  readonly kind: 'string' | 'json';
  /** UTF-8 bytes of the full value (the string, or its compact JSON). */
  readonly bytes: number;
  /** For strings, UTF-16 length of the full value. */
  readonly length?: number;
  /** For json: 'array' | 'object' and its item or key count. */
  readonly shape?: { readonly type: 'array' | 'object'; readonly size: number };
  /** At most 512 UTF-16 units: a string head, or a compact-JSON head. Never the full value. */
  readonly preview: string;
}

/** A value over the absolute ceiling, or a shape that cannot be stored. */
export interface RuntimeEventContentUnavailable {
  readonly $stationContent: 1;
  readonly unavailable: 'exceeds-ceiling' | 'unstorable-shape';
  readonly bytes?: number;
}
```

The envelope gains one computed field:

```ts
// CanonicalRuntimeEventBase (packages/contracts/src/runtime-events.ts:289)
/** Set by EventStore when any value was spilled. Never accepted from a producer. */
spilledContent?: { readonly count: number; readonly bytes: number };
```

Why an object in place, rather than a preview string in place or a side map
of JSON pointers:

- **A preview string in place** is silently taken as the whole value by every
  reader that checks `typeof x === 'string'` or `json_type(...) = 'text'`. That
  includes the reply reconciliation in the projection, the review executor's
  `JSON.parse(outputText)`, search indexing and the user-input SQL function.
  It is the "mistake a preview for full content" failure the direction rules
  out.
- **A side map with the field removed** makes unaware readers believe the
  value was absent. An approval with no arguments looks like an approval of
  nothing.
- **An object in place fails closed.** A string-typed reader sees a non-string
  and drops, skips or reports corrupt. A display reader shows a visible
  reference, not a plausible but wrong value. The readers listed below are
  changed to recognise the reference before they ship.

In contracts, fields that hold engine content become explicit unions so the
compiler finds every reader. Examples: `TurnCompletedEvent.outputText?:
string | RuntimeEventContentRef` (`runtime-events.ts:443`), `prompt`, the
delta (only as a fallback, see below), `tool.started.arguments`,
`tool.completed.output`/`error`, `plan.updated.entries`. Fields already typed
`unknown` (`request.opened.payload` subtrees, `extension.notification.payload`)
can hold a reference at any depth.

The module exports pure helpers over its own shapes, as
[packages/contracts/AGENTS.md](../../packages/contracts/AGENTS.md) allows:
`isRuntimeEventContentRef`, `collectRuntimeEventContentRefs(event)` and
`resolveRuntimeEventContent(event, lookup)`, where the caller supplies the
lookup. They have no I/O.

`RuntimeEventElisionReason` (`packages/contracts/src/orchestration.ts:1349`)
stays as it is: it describes what one bounded read withheld. A spilled value
is not withheld; it can always be resolved.

### Forged references

Engine data can contain an object that looks like a reference. Ingress
handles it the way #2483 handles foreign attachment refs:

- An inbound `$stationContent` object is accepted as a reference only when it
  is this event's own reference coming back. The live path projects the event
  and then appends the projected form; the append carries the spill plan in
  hand (see [Ingress](#ingress-algorithm)). Its preview, `bytes` and `shape`
  are recomputed from the stored body; inbound values are not trusted.
- Any other `$stationContent` object is engine data. It is spilled as a `json`
  value, so it round-trips as the literal object it was. Nothing is refused,
  and a forged digest cannot pull another value from the thread into view.

## Spill policy

### Targets

| Name | Value | Why |
| --- | --- | --- |
| `EVENT_STORED_TARGET_BYTES` | 16 KiB | Every stored event stays whole under the window per-event ceiling (`SNAPSHOT_EVENT_MAX_SERIALIZED_BYTES` 24,576, `event-store.ts:1579`) with room for the fields `snapshotEvent` adds. It also fits the SSE replay budget (96,000 bytes, `src-server/constants.ts:20`). |
| `SPILL_MIN_VALUE_BYTES` | 1 KiB | Values smaller than this are never spilled. A reference with preview costs about 600 bytes. |
| Stored-form structure | depth ≤ 24, ≤ 256 keys or items per container | Below the backstop's 32 / 512, so the backstop never fires on a spilled event. |
| `MAX_EVENT_CONTENT_BYTES` (absolute) | 16 MiB per event, raw | The bound for engine-sized content. See [Open questions](#open-questions-for-the-owner). |
| Raw structure (absolute) | depth ≤ 256; ≤ 200,000 values | Keeps the recursive walk stack-safe and bounded. |
| `MAX_EVENT_STORE_INGRESS_BYTES` | 64 KiB, unchanged | Now the backstop on the stored form only. |

### What gets spilled first

The planner is deterministic, so replay is idempotent:

1. **Never spilled:** envelope and identity fields (`eventId`, `threadId`,
   `turnId`, `method`, `provider`, `createdAt`, `requestId`, `requestType`,
   `toolCallId`, `toolName`, `itemId`, `status`, `blocking`, `purpose`,
   `title`) and every Station-stamped field (`htmlReply`,
   `mcpAppResourceUri`, `stationControlRefusal`, `attachments`,
   `outputReceipt`, `usage`). These are adapter-built. If they alone exceed
   the backstop, that is the residual case.
2. **Structure first:** any container over 256 entries, or reaching depth 24,
   is spilled whole as `json`, starting from the outermost violating
   container.
3. **Then size:** while the stored form exceeds 16 KiB, spill the largest
   remaining spillable value (a string ≥ 1 KiB, or a subtree ≥ 1 KiB). Ties
   are broken by JSON path order.

Largest-first keeps small sibling fields inline. That matters for
safety-relevant leaves: `toolInput.dangerouslyDisableSandbox`, read by
`toolRequestEscalates` (`packages/shared/src/tool-request-preview.ts:536`),
and `tool.started.arguments.path`, read by `readTurnDigestFacts`
(`event-store.ts:5574`). A `Write` with a 1 MB `content` spills `content`
alone. Server-side grant derivation still resolves (see below); it does not
rely on that.

### Deltas: split, not spill

Before the coalescer's `offer` (`delta-coalescer.ts`), `consumeAdapterEvents`
splits a `content.text-delta` or `content.reasoning-delta` whose text exceeds
16 KiB into UTF-8-safe chunks. It reuses `utf8Chunks`
(`src-server/providers/tool-output-projection.ts:170`), which the session
sources already use at 16 KiB (`MAX_TEXT_CHUNK_BYTES`, e.g.
`codex-rollout-session-source.ts:52`). The first chunk keeps the `eventId`;
chunk `k` gets `${eventId}:${k}`. Same `itemId`, so every concatenator
continues to work. These include the projection (`runtime-event-projection.ts:848`),
delegation output (`delegation-result-delivery.ts:1250`), task events
(`station-control-delegation.ts:4069`) and the UI live stream. The coalescer
cap (8,000 characters) already keeps merged deltas small. A delta that
reaches EventStore over the target by another route is spilled like anything
else.

Note: `child-work.updated` also has a `delta` field, a structured object read
by `readAnswerInventoryLineage` (`event-store.ts:3172-3183`). The split is
keyed on method, never on field name.

## Ingress algorithm

`prepareEventIngress` (`event-store.ts:3826`) becomes three steps:

1. **Raw projection.** The existing descriptor-only walk, so getters, proxies
   and cycles are still never invoked or followed. It runs against the
   absolute ceilings instead of 64 KiB and produces the data-only copy it
   produces today.
2. **Spill planning.** On that copy: Station-owned field handling (the
   `tool.completed` stamps at `:3858-3880`), attachment projection
   (`persistedForm`, `:3488`), then the spill plan. The result is
   `{ payload, blobRefs, toolImageKey, spills: Array<{ digest, kind, body, bytes }> }`.
3. **Backstop.** The unchanged 64 KiB / 32 / 512 projector on the stored form.

The live path today calls `projectLiveEvent` (`event-store.ts:3916`) and then
`appendEvent(projectedEvent, …)` (`orchestration-service.ts:12636-12672`),
which re-projects the reference-only form. For spill, the append needs the
bodies. `appendCanonicalEvent` should pass the prepared ingress to
`appendEvent` instead of re-projecting. If a re-projection seam must stay, a
pending map keyed by `(threadId, eventId)` holds the plan, as the live
attachment refs do (`pendingToolImages`, `event-store.ts:3580-3615`). It is
bounded, and an aged-out entry makes its references resolve as unavailable.
Content rows are inserted in the append savepoint next to
`recordAttachmentRefs` (`event-store.ts:4246`, `:5082`).

Message search indexing (`projectMessageSearchEvent`, `event-store.ts:14462`,
called in the same savepoint) receives the pre-spill values from the
prepared ingress, so the full prompt and reply are indexed.

## Readers

Classification below. `R` means the reader resolves through the hydrating
row mapper and needs no code change beyond tests. `C` means it needs a
specific change. `P` means a preview or reference is the intended form.

### Resolution seam

Rename `hydrateAttachments` (`event-store.ts:4004`) to a general `hydrate`
that also resolves content references. It does one batched
`SELECT … WHERE thread_id = ? AND digest IN (…)` per page of rows; that
follows the [server batching rule](../../src-server/AGENTS.md). Today's full
reads keep their meaning, "owes the caller the complete event":
`listEvents`, `listEventsForTurn`, `eventById`, the request reads,
`listTurnEventsByMethods`, and `listEventPayloads` without
`omitTranscriptBodies`. The three deliberate reference-keeping reads stay as
they are and keep references: `listEventWindowByTurn`,
`listEventsAfterGlobalSequence`, `listEventPage` (`event-store.ts:4028-4045`).

A reference whose row is missing (it should never be, by construction)
resolves to `RuntimeEventContentUnavailable`, never to the preview.

### Server readers that need exact content

| Reader | Reads | Class | How it resolves |
| --- | --- | --- | --- |
| `readCurrentRequestEvent` (`event-store.ts:6885`) | Whole `request.opened`; returns `oversized` over 64 KiB | R | The stored form is ≤16 KiB, so `oversized` stops firing for spilled requests; `mapEventRow` hydrates. |
| `respondToRequest` answer validation (`orchestration-service.ts:9163-9207`) | `inputRequestFromRequestEvent` → `validateInputRequestContent` | R | Via `readCurrentRequestEvent`. Plus the new accept-digest check (see [Approvals](#approvals-and-tool-details-in-the-ui)). |
| `isEditModeSessionAnswer` (`orchestration-service.ts:11307-11335`) | `toolRequestSessionGrantFromPayload` | R | Via the request read. |
| Approval inbox live listener (`src-server/services/approvals/approval-inbox.ts:440-533`) | Grant derivation, tool name, form detection from the **bus** event | C | Read the request through `readCurrentRequestEvent` when `spilledContent` is set, instead of deriving grants from preview data. |
| `readCurrentInputRequest` (`request-inspection.ts:154-183`) → `GET /sessions/:threadId/input-requests/:requestId` (`routes/orchestration/orchestration.ts:2319`) | Full form for clients | R | Hydrated. The response bound must allow full forms (see open questions). |
| `inspectRequestEvent` / `presentOpenRequest` (`request-inspection.ts:55-130`, `request-presentation.ts:31-190`) | Bounded title and body | R/P | Already bounded display; it receives the hydrated event. |
| Delegation output `storedTurnOutput` (`delegation-result-delivery.ts:1250-1288`) | `turn.completed.outputText`, else deltas | R | `listTurnEventsByMethods` hydrates. |
| `get_task_events` `projectDelegatedTaskEvent` (`src-server/tools/station-control-delegation.ts:4069`) | Delta and `outputText`, capped at 8,192 | C | Local source is `listEventPage` (references). Call `GET …/content/:ref?maxChars=8192`, or a store prefix read, and keep its `truncated` flag honest. Remote Stations (`:4357`, `:4577`) use the same route. |
| Review executor `#waitForOutput` (`src-server/services/evidence/orchestration-review-executor.ts:183-230`) | `JSON.parse(outputText)` | C | Its source is `readSessionEventPage` (references). Switch it to a hydrating turn read, or resolve the reference. With a preview it would return `output: null`. |
| Message search indexing (`event-store.ts:14462`) and backfill (`:14356`) | `prompt`, `outputText` | C | Indexing uses the pre-spill values (above). Backfill joins the content table. |
| Transcript message page (`src-server/services/orchestration/transcript-search-queries.ts:285`, worker connection) | `json_extract($.prompt | $.outputText)` | C | `LEFT JOIN orchestration_event_content c ON c.thread_id = e.thread_id AND c.digest = json_extract(e.payload, '$.outputText.ref')`, then `COALESCE`. |
| `turnPromptsContaining` (`event-store.ts:6633`) → reference grants (`routes/chat/conversation-reference-read.ts:604-633`) | `instr($.prompt, needle)` | C | Same join. A preview would miss a reference past 512 characters (fails closed, but it changes behavior). |
| User-input SQL function and descriptors (`event-store.ts:798-846`) → `userInputEventById` (`:8562`) → Task input pinning | `$.prompt` type, length, value | C | Same join, so the type check sees text. |
| `toolCompletedEventById` → `readToolResult` (`event-store.ts:8591`) | `$.output`, `$.error` under the descriptor limit | C | Same join. The existing `*_over_limit` path stays for values above the Thread descriptor limit. |
| `listBasisEventsForTurn` → `readAnswerBasis` (`event-store.ts:6248`) | `outputText`/`delta` lengths; `prompt`, `output` values; `json_type` corruption checks | C | Join for values. Length checks read `bytes` from the reference. Teach the corruption checks that a reference object is valid. |
| `readTurnDigestFacts` (`event-store.ts:5574`) | `substr($.prompt,1,1024)`, `arguments.path` | C | Join for `prompt`. `path` stays inline by spill order; a spilled `arguments` subtree falls back to the join. |
| Recovery re-dispatch (`session-recovery-coordinator.ts:490`, `replayableSource`) | `turn.started.prompt`, `ambientContext` | R | `eventById` hydrates. It must, because it re-sends the prompt to the engine. |
| Transcript projection `projectRuntimeEventsToMessages` (`packages/shared/src/runtime-event-projection.ts:247`) | Delta, `outputText` reconciliation (`:1353-1387`), tool `arguments`/`output` | R on the server, C in the UI | Server callers (`session-transcript-reads.ts:118`, `session-query-module.ts:507,556`, `readAssistantTurn`) hydrate. In the UI the projection must treat a reference `outputText` as "not known": keep the deltas and never replace `textBuf` with a preview. |
| Conversation read and export (`conversation-message-reader.ts:215`, `routes/chat/conversations.ts:2034`), `read_conversation` (`station-control-agent-tools.ts:189,209`) | Messages | R | `listEventPayloads` hydrates. |
| Conversation fork (`routes/chat/conversations.ts:840-1125`) | Bounded window via `readCompleteForkConversationWindow` | C | Hydrate the window rows it renders. Today's silent drop of a large `turn.completed` also goes away because the stored form fits. |
| Handoff, native return, context-boundary seeds (`conversation-lineage.ts:272-1503`), native memory companion (`orchestration-service.ts:13545`), answer share (`answer-share-service.ts:493`), room publication (`project-room-agent-runtime.ts:179`, `task-room-conversation-module.ts:359`), Discord (`station-runtime.ts:1496`), intent summary (`conversation-intent-summary-source.ts:118`) | Messages and turn text | R | All go through `readSessionMessages` / `readAssistantTurn`, which hydrate. |
| `flow-policy-sidecar.ts:728-863` | Raw adapter event before projection | Unaffected | It sees the raw event (`orchestration-service.ts:10762`). |
| Monitoring bridge (`orchestration-monitoring-bridge.ts:237`) | `outputText.length` | C (small) | Use the reference's `length`. |
| `snapshotEvent` (`event-store.ts:1854`) | Full `tool.completed.output` for `htmlReplyReference`, `parseStationControlRefusal`, `isSuccessfulMcpResult` | P | These outputs are small and stay inline under largest-first. Better: derive them at ingress from the pre-spill value and store them as stamps, so window reads never depend on spill order. |

No server code was found that copies runtime-event payloads between threads
or Stations for session tape, offline outbox, hosted sync or thread transfer
**(source search)**. The outbox tables carry operational events and room
publications, not runtime events. Fork writes only a provenance marker
(`conversation-lineage.ts:1214`) and renders a transcript seed. Any future
cross-thread copy must resolve, then re-ingest, so content is re-stored under
the target thread.

### Bus emitters must emit the persisted form

Live SSE frames are the bus event (`routes/orchestration/orchestration.ts:6502`
onward; replay serializes `persisted.payload`). Three emitters exist:

- `OrchestrationService` emits the projected event
  (`orchestration-service.ts:12583`, from `projectLiveEvent` at `:12638`).
  Correct.
- The attached-session follow service emits the **raw** event after append
  (`attached-session-follow-service.ts:1262`). It must emit the persisted form.
- The platform-mutation gate emits the **raw** sanitized event
  (`src-server/runtime/bootstrap/runtime-initialize.ts:776-777`). Same fix.

`appendEvent` and `appendEventIfAbsent*` should return the persisted payload
so these callers cannot emit a different shape. A route test asserts frame
size and reference presence for each emitter.

## Live delivery, windows and replay

- **Live SSE** carries the stored form. It is ≤16 KiB per event, carries
  references, and is identical to what a reload returns.
- **Window reads** (`SNAPSHOT_EVENT_MAX_SERIALIZED_BYTES` 24,576,
  `TURN_COMPLETED_SNAPSHOT_MAX_BYTES` 48,000, page 56,000, response
  `SESSION_EVENT_WINDOW_MAX_RESPONSE_BYTES` 64,000, `event-store.ts:1579-1588`)
  stop producing `byte_limit` for new events. The reload gap for 24-64 KiB
  approvals closes. `output_limit` (the 84-character tool output excerpt)
  stays as it is.
- **SSE replay** (`listEventsAfterGlobalSequence`) budgets by stored length and
  is unchanged.
- **Offline/outbox replay**: the client outbox
  ([offline-outbound-queue.md](offline-outbound-queue.md)) queues outbound
  user turns, which are bounded by the composer. It does not replay runtime
  events. A queued 200,000-character prompt is spilled at ingress like any
  other.
- **Remote Stations** (delegation peers) receive references from event pages
  and resolve through the remote content route with the credential they
  already use.

## Approvals and tool details in the UI

### New read route

`GET /api/orchestration/sessions/:threadId/content/:ref` returns
`{ ref, kind, bytes, value }`. With `?maxChars=N` it instead returns
`{ ref, kind, bytes, length, prefix, complete: false }`, for bounded consumers.

- Authorization is the same session-read check as other
  `/sessions/:threadId/*` reads. Lookup is by `(threadId, digest)`, so a valid
  digest from another thread returns 404.
- It is gated by a new capability flag, `runtimeEventContent`, in
  `src-server/capabilities/station-capability-flags.ts`, with its row in
  `consumed-capability-flags.test.ts`, per
  [src-server/AGENTS.md](../../src-server/AGENTS.md).
- Responses are immutable, so the SDK query hook (`useRuntimeEventContent`)
  caches by `(threadId, ref)` with infinite stale time.

### Approval card

Where approvals appear:

- the tool-row controls (`ToolApprovalControls`,
  `src-ui/src/components/chat/ToolCallDisplay.tsx:734`;
  `ToolApprovalButtons` `:863`),
- `PendingApprovalStrip` (`src-ui/src/components/chat/PendingApprovalStrip.tsx:93`,
  rows from `unansweredApprovalRequests`, `pendingRequestRows.ts:111`),
- the toast (`raiseRequestOpenedToast`,
  `src-ui/src/hooks/orchestration/approvalHandlers.ts:126`), which today
  offers one-click Allow over a 160-character preview.

Behavior when the request, or the tool row it binds to, contains references:

1. The card renders previews at once, labelled "Loading full request…", and
   starts fetching every reference in `request.opened.payload`. When the card
   shows arguments from the bound `tool.started` (the projection binds by
   `toolCallId`, `runtime-event-projection.ts:1176`), it fetches those
   references too, or it renders the request's own arguments, which are
   authoritative.
2. **Allow, Allow for session and the server grant stay disabled until every
   reference has resolved.** Deny is always enabled; declining needs no
   content.
3. On error: an `ErrorState` with a retry action. Approve stays disabled.
4. Once loaded, the arguments render whole in `ToolCallDetails` (`:905`), a
   scrollable block with no head/tail cut. The current "Show full result"
   (`:1037`) is client-side only and fetches nothing.
5. **Toast and push notification:** for a spilled request they offer "Review"
   (navigate to the card) and Deny, not Allow. Approval-inbox notification
   actions follow the same rule.

### Server-side guarantee

UI gating alone does not cover the CLI (`packages/cli/src/commands/approvals.ts:199,499`),
MCP agents answering requests, or an older client. For a request with
`spilledContent`, `respondToRequest` rejects `accept`, `acceptForSession` and
the server grant unless the answer carries `viewedContentDigest`: a digest
over the resolved request payload, which the client computes after loading
it. A missing or wrong digest gets 409 "load the full request first". Decline
and cancel never need it. An older client fails safe: it can deny, and gets a
clear error if it tries to approve. Requests that never spilled are unchanged.

### Other tool details

`tool.started.arguments`, `tool.completed.output`/`error`, `plan.updated`
entries and extension payloads render the preview, with "Load full content"
(an explicit action, not automatic) in the existing details disclosure. The
"Output truncated" badge (`ToolCallDisplay.tsx`, from `outputReceipt`) stays
reserved for producer-side truncation (`ToolOutputReceipt`, whose output is
`fullOutput: 'unavailable'`). A spilled value is shown as available on
request, not as truncated.

## Residual refusal

After spilling, an event can still be refused only in two cases: content over
`MAX_EVENT_CONTENT_BYTES` or the raw structural ceiling, or a hostile or
non-JSON shape (accessor, cycle, bigint, Proxy). Adapter-built fields over
the backstop on their own are a Station bug. They are logged as an error with
the method and thread, and handled like the second case.

`publishObservedEvent` catches `EventStoreIngressError` per event, so the
adapter stream keeps running and is no longer restarted:

| Event | Behavior |
| --- | --- |
| `request.opened` | Call `adapter.respondToRequest(threadId, requestId, 'decline', { declineReason })` (`src-server/providers/adapter-shape.ts:483`; `declineReason` is a new optional field the adapters forward to the engine). Publish `runtime.warning` with code `request-too-large-to-show`, naming the size and the reason, so the person knows the agent was told. Nothing invisible stays pending. |
| Other methods, value over the ceiling | Persist the event with that value replaced by `RuntimeEventContentUnavailable`, so the turn terminal or tool completion is not lost. Publish a `runtime.warning`. |
| Other methods, unstorable shape | As today in the follow service: log with identity, publish a warning, skip. The stream continues. |

The follow service keeps its skip-and-advance rule
(`attached-session-follow-service.ts:1277`), and gains the same substitution
for over-ceiling values.

## Removing #4118

Delete the `fitsStructure` / 48 KiB block in `codex-adapter-transport.ts:932-965`
and its `codex-approval-request-too-large` warning. The pending approval is
registered before publish as it is today for in-bound requests. Update:

- `src-server/providers/__tests__/codex-approval-delivery.test.ts`: the refusal
  case becomes a delivery case, with a 38 KB `html_preview` and a 1 MB
  `fileChange`.
- `docs/reference/session-api.md:563-566`: replace the refusal text with the
  load-before-approve behavior.

Removal ships in the same change as the approval gate and the residual
decline, never before.

## Retention, deletion and migration

- **Deletion.** `deleteThread` deletes content rows in its transaction.
  Nothing else deletes events.
- **No orphans** by construction: rows are written in the append savepoint.
  A thread-scoped audit query (references with no row, rows with no
  reference) is a diagnostic, not a sweep.
- **Size.** Spilled bytes are counted on a new metric beside
  `attachmentBytesStripped`. No per-thread quota at first; see open questions.
- **Migration.** `024-event-content.ts` creates the table and index with
  `CREATE TABLE IF NOT EXISTS`. Existing rows are untouched and contain no
  references. Every resolver treats "no reference" as "value inline", the
  same "a read that handles both" rule the attachment change used
  (`event-store.ts:4000-4007`). There is no backfill. Pre-change events that
  were refused are gone and are not recovered.
- **Downgrade.** An older Station reading a newer database sees reference
  objects. The fields fail closed, but the content is not lost. This is noted
  for release notes, not designed around.

## Tests that will prove it

Each test runs at the named seam, and fault injection follows the repository
rule: commit, confirm a clean tree, inject, see red with the expected failure
text, restore.

1. **EventStore ingress** (`event-store` tests):
   - `request.opened` with a 1 MB `toolInput.content`, a 2,000-item array and
     a depth-40 object appends.
   - The stored row is ≤16 KiB; `dangerouslyDisableSandbox` and `path` stay
     inline.
   - `readCurrentRequestEvent` returns a value deep-equal to the input.
   - Inject: disable the planner → `EventStoreIngressError`.
2. **Replay idempotency.** Appending the same event twice is a replay, not a
   conflict. Inject: non-deterministic tie order → the declared-output replay
   check throws.
3. **Deletion.** `deleteThread` leaves zero content rows for the thread and
   leaves another thread's identical digest intact. Inject: remove the
   `DELETE` → red.
4. **Forgery and isolation.**
   - A `$stationContent` object in engine data round-trips literally.
   - A thread-B digest named in thread A resolves to unavailable, and the
     route returns 404.
5. **Live path** (`orchestration-service` with a fake adapter, through the
   `/events` route):
   - A 1 MB request produces a frame ≤16 KiB containing references.
   - The content route returns the full value.
   - Accept without `viewedContentDigest` gets 409; with it, the answer
     reaches the adapter.
   - Inject: emit the raw event on the bus → frame-size assertion fails.
   - Repeat for the follow service and the platform-mutation emitter.
6. **Wedge regressions per adapter, at the adapter seam:**
   - Claude `canUseTool` with a 1 MB `Write`.
   - ACP permission with a large `rawInput`.
   - station-agent `toolArgs`.
   - Codex 38 KB `html_preview` and 1 MB `fileChange`, now delivered.
   - Each request is visible and answerable.
7. **`turn.completed` with 300 KB `outputText`:**
   - The terminal persists.
   - `readAssistantTurn` text is exact.
   - Delegation result and review executor `JSON.parse` succeed.
   - A search hit at offset 200,000 is found.
   - The transcript-search worker page is exact.
8. **Reload.** The window read of a 40 KB approval keeps `requestId` (no
   `byte_limit`). The strip can still answer after reload. This catches the
   existing gap.
9. **SQL readers.** `turnPromptsContaining` finds a needle past the preview;
   `userInputEventById` and `readToolResult` return exact values.
   Inject: drop the join → red.
10. **Delta split.** A 100 KB delta becomes ordered chunks with
    deterministic ids, and a retried delivery stores no text twice (#3560
    semantics).
11. **Residual.**
    - A 20 MB `request.opened` produces `respondToRequest(…, 'decline')` and
      a warning.
    - The next event on the same adapter is delivered and the stream is not
      restarted (assert no `adapter-event-stream-interrupted`).
12. **UI.**
    - Approval card: Allow is disabled while the content query is pending or
      failed, and enabled after success. Deny is always enabled.
    - The toast offers Review, not Allow.
    - Renders at 390 and 1440 in both themes, opened as PNGs.
13. **Migration.** A database fixture written by the current schema opens,
    reads unchanged, and accepts spilled appends.

## Open questions for the owner

1. **Absolute ceiling.** Is 16 MiB per event the right bound for engine
   content? A larger value, such as a full binary diff, is then declined (for
   requests) or marked unavailable.
2. **Per-thread quota.** HTML reply pages cap at 32 MiB per conversation. Should
   spilled content have a quota? A quota reintroduces refusal; this note
   proposes none, with metrics first.
3. **Accept digest.** Is it acceptable that the CLI, MCP agents and push
   notifications cannot one-click approve a spilled request (they must load
   it first)? This is the server-side form of "can't approve what you can't
   see".
4. **Delta split vs. spill.** Splitting changes event counts and creates
   derived ids `${eventId}:k`. The alternative is uniform spill, which makes
   the live answer stream show previews until fetched. This note recommends
   splitting.
5. **Hosted mode.** `GET …/tool-results/:eventId` is disabled when hosted
   (`orchestration.ts:5798`). The content route must stay enabled there,
   because approvals depend on it. Confirm that no hosted-isolation reason
   applies.
6. **Mixed versions.** A native shell whose bundled UI is older than its host
   renders reference objects as JSON. The accept-digest check keeps it from
   approving blind, but its transcript shows references. Should the host
   withhold `runtimeEventContent` events from clients that do not advertise
   support, or is the visible reference acceptable?
7. **Should `title` and `description` on `request.opened` be spillable?**
   Adapters already cap them (`MAX_CLAUDE_REQUEST_TEXT_LENGTH` 1,000,
   `claude-adapter-events.ts:1741`). This note treats them as adapter-built and
   never spilled.
