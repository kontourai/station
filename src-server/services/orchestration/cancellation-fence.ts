import { z } from 'zod';
import {
  type TransactionalSqliteDatabase,
  writeTransaction,
} from './delegation-result-delivery.js';
import { ownedDescendantsBottomUp } from './ownership-tree.js';
import type { SqliteDatabase } from './sqlite-database.js';

export const CANCELLATION_FENCE_SCHEMA = `CREATE TABLE IF NOT EXISTS orchestration_cancellation_fences (
  thread_id TEXT NOT NULL,
  terminal_event_id TEXT NOT NULL,
  PRIMARY KEY (thread_id, terminal_event_id)
);
CREATE TABLE IF NOT EXISTS orchestration_cascade_stop_intents (
  parent_session_id TEXT NOT NULL,
  child_session_id TEXT NOT NULL,
  terminal_event_id TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('pending', 'completed')),
  PRIMARY KEY (child_session_id, terminal_event_id)
) ;
CREATE TABLE IF NOT EXISTS orchestration_cascade_stop_custody (
  child_session_id TEXT NOT NULL,
  terminal_event_id TEXT NOT NULL,
  custody TEXT NOT NULL CHECK (custody IN ('local', 'peer', 'unknown')),
  evidence_json TEXT NOT NULL,
  PRIMARY KEY (child_session_id, terminal_event_id)
)`;

export function recordCascadeStopIntent(
  db: TransactionalSqliteDatabase,
  parentId: string,
  childId: string,
  terminalId: string,
): boolean {
  return writeTransaction(db, 'cascade_stop_intent', () => {
    // A nested caller may have opened a deferred transaction; take its writer
    // reservation before reading any authority or admission state.
    db.prepare(
      'UPDATE orchestration_stream_identity SET high_water = high_water WHERE singleton = 1',
    ).run();
    const terminal = db
      .prepare(
        "SELECT 1 FROM orchestration_events WHERE id = ? AND thread_id = ? AND (method IN ('session.exited', 'turn.aborted', 'session.cancellation-requested') OR (method = 'session.state-changed' AND session_state = 'canceled'))",
      )
      .get(terminalId, parentId);
    if (!terminal) throw new Error('Cascade parent terminal is unavailable.');
    const existing = db
      .prepare(
        'SELECT parent_session_id, state FROM orchestration_cascade_stop_intents WHERE child_session_id = ? AND terminal_event_id = ?',
      )
      .get(childId, terminalId) as
      | { parent_session_id: string; state: string }
      | undefined;
    if (existing && existing.parent_session_id !== parentId)
      throw new Error('Cascade intent parent conflict.');
    db.prepare(
      'INSERT OR IGNORE INTO orchestration_cascade_stop_intents VALUES (?, ?, ?, ?)',
    ).run(parentId, childId, terminalId, 'pending');
    if (parentId === childId && existing?.state === 'completed') return false;
    db.prepare(
      'INSERT OR IGNORE INTO orchestration_cancellation_fences VALUES (?, ?)',
    ).run(childId, terminalId);
    return existing === undefined;
  });
}

export function deriveCascadeStopIntents(
  db: TransactionalSqliteDatabase,
  event: {
    method: string;
    eventId: string;
    threadId: string;
    sessionState?: string;
  },
  sequence: number,
): void {
  const requested = event.method === 'session.cancellation-requested';
  if (
    !requested &&
    event.method !== 'session.exited' &&
    event.method !== 'turn.aborted' &&
    !(
      event.method === 'session.state-changed' &&
      event.sessionState === 'canceled'
    )
  )
    return;
  // An ancestor's durable request already includes this fenced subtree.
  if (!requested && isCancellationFenced(db, event.threadId)) return;
  if (
    !requested &&
    db
      .prepare(`SELECT 1 FROM orchestration_events r WHERE r.thread_id = ?
    AND r.method = 'session.cancellation-requested' AND r.global_sequence < ?
    AND r.global_sequence > COALESCE((SELECT MAX(global_sequence) FROM orchestration_events
      WHERE thread_id = r.thread_id AND global_sequence < ? AND method IN ('turn.started', 'session.started')), 0) LIMIT 1`)
      .get(event.threadId, sequence, sequence)
  )
    return;
  const descendants = ownedDescendantsBottomUp(db, event.threadId, sequence);
  for (const childId of descendants)
    recordCascadeStopIntent(db, event.threadId, childId, event.eventId);
  if (requested)
    recordCascadeStopIntent(db, event.threadId, event.threadId, event.eventId);
}

export function backfillCascadeStopIntents(
  db: TransactionalSqliteDatabase,
): void {
  writeTransaction(db, 'cascade_recovery', () => {
    const rows = z
      .array(
        z.object({
          id: z.string(),
          thread_id: z.string(),
          method: z.string(),
          global_sequence: z.number().int(),
          session_state: z.string().nullable(),
        }),
      )
      .parse(
        db
          .prepare(`
      SELECT id, thread_id, method, global_sequence, session_state FROM orchestration_events
      WHERE method IN ('session.exited', 'turn.aborted', 'session.cancellation-requested')
        OR (method = 'session.state-changed' AND session_state = 'canceled') ORDER BY global_sequence`)
          .all(),
      );
    for (const row of rows)
      deriveCascadeStopIntents(
        db,
        {
          method: row.method,
          eventId: row.id,
          threadId: row.thread_id,
          ...(row.session_state ? { sessionState: row.session_state } : {}),
        },
        row.global_sequence,
      );
  });
}

/** Call while holding the same SQLite writer transaction as admission. */
export function isCancellationFenced(
  db: SqliteDatabase,
  threadId: string,
): boolean {
  return Boolean(
    db
      .prepare(
        'SELECT 1 FROM orchestration_cancellation_fences WHERE thread_id = ? LIMIT 1',
      )
      .get(threadId),
  );
}
