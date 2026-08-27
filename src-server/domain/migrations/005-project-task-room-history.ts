/** Independent room-local history tables in the existing orchestration DB. */
export const PROJECT_TASK_ROOM_HISTORY_MIGRATION = `
CREATE TABLE IF NOT EXISTS project_task_room_heads (
 channel_id TEXT PRIMARY KEY, project_id TEXT NOT NULL, project_slug TEXT NOT NULL,
 task_id TEXT NOT NULL, epoch INTEGER NOT NULL CHECK(epoch >= 0),
 head_seq INTEGER NOT NULL CHECK(head_seq >= 0), head_envelope_digest TEXT,
 head_checkpoint_digest TEXT NOT NULL, retained_anchor_seq INTEGER NOT NULL DEFAULT 0,
 retained_anchor_envelope_digest TEXT, retained_anchor_checkpoint_digest TEXT NOT NULL,
 policy_revision TEXT NOT NULL, UNIQUE(project_id, task_id)
);
CREATE TABLE IF NOT EXISTS project_task_room_records (
 channel_id TEXT NOT NULL, epoch INTEGER NOT NULL, seq INTEGER NOT NULL CHECK(seq >= 1),
 proposal_id TEXT NOT NULL, proposal_digest TEXT NOT NULL, envelope_digest TEXT NOT NULL,
 checkpoint_digest TEXT NOT NULL, record_json TEXT NOT NULL, record_bytes INTEGER NOT NULL CHECK(record_bytes >= 0),
 PRIMARY KEY(channel_id, epoch, seq), UNIQUE(channel_id, proposal_id)
);
CREATE TABLE IF NOT EXISTS project_task_room_identities (
 channel_id TEXT NOT NULL, proposal_id TEXT NOT NULL, proposal_digest TEXT NOT NULL,
 epoch INTEGER NOT NULL, seq INTEGER NOT NULL, envelope_digest TEXT NOT NULL,
 checkpoint_digest TEXT NOT NULL, committed_at TEXT NOT NULL, receipt_json TEXT NOT NULL,
 receipt_bytes INTEGER NOT NULL CHECK(receipt_bytes >= 0), receipt_digest TEXT NOT NULL,
 PRIMARY KEY(channel_id, proposal_id), UNIQUE(channel_id, epoch, seq)
);
CREATE INDEX IF NOT EXISTS idx_project_task_room_records_page ON project_task_room_records(channel_id,epoch,seq);
`;
