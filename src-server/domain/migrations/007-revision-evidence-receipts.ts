/**
 * Immutable revision/evidence receipts share the orchestration SQLite file.
 * This is intentionally a narrow receipt ledger, not a generic document or
 * evidence table: archive#2891 remains the only canonical semantic validator.
 */
export const REVISION_EVIDENCE_RECEIPTS_MIGRATION = `
CREATE TABLE IF NOT EXISTS revision_evidence_receipts (
  revision_id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  document_id TEXT NOT NULL,
  record_json TEXT NOT NULL,
  record_bytes INTEGER NOT NULL CHECK(record_bytes >= 0),
  record_digest TEXT NOT NULL,
  persisted_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_revision_evidence_receipts_scope
  ON revision_evidence_receipts(project_id, task_id, document_id, persisted_at);
`;
