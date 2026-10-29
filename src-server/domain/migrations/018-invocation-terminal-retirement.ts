import type { SqliteDatabase } from '../../services/orchestration/sqlite-database.js';

/** Retirement custody stays beside the immutable prepared input on this connection. */
export function ensureInvocationTerminalRetirement(db: SqliteDatabase): void {
  const columns = db
    .prepare('PRAGMA table_info(orchestration_prepared_turns)')
    .all() as Array<{ name: string }>;
  if (!columns.some(({ name }) => name === 'terminal_retirement'))
    db.exec(
      'ALTER TABLE orchestration_prepared_turns ADD COLUMN terminal_retirement TEXT',
    );
}
