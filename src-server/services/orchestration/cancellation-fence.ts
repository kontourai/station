import {
  type TransactionalSqliteDatabase,
  writeTransaction,
} from './delegation-result-delivery.js';
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
        "SELECT 1 FROM orchestration_events WHERE id = ? AND thread_id = ? AND method IN ('session.exited', 'turn.aborted')",
      )
      .get(terminalId, parentId);
    if (!terminal) throw new Error('Cascade parent terminal is unavailable.');
    const existing = db
      .prepare(
        'SELECT parent_session_id FROM orchestration_cascade_stop_intents WHERE child_session_id = ? AND terminal_event_id = ?',
      )
      .get(childId, terminalId) as { parent_session_id: string } | undefined;
    if (existing && existing.parent_session_id !== parentId)
      throw new Error('Cascade intent parent conflict.');
    db.prepare(
      'INSERT OR IGNORE INTO orchestration_cascade_stop_intents VALUES (?, ?, ?, ?)',
    ).run(parentId, childId, terminalId, 'pending');
    db.prepare(
      'INSERT OR IGNORE INTO orchestration_cancellation_fences VALUES (?, ?)',
    ).run(childId, terminalId);
    return existing === undefined;
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
