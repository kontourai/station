/**
 * Compaction of superseded `tool.progress` rows
 * (docs/decisions/tool-progress-compaction.md, #5078).
 *
 * This module owns only which rows may go and how they are removed with the
 * out-of-line content nothing else references. EventStore owns the
 * transaction, the per-thread write queue and the read caches it must
 * invalidate; the runtime schedule owns when a pass runs and its metrics.
 *
 * A row is deleted only when every one of these holds:
 *
 * - its thread is Station-owned (`control_mode = 'station-owned'`, no
 *   `attached_source`). Read-only attached threads are re-imported by event
 *   id, and a deleted id would be appended again;
 * - its turn has `turn.completed` or `turn.aborted`, and every row of the
 *   turn, by provider time and by Station receipt time, is older than the
 *   cutoff. A timestamp SQLite cannot parse counts as recent;
 * - the same `(turn, toolCallId)` has a `tool.completed` after the row;
 * - a later `tool.progress` of the same call in the same turn supersedes it,
 *   and nothing between the two can move the call's transcript slot: only
 *   other progress rows, content deltas, usage updates, and starts or
 *   completions of other calls lie between them. The transcript projection
 *   keeps only the last progress message of an open call, so the superseded
 *   row has no effect on it. The last progress row of every call is kept;
 * - the row carries no `outputReceipt` (a truncated-output receipt sets the
 *   projected part's `outputTruncated`), and no side table names its id;
 * - it is not the thread's `MAX(sequence)` or `MAX(global_sequence)` row:
 *   the next append's sequence and the per-thread cache key derive from them.
 *   Supersession already implies this; the guard is kept anyway.
 *
 * Selection reads only row metadata (the call id is parsed from tool rows
 * alone) before the write transaction opens. Rows of a settled turn never
 * change, and a later append lands after every one of them, so the
 * transaction re-checks only what can still move: the thread's control mode,
 * its head, side-table references and that the superseding row still exists.
 */
import { collectRuntimeEventContentRefs } from '@kontourai/station-contracts/runtime-event-content';

/** EventStore's connection, narrowed to what compaction uses. */
interface CompactionDatabase {
  prepare(sql: string): {
    all(...args: unknown[]): unknown[];
    get(...args: unknown[]): unknown;
    run(...args: unknown[]): unknown;
  };
}

/** What one transaction (or one pass, summed) removed. */
export interface ToolProgressCompactionTotals {
  rowsDeleted: number;
  payloadBytes: number;
  contentRowsDeleted: number;
  contentBytes: number;
}

/** One `tool.progress` index entry: its rowid and thread. */
interface ToolProgressScanRow {
  rowId: number;
  threadId: string;
}

/** A superseded row and the later progress row of its call that replaced it. */
interface SupersededProgress {
  id: string;
  supersededBy: string;
}

interface PageRow {
  id: string;
  sequence: number;
  turnId: string;
  callId: string | null;
  receipt: number;
}

interface TimelineRow {
  id: string;
  sequence: number;
  turnId: string | null;
  method: string;
  callId: string | null;
}

/** Methods that cannot move another call's transcript slot. */
const TRANSPARENT_METHODS: ReadonlySet<string> = new Set([
  'tool.progress',
  'content.text-delta',
  'content.reasoning-delta',
  'token-usage.updated',
]);

/** No side table names the row `:id` of thread `:thread`. */
const UNREFERENCED = `NOT EXISTS (SELECT 1 FROM orchestration_declared_outputs WHERE event_id = :id)
  AND NOT EXISTS (SELECT 1 FROM orchestration_declared_output_handle_uses WHERE event_id = :id)
  AND NOT EXISTS (SELECT 1 FROM orchestration_session_projection_facts
                   WHERE thread_id = :thread AND event_id = :id)
  AND NOT EXISTS (SELECT 1 FROM orchestration_request_state
                   WHERE thread_id = :thread AND event_id = :id)
  AND NOT EXISTS (SELECT 1 FROM orchestration_session_work_item_associations
                   WHERE session_id = :thread AND event_id = :id)`;

const STATION_OWNED_SQL = `SELECT 1 FROM provider_session_state
  WHERE thread_id = ? AND control_mode = 'station-owned' AND attached_source IS NULL`;

/**
 * Up to `limit` `tool.progress` index entries after `afterRowId`, in rowid
 * order. Reads the method index only, never a payload.
 */
export function scanToolProgressRows(
  db: CompactionDatabase,
  afterRowId: number,
  limit: number,
): ToolProgressScanRow[] {
  return (
    db
      .prepare(
        `SELECT rowid AS rowId, thread_id AS threadId
           FROM orchestration_events INDEXED BY idx_events_method
          WHERE method = 'tool.progress' AND rowid > ?
          ORDER BY rowid
          LIMIT ?`,
      )
      .all(afterRowId, limit) as Array<{ rowId: number; threadId: string }>
  ).map((row) => ({ rowId: Number(row.rowId), threadId: row.threadId }));
}

