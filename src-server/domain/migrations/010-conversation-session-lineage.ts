/**
 * Additive lineage projection for the future conversation/session split.
 * `orchestration_conversation_history.thread_id` remains the durable legacy
 * conversation identity; later slices may add child sessions without
 * rewriting events or cursors.
 */
export const CONVERSATION_SESSION_LINEAGE_MIGRATION = `
CREATE TABLE IF NOT EXISTS orchestration_conversation_sessions (
  conversation_id TEXT NOT NULL,
  session_id TEXT NOT NULL PRIMARY KEY,
  ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
  predecessor_session_id TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (conversation_id, ordinal)
);
CREATE INDEX IF NOT EXISTS idx_conversation_sessions_conversation_ordinal
  ON orchestration_conversation_sessions(conversation_id, ordinal ASC);
CREATE INDEX IF NOT EXISTS idx_conversation_sessions_predecessor
  ON orchestration_conversation_sessions(predecessor_session_id)
  WHERE predecessor_session_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_conversation_sessions_one_child_per_predecessor
  ON orchestration_conversation_sessions(predecessor_session_id)
  WHERE predecessor_session_id IS NOT NULL;
`;
