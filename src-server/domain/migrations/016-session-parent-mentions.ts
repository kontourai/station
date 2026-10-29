import { DELEGATION_PROVENANCE_METADATA_KEY } from '@kontourai/station-contracts/provider';

// Columns deliberately have no affinity: json_extract's SQLite value types
// decide MAX/COALESCE in the legacy naming query, including malformed claims.
const columns = `(event_id, child_session_id, sequence, global_sequence,
  source_method, context_parent, legacy_parent, task_parent, start_provenance)`;
function selectMentions(source: string): string {
  return `SELECT ${source}.id, ${source}.thread_id, ${source}.sequence,
    ${source}.global_sequence, ${source}.method,
    json_extract(${source}.payload, '$.metadata.delegation.parentConversationId'),
    json_extract(${source}.payload, '$.metadata.parentConversationId'),
    json_extract(${source}.payload, '$.metadata.parentTaskId'),
    CASE WHEN ${source}.method = 'session.started'
      THEN json_extract(${source}.payload, '$.metadata.${DELEGATION_PROVENANCE_METADATA_KEY}') END`;
}
function namingRow(source: string): string {
  return `${source}.method IN ('session.started', 'session.configured') AND json_valid(${source}.payload)`;
}

/** Naming evidence only. Neither a parent mention nor its stamp grants lifecycle authority. */
export function migrateSessionParentMentions(db: {
  readonly isTransaction: boolean;
  exec(sql: string): void;
  prepare(sql: string): { get(): unknown };
}): void {
  const completed = () =>
    db
      .prepare(
        "SELECT 1 FROM orchestration_event_store_backfills WHERE name = 'session-parent-mentions-v1'",
      )
      .get();
  if (completed()) return;
  db.exec('BEGIN IMMEDIATE');
  try {
    // Concurrent openers must check again after acquiring the writer lock.
    if (!completed()) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS orchestration_session_parent_mentions (
          event_id TEXT PRIMARY KEY,
          child_session_id TEXT NOT NULL,
          sequence INTEGER NOT NULL,
          global_sequence INTEGER NOT NULL,
          source_method TEXT NOT NULL,
          context_parent,
          legacy_parent,
          task_parent,
          start_provenance
        );
        CREATE INDEX IF NOT EXISTS idx_parent_mentions_context
          ON orchestration_session_parent_mentions(context_parent);
        CREATE INDEX IF NOT EXISTS idx_parent_mentions_legacy
          ON orchestration_session_parent_mentions(legacy_parent);
        CREATE INDEX IF NOT EXISTS idx_parent_mentions_task
          ON orchestration_session_parent_mentions(task_parent);

        -- Triggers participate in the source write's transaction, including
        -- replay/import append paths. Deletes and retention cannot leave edges.
        CREATE TRIGGER IF NOT EXISTS session_parent_mentions_insert
        AFTER INSERT ON orchestration_events WHEN ${namingRow('NEW')}
        BEGIN
          INSERT INTO orchestration_session_parent_mentions ${columns}
          ${selectMentions('NEW')};
        END;
        CREATE TRIGGER IF NOT EXISTS session_parent_mentions_delete
        AFTER DELETE ON orchestration_events
        BEGIN
          DELETE FROM orchestration_session_parent_mentions WHERE event_id = OLD.id;
        END;
        -- Preserve the old scan's response to repaired or corrupt source rows.
        CREATE TRIGGER IF NOT EXISTS session_parent_mentions_update
        AFTER UPDATE OF id, thread_id, sequence, global_sequence, method, payload ON orchestration_events
        BEGIN
          DELETE FROM orchestration_session_parent_mentions WHERE event_id = OLD.id;
          INSERT INTO orchestration_session_parent_mentions ${columns}
          ${selectMentions('NEW')} WHERE ${namingRow('NEW')};
        END;

        INSERT OR REPLACE INTO orchestration_session_parent_mentions ${columns}
        ${selectMentions('e')} FROM orchestration_events e WHERE ${namingRow('e')};
        INSERT INTO orchestration_event_store_backfills(name, completed_at)
          VALUES ('session-parent-mentions-v1', CURRENT_TIMESTAMP);
      `);
    }
    db.exec('COMMIT');
  } catch (error) {
    if (db.isTransaction) db.exec('ROLLBACK');
    throw error;
  }
}