/**
 * Superseded progress rows of one thread whose rowid is in
 * `(fromRowId, toRowId]`, at most `limit`, in sequence order. Read-only.
 */
export function selectSupersededToolProgress(
  db: CompactionDatabase,
  input: {
    threadId: string;
    fromRowId: number;
    toRowId: number;
    cutoff: string;
    limit: number;
  },
): SupersededProgress[] {
  if (db.prepare(STATION_OWNED_SQL).get(input.threadId) === undefined)
    return [];
  const page = pageRows(db, input);
  if (page.length === 0) return [];
  const selected: SupersededProgress[] = [];
  for (const turn of settledTurns(db, input.threadId, page, input.cutoff)) {
    const targets = page.filter(
      (row) =>
        row.turnId === turn.turnId && row.callId !== null && row.receipt === 0,
    );
    if (targets.length === 0) continue;
    const timeline = timelineRows(
      db,
      input.threadId,
      targets[0]!.sequence,
      turn.lastSequence,
    );
    const unreferenced = db.prepare(`SELECT ${UNREFERENCED} AS free`);
    selected.push(
      ...supersededInTurn(turn.turnId, targets, timeline).filter(
        (row) =>
          (
            unreferenced.get({ id: row.id, thread: input.threadId }) as {
              free: number;
            }
          ).free === 1,
      ),
    );
    if (selected.length >= input.limit) break;
  }
  return selected.slice(0, input.limit);
}

function pageRows(
  db: CompactionDatabase,
  input: { threadId: string; fromRowId: number; toRowId: number },
): PageRow[] {
  return db
    .prepare(
      `SELECT id, sequence, turn_id AS turnId,
              CASE WHEN json_valid(payload)
                    AND json_type(payload, '$.toolCallId') = 'text'
                   THEN json_extract(payload, '$.toolCallId') END AS callId,
              CASE WHEN json_valid(payload)
                    AND json_type(payload, '$.outputReceipt') IS NULL
                   THEN 0 ELSE 1 END AS receipt
         FROM orchestration_events
        WHERE method = 'tool.progress'
          AND rowid > ? AND rowid <= ?
          AND thread_id = ? AND turn_id IS NOT NULL
        ORDER BY sequence`,
    )
    .all(input.fromRowId, input.toRowId, input.threadId) as PageRow[];
}

/**
 * The page's turns that have a terminal and no row at or after the cutoff,
 * by provider time or Station receipt time, with each turn's last sequence.
 */
function settledTurns(
  db: CompactionDatabase,
  threadId: string,
  page: readonly PageRow[],
  cutoff: string,
): Array<{ turnId: string; lastSequence: number }> {
  const turnIds = [...new Set(page.map((row) => row.turnId))];
  return db
    .prepare(
      `SELECT turn_id AS turnId, MAX(sequence) AS lastSequence
         FROM orchestration_events INDEXED BY idx_events_thread_turn_sequence
        WHERE thread_id = ? AND turn_id IN (${turnIds.map(() => '?').join(', ')})
        GROUP BY turn_id
       HAVING SUM(method IN ('turn.completed', 'turn.aborted')) > 0
          AND SUM(julianday(created_at) IS NULL
                  OR julianday(created_at) >= julianday(?)
                  OR (observed_at IS NOT NULL
                      AND (julianday(observed_at) IS NULL
                           OR julianday(observed_at) >= julianday(?)))) = 0`,
    )
    .all(threadId, ...turnIds, cutoff, cutoff) as Array<{
    turnId: string;
    lastSequence: number;
  }>;
}

/**
 * Every row of the thread from the first target to the turn's last row, in
 * order, including other turns' rows that interleave. A call id is parsed
 * only from tool rows.
 */
function timelineRows(
  db: CompactionDatabase,
  threadId: string,
  fromSequence: number,
  toSequence: number,
): TimelineRow[] {
  return db
    .prepare(
      `SELECT id, sequence, turn_id AS turnId, method,
              CASE WHEN method IN ('tool.started', 'tool.completed', 'tool.progress')
                    AND json_valid(payload)
                    AND json_type(payload, '$.toolCallId') = 'text'
                   THEN json_extract(payload, '$.toolCallId') END AS callId
         FROM orchestration_events INDEXED BY idx_events_thread
        WHERE thread_id = ? AND sequence >= ? AND sequence <= ?
        ORDER BY sequence`,
    )
    .all(threadId, fromSequence, toSequence) as TimelineRow[];
}

/**
 * Walk the turn's timeline once. A call's pending progress row is superseded
 * by the call's next progress row in the same turn unless a barrier came
 * first: a start or completion of the same call (or one whose call id is
 * unreadable), or any event outside the transparent methods.
 */
