import type { SqliteDatabase } from '../../services/orchestration/sqlite-database.js';

/** Retirement custody stays beside the immutable prepared input on this connection. */
export function ensureInvocationTerminalRetirement(db: SqliteDatabase): void {
  const hasRetirementColumn = () =>
    (
      db
        .prepare('PRAGMA table_info(orchestration_prepared_turns)')
        .all() as Array<{ name: string }>
    ).some(({ name }) => name === 'terminal_retirement');
  if (hasRetirementColumn()) return;

  // The schema may have changed while waiting for the other constructor.
  db.exec('BEGIN IMMEDIATE');
  try {
    if (!hasRetirementColumn())
      db.exec(
        'ALTER TABLE orchestration_prepared_turns ADD COLUMN terminal_retirement TEXT',
      );
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}
