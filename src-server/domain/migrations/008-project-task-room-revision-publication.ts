/** Atomic sidecar for document-commit revision publication. */
export const PROJECT_TASK_ROOM_REVISION_PUBLICATION_MIGRATION = `
CREATE TABLE IF NOT EXISTS project_task_room_revision_publication_outbox (
  project_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  document_id TEXT NOT NULL,
  intent_id TEXT NOT NULL,
  base_working_revision TEXT NOT NULL,
  working_revision TEXT NOT NULL,
  snapshot_json TEXT NOT NULL,
  snapshot_bytes INTEGER NOT NULL CHECK(snapshot_bytes > 0 AND snapshot_bytes <= 524288),
  actor_id TEXT NOT NULL,
  actor_label TEXT,
  operator_id TEXT NOT NULL,
  device_id TEXT NOT NULL,
  policy_revision TEXT NOT NULL,
  correlation_json TEXT NOT NULL,
  parent_evidence_revision TEXT,
  evidence_revision TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY(project_id, task_id, document_id),
  UNIQUE(intent_id)
);
CREATE TABLE IF NOT EXISTS project_task_room_revision_evidence_heads (
  project_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  document_id TEXT NOT NULL,
  working_revision TEXT NOT NULL,
  evidence_revision TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(project_id, task_id, document_id)
);
`;
