/** Immutable, descriptor-only work-item observations bound to canonical tools. */
export const SESSION_WORK_ITEM_ASSOCIATIONS_MIGRATION = `
CREATE TABLE IF NOT EXISTS orchestration_session_work_item_associations (
  association_id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  turn_id TEXT NOT NULL,
  tool_call_id TEXT NOT NULL,
  observed_at TEXT NOT NULL,
  association_json TEXT NOT NULL,
  UNIQUE (session_id, conversation_id, event_id, turn_id, tool_call_id)
);
CREATE INDEX IF NOT EXISTS idx_session_work_item_associations_scope
  ON orchestration_session_work_item_associations
     (session_id, conversation_id, observed_at ASC, association_id ASC);
`;
