---
status: current
subject: The event store may delete superseded tool.progress rows of settled calls; every other row stays append-only
decided: 2026-11-17
evidence:
  - kind: adr
    ref: docs/adr/0013-bind-agent-extensions-to-the-declared-mechanism-not-method-names.md
  - kind: adr
    ref: docs/adr/0012-decorate-session-summaries-with-read-time-answerability.md
  - kind: doc
    ref: src-server/domain/migrations/003-orchestration-events.ts
  - kind: doc
    ref: src-server/services/orchestration/tool-progress-compaction.ts
  - kind: doc
    ref: src-server/services/orchestration/event-store.ts
  - kind: doc
    ref: src-server/runtime/bootstrap/tool-progress-compaction-schedule.ts
  - kind: doc
    ref: src-server/services/orchestration/__tests__/tool-progress-compaction.test.ts
  - kind: doc
    ref: src-server/runtime/bootstrap/__tests__/tool-progress-compaction-schedule.test.ts
  - kind: doc
    ref: packages/shared/src/runtime-event-projection.ts
---

# Tool progress compaction

Station's orchestration event log (`orchestration_events`) was append-only:
nothing removed a row except deleting the whole thread. This record allows one
exception. Station may delete a `tool.progress` row that a later progress row
of the same finished tool call replaced, once the turn is settled and old.
Every other row, including every content delta, stays as it was written.

