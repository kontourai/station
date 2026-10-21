/**
 * #4003 layer 4 (Learning), review F9: which knowledge store a done Task's
 * record VERSION was promoted into, recorded in the orchestration database
 * BEFORE the knowledge write.
 *
 * A promotion writes one record into one of the Project's knowledge stores.
 * Each store refuses a second record with the same id, but the stores are
 * separate, so two concurrent promotions of one version into two stores
 * would both succeed. This row is the one place that decides: the first
 * promotion of a version inserts it, naming its store; every later or
 * concurrent promotion of that version reads it and writes (or reads back)
 * only in that store.
 *
 * One row per record version of a Task incarnation `(task_id,
 * task_created_at)`. Append-only at the database, like the dismissals
 * (migration 021).
 */
export const TASK_LEARNING_PROMOTIONS_MIGRATION = `
CREATE TABLE IF NOT EXISTS task_learning_promotions (
  project_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  task_created_at TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('decision', 'dead_end')),
  record_key TEXT NOT NULL CHECK (length(record_key) BETWEEN 1 AND 64),
  version INTEGER NOT NULL CHECK (version >= 1),
  root_id TEXT NOT NULL CHECK (length(root_id) BETWEEN 1 AND 300),
  principal_id TEXT NOT NULL CHECK (length(principal_id) BETWEEN 1 AND 256),
  promoted_at TEXT NOT NULL,
  PRIMARY KEY (task_id, task_created_at, kind, record_key, version)
);
CREATE TRIGGER IF NOT EXISTS task_learning_promotions_no_update
BEFORE UPDATE ON task_learning_promotions
BEGIN
  SELECT RAISE(ABORT, 'task learning promotions are append-only');
END;
CREATE TRIGGER IF NOT EXISTS task_learning_promotions_no_delete
BEFORE DELETE ON task_learning_promotions
BEGIN
  SELECT RAISE(ABORT, 'task learning promotions are append-only');
END;
`;
