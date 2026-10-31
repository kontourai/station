import type { SqliteDatabase } from '../../services/orchestration/sqlite-database.js';

/** Forward-only rebuild: old reset reservations and audit identities remain exact. */
export function migrateContextSummaryBoundaries(db: SqliteDatabase): void {
  const columns = db
    .prepare('PRAGMA table_info(orchestration_conversation_context_boundaries)')
    .all() as { name: string }[];
  if (columns.some((column) => column.name === 'seed_json')) return;
  try {
    db.exec(`BEGIN IMMEDIATE;
    CREATE TABLE orchestration_context_boundaries_v26 (
      boundary_id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL,
      predecessor_session_id TEXT NOT NULL, successor_session_id TEXT NOT NULL UNIQUE,
      idempotency_key TEXT NOT NULL,
      policy TEXT NOT NULL CHECK(policy IN ('continue-from-history','empty-next-cold-start','summary-next-cold-start','task-state-next-cold-start')),
      status TEXT NOT NULL CHECK(status IN ('reserved','claimed','consumed','cancelled','failed','indeterminate')),
      actor_id TEXT NOT NULL, client_origin TEXT, created_at TEXT NOT NULL,
      claimed_at TEXT, start_command_id TEXT, consumed_at TEXT, seed_json TEXT,
      UNIQUE(conversation_id,idempotency_key),
      CHECK(COALESCE(CASE WHEN policy IN ('continue-from-history','empty-next-cold-start') THEN seed_json IS NULL
        ELSE seed_json IS NOT NULL AND json_valid(seed_json) AND
          json_type(seed_json,'$.text')='text' AND length(json_extract(seed_json,'$.text')) BETWEEN 1 AND 16000 AND
          json_extract(seed_json,'$.sourceSessionId')=predecessor_session_id AND
          json_type(seed_json,'$.sourceEventId')='text' AND json_type(seed_json,'$.sourceRevision')='text' AND
          length(json_extract(seed_json,'$.digest'))=64 AND json_extract(seed_json,'$.digest') NOT GLOB '*[^a-f0-9]*' AND
          ((policy='summary-next-cold-start' AND json_extract(seed_json,'$.kind')='semantic-summary' AND json_type(seed_json,'$.model')='text') OR
           (policy='task-state-next-cold-start' AND json_extract(seed_json,'$.kind')='task-state' AND json_type(seed_json,'$.task.taskId')='text' AND json_type(seed_json,'$.task.taskCreatedAt')='text')) END,0))
    );
    INSERT INTO orchestration_context_boundaries_v26
      SELECT boundary_id,conversation_id,predecessor_session_id,successor_session_id,idempotency_key,policy,status,
        actor_id,client_origin,created_at,claimed_at,start_command_id,consumed_at,NULL
        FROM orchestration_conversation_context_boundaries;
    DROP TABLE orchestration_conversation_context_boundaries;
    ALTER TABLE orchestration_context_boundaries_v26 RENAME TO orchestration_conversation_context_boundaries;
    CREATE INDEX idx_conversation_context_boundaries_conversation ON orchestration_conversation_context_boundaries(conversation_id,created_at);
    CREATE UNIQUE INDEX idx_conversation_context_boundaries_active_conversation ON orchestration_conversation_context_boundaries(conversation_id) WHERE status IN ('reserved','claimed','indeterminate');
    COMMIT;`);
  } catch (error) {
    try {
      db.exec('ROLLBACK');
    } catch {}
    throw error;
  }
}