The reader inventory and the choice of `tool.progress` over deltas are in
[#4995](https://github.com/kontourai/station/issues/4995#issuecomment-6922877877) ("Decision:
compact tool.progress only"). Deltas are sometimes the only copy of an answer
and the only record of reasoning, so they are never compacted. The work is
tracked in [#5078](https://github.com/kontourai/station/issues/5078).

## What this amends

- [ADR 0013](../adr/0013-bind-agent-extensions-to-the-declared-mechanism-not-method-names.md)
  says the event store "is append-only and replay-pure". It now is, except for
  the rows this record lets compaction delete.
- [ADR 0012](../adr/0012-decorate-session-summaries-with-read-time-answerability.md)
  relies on the event log staying pure and replay-reproducible for
  `projectSessionLifecycle`. That fold reads no `tool.progress` row
  (`PROJECTION_FOLD_METHODS` in `event-store.ts`), so its result is unchanged.
- [Migration 003](../../src-server/domain/migrations/003-orchestration-events.ts)
  says the canonical event log "remains byte-for-byte provider output". Every
  row that remains still is; the log no longer holds every row a provider
  emitted.

The numbered ADRs are frozen, so they are not edited.

## Which rows go

[`tool-progress-compaction.ts`](../../src-server/services/orchestration/tool-progress-compaction.ts)
selects a row only when all of these hold:

1. **The thread is Station-owned:** `control_mode = 'station-owned'` and no
   `attached_source`.
2. **The turn is settled:** it has `turn.completed` or `turn.aborted`.
3. **The turn is old:** every row of the turn is older than the cutoff, both
   by provider time (`created_at`) and by Station receipt time (`observed_at`,
   when recorded). A timestamp SQLite cannot parse counts as recent. The
   cutoff defaults to 30 days and is set by
   `STATION_TOOL_PROGRESS_COMPACTION_MIN_AGE_DAYS` (1 to 3650).
4. **The call finished:** the same `(turn, toolCallId)` has a `tool.completed`
   after the row.
5. **The row was replaced:** a later `tool.progress` row of the same call in
   the same turn supersedes it, and nothing between the two could move the
   call's transcript slot. Only other progress rows, content deltas, usage
   updates, and starts or completions of *other* calls may lie between them.
   So the last progress row of every call is kept.
6. **The row carries no `outputReceipt`.** A truncated-output receipt sets the
   projected tool part's `outputTruncated`, so a receipt row is kept.
7. **No side table names the row:** declared outputs and their handles,
   session projection facts, request state and work-item associations.
8. **It is not the thread's head:** neither its `MAX(sequence)` nor its
   `MAX(global_sequence)` row. The next append's sequence is
   `MAX(sequence) + 1`, and the per-thread cache is keyed by
   `MAX(global_sequence)`. Rule 5 already implies this; the guard stays.

Why these keep the transcript identical: `projectRuntimeEventsToMessages`
([projection](../../packages/shared/src/runtime-event-projection.ts)) reads a
progress row only while its call is open, and only to set the part's
`progressMessage` (last write wins) and `outputTruncated` (sticky). Rule 5
guarantees a later row of the same call overwrote the deleted row's message
on the same part; rule 6 keeps every sticky flag.

## Attached threads are excluded, not tombstoned

A read-only attached thread is filled by an importer that replays a window of
the source transcript after each restart and skips event ids already stored
(`existingEventIds`, then `appendEventIfAbsent`). A deleted id would look
new and be appended again. Station could record tombstones for deleted ids
and teach both checks about them, but that puts a second lookup on every
import append. Excluding the threads costs nothing measurable: on the measured
home every attached-thread call has exactly one progress row, so none is ever
superseded (see [Measurements](#measurements)). Revisit if an importer starts
emitting several progress rows per call.

Station-owned threads mint each event id once. The retry and recovery paths
that probe `hasEventId` work on turns that are still running, which rule 2
excludes.

## Spilled content

A progress row's `output` can be stored out of line in
`orchestration_event_content`, keyed by thread and digest and shared by every
row of the thread with the same value. After deleting rows, compaction deletes
a content row only when no remaining event and no turn provenance envelope of
the thread contains its digest. The check is textual, so a payload that merely
quotes a digest keeps its body: the error is toward keeping bytes, never
toward a reference whose body is gone.

## Transactions, caches and scheduling

- **Off the request path.** The runtime starts the schedule beside store
  integrity verification (`startHealthChecks`): first pass 10 minutes after
  start, then every 30 minutes, one pass at a time.
- **Small transactions.** EventStore selects one thread's candidates within
  one page of 500 index entries by reading row metadata (call ids are parsed
  from tool rows only), then deletes at most 200 rows in one `BEGIN IMMEDIATE`
  on that thread's background write queue (`writeInBackground`), which also
  serializes with attached-session writes. The delete re-checks the control
  mode, the head, side-table references and that the replacing row still
  exists. A pass deletes at most 5,000 rows and scans at most 40 pages, and
  yields between transactions and pages.
- **Caches.** Deleting rows below a thread's head does not move its
  `MAX(global_sequence)`, the key of the per-thread projection cache (#5001),
  so the same transaction drops that thread's cached projection and count and
  its cached unresolved-call set (`forgetThreadReadCaches`). The cache is per
  process; the runtime's EventStore is the only long-lived instance and runs
  the compaction.
- **Gaps.** Deleted rows leave gaps in a thread's `sequence`. `get_task_events`
  accepts them since #5077 (PR #5110): pages carry the thread's high water.

## File space: a bounded file, not a smaller one

Deleting rows does not shrink `orchestration.sqlite`. The store has no
`auto_vacuum`, and Station runs no `VACUUM`. That is deliberate: SQLite
reuses the freed pages for later appends, so the file stops growing until new
events outweigh what was freed. `VACUUM` rewrites the whole file (hundreds of
megabytes on a used home), needs about as much free disk again, and holds an
exclusive lock for the duration; enabling `auto_vacuum` on an existing
database also needs one. Neither belongs on a running Station or on the request
path. An operator who needs the space back can run `VACUUM` on a stopped
Station's database.

## Default: off, behind a Feature Preview

Compaction runs only while the `tool-progress-compaction`
[Feature Preview](../guides/feature-previews.md) is on (off by default), and
never while `STATION_TOOL_PROGRESS_COMPACTION=off` (or `0`) is set. Both are
read at every pass. Off is the default because deletion cannot be undone and
the measured gain is modest. Promote it after a dogfood home has run it
through at least one full cycle with the transcript, share and Basis checks
unchanged.

## Measurements

Read-only selection over the measured live home on 2026-11-17
(`orchestration.sqlite` 735 MB, no rows deleted):

| | Rows | Payload |
| --- | ---: | ---: |
| All `tool.progress` | 54,771 | 116.5 MB |
| In read-only attached threads (one progress row per call) | 16,126 | 80.2 MB |
| In Station-owned threads | 38,730 | 36.0 MB |
| Selectable with no age limit (28 threads) | 21,641 | 15.4 MB |
| Selectable with the 30-day default today | 0 | 0 |

So the reclaim on that home is about 15 MB once its rows age past the cutoff,
not the 109 MB #4995 counted for the whole method: most progress bytes are in
attached threads or are the last update of their call. Station-owned progress
rows without a turn id (8,219) are never selected. Selecting across the whole
table took 5.4 s in total; the slowest single thread-page selection took
143 ms, the longest the main thread is held by one step.

## Consequences

- The transcript projection, answer-share digests, `readAnswerBasis` for turns
  within its row budget, session projection facts and event counts read the
  same before and after a pass; tests at the EventStore and service seam check
  each one.
- Raw event reads (`readSessionEventPage`, `get_task_events`, exports) no
  longer list deleted rows. Remaining rows keep their sequences and the high
  water is unchanged, so cursors issued earlier still resume.
- A turn that exceeded Basis's 1,000-row descriptor budget only because of
  progress rows can become readable after compaction. No readable Basis
  changes.
- Bounded history windows count fewer rows, so they can reach further back.
- Metrics: `station.orchestration.tool_progress_compaction.passes`
  (`outcome`), `.rows` and `.bytes` (`table`: `events` or `content`) and
  `.duration` ([monitoring](../guides/monitoring.md#event-store-retention)).
