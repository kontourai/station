/** Immutable literal history seeds for ordinary continuation and context-boundary starts. */
export const CONVERSATION_START_CONTEXT_MIGRATION = `
CREATE TABLE IF NOT EXISTS orchestration_conversation_start_context (
  session_id TEXT PRIMARY KEY,
  seed_pin_json TEXT NOT NULL
);
`;