function supersededInTurn(
  turnId: string,
  targets: readonly PageRow[],
  timeline: readonly TimelineRow[],
): SupersededProgress[] {
  const pending = new Map<string, TimelineRow>();
  const supersededBy = new Map<string, string>();
  const lastCompletion = new Map<string, number>();
  for (const row of timeline) {
    if (
      row.method === 'tool.progress' &&
      row.turnId === turnId &&
      row.callId !== null
    ) {
      const previous = pending.get(row.callId);
      if (previous) supersededBy.set(previous.id, row.id);
      pending.set(row.callId, row);
    } else if (TRANSPARENT_METHODS.has(row.method)) {
      // Cannot touch the slot of any call.
    } else if (
      (row.method === 'tool.started' || row.method === 'tool.completed') &&
      row.callId !== null
    ) {
      pending.delete(row.callId);
      if (row.method === 'tool.completed' && row.turnId === turnId)
        lastCompletion.set(row.callId, row.sequence);
    } else {
      pending.clear();
    }
  }
  return targets.flatMap((target) => {
    const by = supersededBy.get(target.id);
    const completedAt = lastCompletion.get(target.callId!);
    return by !== undefined &&
      completedAt !== undefined &&
      completedAt > target.sequence
      ? [{ id: target.id, supersededBy: by }]
      : [];
  });
}

/**
 * Delete the selected rows, then the content rows only they referenced. The
 * caller holds the write transaction. Each delete re-checks what a
 * concurrent writer could have changed since selection.
 */
export function deleteSupersededToolProgress(
  db: CompactionDatabase,
  threadId: string,
  selected: readonly SupersededProgress[],
): ToolProgressCompactionTotals {
  const totals: ToolProgressCompactionTotals = {
    rowsDeleted: 0,
    payloadBytes: 0,
    contentRowsDeleted: 0,
    contentBytes: 0,
  };
  if (
    selected.length === 0 ||
    db.prepare(STATION_OWNED_SQL).get(threadId) === undefined
  )
    return totals;
  const read = db.prepare(
    `SELECT length(CAST(payload AS BLOB)) AS bytes,
            CASE WHEN json_type(payload, '$.spilledContent') IS NOT NULL
                 THEN payload END AS spilled
       FROM orchestration_events WHERE id = ? AND thread_id = ?`,
  );
  const remove = db.prepare(
    `DELETE FROM orchestration_events
      WHERE id = :id AND thread_id = :thread
        AND EXISTS (SELECT 1 FROM orchestration_events WHERE id = :by)
        AND sequence < (SELECT MAX(sequence) FROM orchestration_events
                         WHERE thread_id = :thread)
        AND global_sequence < (SELECT MAX(global_sequence) FROM orchestration_events
                                WHERE thread_id = :thread)
        AND ${UNREFERENCED}`,
  );
  const digests = new Set<string>();
  for (const row of selected) {
    const stored = read.get(row.id, threadId) as
      | { bytes: number; spilled: string | null }
      | undefined;
    if (!stored) continue;
    const result = remove.run({
      id: row.id,
      thread: threadId,
      by: row.supersededBy,
    }) as { changes: number | bigint };
    if (Number(result.changes) !== 1) continue;
    totals.rowsDeleted += 1;
    totals.payloadBytes += Number(stored.bytes);
    if (stored.spilled !== null)
      for (const ref of collectRuntimeEventContentRefs(
        JSON.parse(stored.spilled),
      ))
        digests.add(ref.ref);
  }
  const content = deleteUnreferencedContent(db, threadId, digests);
  totals.contentRowsDeleted = content.rows;
  totals.contentBytes = content.bytes;
  return totals;
}

/**
 * Content rows are shared by digest within a thread, so a body goes only when
 * no remaining event or turn provenance envelope of the thread names its
 * digest. The check is textual: a payload that merely quotes the digest keeps
 * the body, which errs toward keeping bytes, never toward a dangling
 * reference.
 */
function deleteUnreferencedContent(
  db: CompactionDatabase,
  threadId: string,
  digests: ReadonlySet<string>,
): { rows: number; bytes: number } {
  let rows = 0;
  let bytes = 0;
  for (const digest of digests) {
    const referenced =
      db
        .prepare(
          `SELECT 1 FROM orchestration_events
            WHERE thread_id = ? AND instr(payload, ?) > 0 LIMIT 1`,
        )
        .get(threadId, digest) !== undefined ||
      db
        .prepare(
          `SELECT 1 FROM orchestration_turn_provenance
            WHERE thread_id = ? AND instr(envelope, ?) > 0 LIMIT 1`,
        )
        .get(threadId, digest) !== undefined;
    if (referenced) continue;
    const row = db
      .prepare(
        `SELECT length(CAST(body AS BLOB)) AS bytes
           FROM orchestration_event_content WHERE thread_id = ? AND digest = ?`,
      )
      .get(threadId, digest) as { bytes: number } | undefined;
    if (!row) continue;
    db.prepare(
      'DELETE FROM orchestration_event_content WHERE thread_id = ? AND digest = ?',
    ).run(threadId, digest);
    rows += 1;
    bytes += Number(row.bytes);
  }
  return { rows, bytes };
}
