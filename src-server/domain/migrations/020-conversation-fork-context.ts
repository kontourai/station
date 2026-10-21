/** Immutable imported context inside the existing EventStore; never a provider Session. */
export const CONVERSATION_FORK_CONTEXT_MIGRATION = `
CREATE TABLE IF NOT EXISTS orchestration_conversation_fork_context (
  target_conversation_id TEXT PRIMARY KEY,
  fork_event_id TEXT NOT NULL UNIQUE,
  source_conversation_id TEXT NOT NULL,
  source_agent TEXT NOT NULL,
  target_agent TEXT NOT NULL,
  owner_user_id TEXT NOT NULL,
  tenant_key TEXT NOT NULL,
  project_slug TEXT,
  requested_project_slug TEXT,
  requested_branch_point_turn_id TEXT,
  idempotency_key TEXT,
  context_digest TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('prepared', 'ready', 'deleted')),
  snapshot_json TEXT,
  created_at TEXT NOT NULL,
  UNIQUE(owner_user_id, tenant_key, source_conversation_id, idempotency_key)
);
`;
