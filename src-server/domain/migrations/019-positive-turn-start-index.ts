import type { SqliteDatabase } from '../../services/orchestration/sqlite-database.js';

export const POSITIVE_TURN_START_INDEX = 'idx_events_positive_turn_start';
// Malformed starts remain blockers: the selected canonical row must still decode.
export const POSITIVE_TURN_START_SQL = `CASE WHEN json_valid(payload) THEN (
  (turn_id IS NOT NULL AND typeof(json_extract(payload, '$.invocationId')) = 'text' AND length(json_extract(payload, '$.invocationId')) > 0)
  OR json_extract(payload, '$.metadata.trigger') = 'provider'
) ELSE 1 END`;
const INDEX_SQL = `CREATE INDEX ${POSITIVE_TURN_START_INDEX}
  ON orchestration_events(thread_id, sequence DESC)
  WHERE method = 'turn.started' AND (${POSITIVE_TURN_START_SQL})`;
const normalize = (sql: string) => sql.trim().replace(/\s+/g, ' ');

export function assertPositiveTurnStartIndex(db: SqliteDatabase): void {
  const row = db
    .prepare("SELECT sql FROM sqlite_schema WHERE type = 'index' AND name = ?")
    .get(POSITIVE_TURN_START_INDEX);
  if (
    typeof row !== 'object' ||
    row === null ||
    !('sql' in row) ||
    typeof row.sql !== 'string' ||
    normalize(row.sql) !== normalize(INDEX_SQL)
  )
    throw new Error(
      'Canonical positive-start index is unavailable or changed.',
    );
}

/** Build existing data atomically; a same-name unrelated index cannot satisfy the contract. */
export function ensurePositiveTurnStartIndex(
  db: SqliteDatabase & { readonly isTransaction: boolean },
): void {
  // A deferred schema read can become an un-upgradable WAL snapshot when a
  // peer commits. Reserve the writer before reading migration state.
  const ownsTransaction = !db.isTransaction;
  db.exec(
    ownsTransaction
      ? 'BEGIN IMMEDIATE'
      : 'SAVEPOINT station_positive_turn_start_index',
  );
  try {
    const existing = db
      .prepare("SELECT 1 FROM sqlite_schema WHERE type = 'index' AND name = ?")
      .get(POSITIVE_TURN_START_INDEX);
    if (!existing) db.exec(INDEX_SQL);
    assertPositiveTurnStartIndex(db);
    db.exec(
      ownsTransaction ? 'COMMIT' : 'RELEASE station_positive_turn_start_index',
    );
  } catch (cause) {
    if (db.isTransaction)
      db.exec(
        ownsTransaction
          ? 'ROLLBACK'
          : 'ROLLBACK TO station_positive_turn_start_index; RELEASE station_positive_turn_start_index',
      );
    throw cause;
  }
}
