/** Native child effects remain a projection in the existing EventStore. */
export const CONVERSATION_NATIVE_FORK_EFFECT_MIGRATION = `
CREATE TABLE IF NOT EXISTS orchestration_conversation_native_fork_effect (
  target_conversation_id TEXT PRIMARY KEY,
  record_json TEXT NOT NULL
);
`;
