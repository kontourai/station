/** The attempt and its terminal outcome are separate immutable records. */
export const TASK_WRITE_BACK_MIGRATION = `
CREATE TABLE IF NOT EXISTS task_write_back_attempts (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  task_created_at TEXT NOT NULL,
  ordinal INTEGER NOT NULL CHECK (ordinal > 0),
  target_json TEXT NOT NULL CHECK (json_valid(target_json)),
  initiator_json TEXT NOT NULL CHECK (json_valid(initiator_json)),
  attempted_at TEXT NOT NULL,
  retry_of TEXT REFERENCES task_write_back_attempts(id),
  UNIQUE (project_id, task_id, task_created_at, ordinal)
);
CREATE INDEX IF NOT EXISTS idx_task_write_back_task
  ON task_write_back_attempts(project_id, task_id, task_created_at, ordinal);
CREATE TABLE IF NOT EXISTS task_write_back_outcomes (
  attempt_id TEXT PRIMARY KEY REFERENCES task_write_back_attempts(id),
  state TEXT NOT NULL CHECK (state IN ('succeeded', 'failed')),
  failure_reason TEXT,
  settled_at TEXT NOT NULL,
  CHECK ((state = 'failed' AND failure_reason IS NOT NULL AND length(failure_reason) BETWEEN 1 AND 500)
    OR (state = 'succeeded' AND failure_reason IS NULL))
);
CREATE TRIGGER IF NOT EXISTS task_write_back_attempts_no_update BEFORE UPDATE ON task_write_back_attempts
BEGIN SELECT RAISE(ABORT, 'task write-back is append-only'); END;
CREATE TRIGGER IF NOT EXISTS task_write_back_attempts_no_delete BEFORE DELETE ON task_write_back_attempts
BEGIN SELECT RAISE(ABORT, 'task write-back is append-only'); END;
CREATE TRIGGER IF NOT EXISTS task_write_back_outcomes_no_update BEFORE UPDATE ON task_write_back_outcomes
BEGIN SELECT RAISE(ABORT, 'task write-back is append-only'); END;
CREATE TRIGGER IF NOT EXISTS task_write_back_outcomes_no_delete BEFORE DELETE ON task_write_back_outcomes
BEGIN SELECT RAISE(ABORT, 'task write-back is append-only'); END;
`;
