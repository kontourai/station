/**
 * #4003 Task memory, the judgment layer of a Task
 * (`@kontourai/station-contracts/task-memory`), kept apart from the Task room
 * document, whose stored state grows with every character ever typed (#4007).
 *
 * `(task_id, task_created_at)` is the Task incarnation: a Task re-created
 * under the same id starts with no memory.
 *
 * - `task_summary_revisions`: every revision of the one rewritten summary.
 *   The newest revision is the summary.
 * - `task_record_versions`: every version of every keyed record. The newest
 *   version of a `(kind, record_key)` is the record.
 *
 * Both are append-only at the database: the triggers refuse any UPDATE or
 * DELETE. The CHECKs hold the shape each writer must produce, so a store bug
 * fails the write instead of storing a state nothing can read: the length
 * bounds (SQLite's `length()` counts characters, never more than the UTF-16
 * units the writer bounds), the key slug, which states each kind can be in,
 * which action produces which state, and that only answers carry an answer
 * and only retirements a reason.
 */
export const TASK_MEMORY_MIGRATION = `
CREATE TABLE IF NOT EXISTS task_summary_revisions (
  project_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  task_created_at TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK (revision >= 1),
  text TEXT NOT NULL CHECK (length(text) BETWEEN 1 AND 4000),
  author_kind TEXT NOT NULL CHECK (author_kind IN ('session', 'person')),
  author_id TEXT NOT NULL CHECK (length(author_id) BETWEEN 1 AND 256),
  created_at TEXT NOT NULL,
  PRIMARY KEY (task_id, task_created_at, revision)
);
CREATE TRIGGER IF NOT EXISTS task_summary_revisions_no_update
BEFORE UPDATE ON task_summary_revisions
BEGIN
  SELECT RAISE(ABORT, 'task summary revisions are append-only');
END;
CREATE TRIGGER IF NOT EXISTS task_summary_revisions_no_delete
BEFORE DELETE ON task_summary_revisions
BEGIN
  SELECT RAISE(ABORT, 'task summary revisions are append-only');
END;

CREATE TABLE IF NOT EXISTS task_record_versions (
  project_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  task_created_at TEXT NOT NULL,
  ordinal INTEGER NOT NULL CHECK (ordinal >= 1),
  kind TEXT NOT NULL CHECK (kind IN ('decision', 'question', 'dead_end')),
  record_key TEXT NOT NULL CHECK (
    length(record_key) BETWEEN 1 AND 64
    AND record_key NOT GLOB '*[^a-z0-9-]*'
    AND record_key NOT GLOB '-*'
    AND record_key NOT GLOB '*-'
    AND record_key NOT GLOB '*--*'
  ),
  version INTEGER NOT NULL CHECK (version >= 1),
  action TEXT NOT NULL CHECK (action IN ('set', 'answer', 'retire')),
  state TEXT NOT NULL CHECK (state IN ('active', 'open', 'answered', 'retired')),
  importance TEXT NOT NULL CHECK (importance IN ('standing', 'on_topic')),
  text TEXT NOT NULL CHECK (length(text) BETWEEN 1 AND 1000),
  answer TEXT CHECK (answer IS NULL OR length(answer) BETWEEN 1 AND 1000),
  reason TEXT CHECK (reason IS NULL OR length(reason) BETWEEN 1 AND 500),
  author_kind TEXT NOT NULL CHECK (author_kind IN ('session', 'person')),
  author_id TEXT NOT NULL CHECK (length(author_id) BETWEEN 1 AND 256),
  created_at TEXT NOT NULL,
  PRIMARY KEY (task_id, task_created_at, ordinal),
  UNIQUE (task_id, task_created_at, kind, record_key, version),
  -- A key starts with a set.
  CHECK (version > 1 OR action = 'set'),
  -- Questions are open or answered; decisions and dead ends are active.
  CHECK (
    state = 'retired'
    OR (kind = 'question' AND state IN ('open', 'answered'))
    OR (kind <> 'question' AND state = 'active')
  ),
  -- Each action produces exactly its own state.
  CHECK (
    (action = 'set' AND state IN ('active', 'open'))
    OR (action = 'answer' AND state = 'answered')
    OR (action = 'retire' AND state = 'retired')
  ),
  CHECK ((answer IS NOT NULL) = (state = 'answered')),
  CHECK ((reason IS NOT NULL) = (action = 'retire'))
);
CREATE INDEX IF NOT EXISTS idx_task_record_versions_key
  ON task_record_versions(task_id, task_created_at, kind, record_key, version);
CREATE TRIGGER IF NOT EXISTS task_record_versions_no_update
BEFORE UPDATE ON task_record_versions
BEGIN
  SELECT RAISE(ABORT, 'task record versions are append-only');
END;
CREATE TRIGGER IF NOT EXISTS task_record_versions_no_delete
BEFORE DELETE ON task_record_versions
BEGIN
  SELECT RAISE(ABORT, 'task record versions are append-only');
END;
`;
