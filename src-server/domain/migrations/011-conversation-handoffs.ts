/**
 * One durable, idempotent Agent/engine handoff reservation per predecessor
 * Session.  The marker is deliberately separate from provider events: it is
 * Station-owned provenance, not a cursor or a provider claim.
 */
export const CONVERSATION_HANDOFF_MIGRATION = `
CREATE TABLE IF NOT EXISTS orchestration_conversation_handoffs (
  conversation_id TEXT NOT NULL,
  predecessor_session_id TEXT NOT NULL PRIMARY KEY,
  session_id TEXT NOT NULL UNIQUE,
  idempotency_key TEXT NOT NULL,
  target_agent_id TEXT NOT NULL,
  target_environment_id TEXT NOT NULL,
  target_connection_id TEXT,
  target_model_id TEXT,
  message_digest TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (conversation_id, idempotency_key)
);
CREATE INDEX IF NOT EXISTS idx_conversation_handoffs_conversation
  ON orchestration_conversation_handoffs(conversation_id, created_at ASC);
`;

/**
 * `CREATE TABLE IF NOT EXISTS` preserves the handoff table introduced before
 * the immutable message digest became part of its idempotency identity.  The
 * original message is not recoverable from that receipt, so migrate such rows
 * to an explicit sentinel: replay then fails closed rather than treating an
 * unknown message as the same handoff.
 */
export function ensureConversationHandoffMessageDigestColumn(db: {
  prepare(sql: string): { all(): unknown[] };
  exec(sql: string): void;
}): void {
  const hasColumn = () =>
    (
      db
        .prepare('PRAGMA table_info(orchestration_conversation_handoffs)')
        .all() as Array<{ name?: unknown }>
    ).some((column) => column?.name === 'message_digest');

  if (hasColumn()) return;
  try {
    db.exec(
      "ALTER TABLE orchestration_conversation_handoffs ADD COLUMN message_digest TEXT NOT NULL DEFAULT 'legacy-unavailable'",
    );
  } catch (error) {
    // Another EventStore can complete this additive home upgrade first.
    if (!hasColumn()) throw error;
  }
}
