import type { SqliteDatabase } from '../../services/orchestration/sqlite-database.js';

/** Upgrade the host-owned CHECK and uniqueness fence without losing legacy rows. */
export function ensurePreparedTurnIntents(db: SqliteDatabase): void {
  db.exec('BEGIN IMMEDIATE');
  try {
    const columns = db
      .prepare('PRAGMA table_info(orchestration_turn_boundaries)')
      .all() as Array<{ name: string }>;
    if (!columns.some(({ name }) => name === 'prepared_settlement')) {
      const hasIntent = columns.some(({ name }) => name === 'invocation_id');
      db.exec(`CREATE TABLE orchestration_turn_boundaries_prepared (
        boundary_id TEXT PRIMARY KEY,
        purpose TEXT NOT NULL DEFAULT 'turn' CHECK(purpose IN ('turn','task-dispatch')),
        thread_id TEXT NOT NULL,
        state TEXT NOT NULL CHECK(state IN ('lifecycle','reserved','prepared','invoking','accepted','indeterminate','settled')),
        provider_turn_id TEXT, owner_id TEXT NOT NULL, owner_pid INTEGER NOT NULL,
        owner_birth TEXT, owner_identity_kind TEXT NOT NULL,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        created_sequence INTEGER CHECK(created_sequence >= 0),
        invocation_id TEXT, input_digest TEXT, intent_digest TEXT, body_ref TEXT, dedup_key TEXT,
        prepared_settlement TEXT
      );
      INSERT INTO orchestration_turn_boundaries_prepared
        (boundary_id,purpose,thread_id,state,provider_turn_id,owner_id,owner_pid,owner_birth,owner_identity_kind,created_at,updated_at,created_sequence,invocation_id,input_digest,intent_digest,body_ref,dedup_key)
        SELECT boundary_id,purpose,thread_id,state,provider_turn_id,owner_id,owner_pid,owner_birth,owner_identity_kind,created_at,updated_at,created_sequence,
        ${hasIntent ? 'invocation_id,input_digest,intent_digest,body_ref,dedup_key' : 'NULL,NULL,NULL,NULL,NULL'}
        FROM orchestration_turn_boundaries;
      DROP TABLE orchestration_turn_boundaries;
      ALTER TABLE orchestration_turn_boundaries_prepared RENAME TO orchestration_turn_boundaries;
      CREATE INDEX idx_orchestration_turn_boundaries_owner ON orchestration_turn_boundaries(owner_id,state);
      CREATE UNIQUE INDEX idx_orchestration_turn_boundaries_one_invocation
        ON orchestration_turn_boundaries(thread_id)
        WHERE state IN ('lifecycle','reserved','prepared','invoking','indeterminate');`);
    }
    db.exec(`CREATE TABLE IF NOT EXISTS orchestration_prepared_turns (
      invocation_id TEXT PRIMARY KEY, boundary_id TEXT NOT NULL UNIQUE,
      thread_id TEXT NOT NULL, client_turn_id TEXT,
      input_digest TEXT NOT NULL, intent_digest TEXT NOT NULL,
      envelope_json TEXT NOT NULL, byte_length INTEGER NOT NULL CHECK(byte_length >= 0),
      prepared_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_prepared_turns_thread ON orchestration_prepared_turns(thread_id);`);
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}
