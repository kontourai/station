/**
 * Durable runtime facts for one Project/Task document.  These tables live in
 * the orchestration database beside the append-only room history; they are
 * intentionally not generic CRUD storage.
 */
export const PROJECT_TASK_ROOM_RUNTIME_MIGRATION = `
CREATE TABLE IF NOT EXISTS project_task_room_working_states (
  project_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  document_id TEXT NOT NULL,
  snapshot_json TEXT NOT NULL,
  revision TEXT NOT NULL,
  compaction_floor TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(project_id, task_id, document_id)
);
CREATE TABLE IF NOT EXISTS project_task_room_working_batches (
  project_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  document_id TEXT NOT NULL,
  intent_id TEXT NOT NULL,
  intent_digest TEXT NOT NULL,
  receipt_json TEXT NOT NULL,
  committed_at TEXT NOT NULL,
  PRIMARY KEY(project_id, task_id, document_id, intent_id),
  UNIQUE(project_id, task_id, document_id, intent_id, intent_digest)
);
-- A bounded, document-local revision chain. The materialized snapshot is the
-- recovery truth; these rows only make a recent cursor revision resumable.
CREATE TABLE IF NOT EXISTS project_task_room_working_revisions (
  project_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  document_id TEXT NOT NULL,
  ordinal INTEGER NOT NULL,
  prior_revision TEXT NOT NULL,
  revision TEXT NOT NULL,
  PRIMARY KEY(project_id, task_id, document_id, ordinal)
);
CREATE INDEX IF NOT EXISTS idx_project_task_room_working_revisions_prior
  ON project_task_room_working_revisions(project_id, task_id, document_id, prior_revision);
CREATE TABLE IF NOT EXISTS project_task_room_live_recovery (
  project_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  document_id TEXT NOT NULL,
  generation TEXT NOT NULL,
  recovery_json TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(project_id, task_id, document_id)
);
-- Publication is an observational consequence of a successful remote task
-- dispatch, but it must survive the process gap between association and room
-- history append. This is deliberately room-local, not a generic job queue.
CREATE TABLE IF NOT EXISTS project_task_room_agent_lifecycle_outbox (
  project_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  document_id TEXT NOT NULL,
  intent_id TEXT NOT NULL,
  lifecycle_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY(project_id, task_id, document_id, intent_id)
);
`;
