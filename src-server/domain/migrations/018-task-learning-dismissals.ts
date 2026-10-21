/**
 * #4003 layer 4 (Learning): a person's dismissal of a done Task's promotion
 * candidate, so it is not offered again. Candidates themselves are derived on
 * read from `task_record_versions` (migration 017) and a promotion lives in
 * the Project's knowledge store, so this is the only state Station keeps.
 *
 * One row per dismissed record VERSION of a Task incarnation
 * `(task_id, task_created_at)`: a later version of the same key is a new
 * candidate. Append-only at the database, like Task memory itself.
 */
export const TASK_LEARNING_DISMISSALS_MIGRATION = `
CREATE TABLE IF NOT EXISTS task_learning_dismissals (
  project_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  task_created_at TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('decision', 'dead_end')),
  record_key TEXT NOT NULL CHECK (length(record_key) BETWEEN 1 AND 64),
  version INTEGER NOT NULL CHECK (version >= 1),
  principal_id TEXT NOT NULL CHECK (length(principal_id) BETWEEN 1 AND 256),
  dismissed_at TEXT NOT NULL,
  PRIMARY KEY (task_id, task_created_at, kind, record_key, version)
);
CREATE TRIGGER IF NOT EXISTS task_learning_dismissals_no_update
BEFORE UPDATE ON task_learning_dismissals
BEGIN
  SELECT RAISE(ABORT, 'task learning dismissals are append-only');
END;
CREATE TRIGGER IF NOT EXISTS task_learning_dismissals_no_delete
BEFORE DELETE ON task_learning_dismissals
BEGIN
  SELECT RAISE(ABORT, 'task learning dismissals are append-only');
END;
`;
