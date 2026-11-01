import type { SqliteDatabase } from './sqlite-database.js';

export const CANCELLATION_FENCE_SCHEMA = `CREATE TABLE IF NOT EXISTS orchestration_cancellation_fences (
  thread_id TEXT NOT NULL,
  terminal_event_id TEXT NOT NULL,
  PRIMARY KEY (thread_id, terminal_event_id)
)`;

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
