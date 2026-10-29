import type { SqliteDatabase } from '../../services/orchestration/sqlite-database.js';

export const USAGE_EXPORT_JOURNAL_MARKER = 'usage-export-invalidations/v1';

/** Private, bounded tombstones. Source restore activation still needs its own generation fence. */
const SCHEMA = `
CREATE TABLE orchestration_usage_export_state (
 singleton INTEGER PRIMARY KEY CHECK(singleton=1),
 revision INTEGER NOT NULL CHECK(revision>=0),
 retained_after INTEGER NOT NULL CHECK(retained_after>=0 AND retained_after<=revision)
);
CREATE TABLE orchestration_usage_export_invalidations (
 revision INTEGER PRIMARY KEY AUTOINCREMENT,
 owner_user_id TEXT NOT NULL CHECK(length(owner_user_id)>0),
 tenant_id TEXT,
 thread_id TEXT NOT NULL,
 reason TEXT NOT NULL CHECK(reason IN ('thread-deleted','scope-changed','scope-entered')),
 observed_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE TRIGGER orchestration_usage_export_recorded
AFTER INSERT ON orchestration_usage_export_invalidations
BEGIN
 UPDATE orchestration_usage_export_state
 SET revision=NEW.revision,retained_after=MAX(0,NEW.revision-10000)
 WHERE singleton=1 AND revision=NEW.revision-1;
 SELECT CASE WHEN changes()!=1 THEN RAISE(ABORT,'usage export invalidation state unavailable') END;
 DELETE FROM orchestration_usage_export_invalidations WHERE revision<=NEW.revision-10000;
END;
CREATE TRIGGER orchestration_usage_export_history_deleted
AFTER DELETE ON orchestration_conversation_history
WHEN OLD.owner_user_id IS NOT NULL AND length(OLD.owner_user_id)>0
BEGIN
 INSERT INTO orchestration_usage_export_invalidations(owner_user_id,tenant_id,thread_id,reason)
 VALUES(OLD.owner_user_id,OLD.tenant_id,OLD.thread_id,'thread-deleted');
END;
CREATE TRIGGER orchestration_usage_export_scope_changed
AFTER UPDATE OF owner_user_id,tenant_id ON orchestration_conversation_history
WHEN (OLD.owner_user_id IS NOT NEW.owner_user_id OR OLD.tenant_id IS NOT NEW.tenant_id)
 AND EXISTS(SELECT 1 FROM orchestration_events WHERE thread_id=NEW.thread_id AND method='token-usage.updated')
BEGIN
 INSERT INTO orchestration_usage_export_invalidations(owner_user_id,tenant_id,thread_id,reason)
 SELECT OLD.owner_user_id,OLD.tenant_id,OLD.thread_id,'scope-changed'
 WHERE OLD.owner_user_id IS NOT NULL AND length(OLD.owner_user_id)>0;
 INSERT INTO orchestration_usage_export_invalidations(owner_user_id,tenant_id,thread_id,reason)
 SELECT NEW.owner_user_id,NEW.tenant_id,NEW.thread_id,'scope-entered'
 WHERE NEW.owner_user_id IS NOT NULL AND length(NEW.owner_user_id)>0;
END;
CREATE TRIGGER orchestration_usage_export_scope_entered
AFTER INSERT ON orchestration_conversation_history
WHEN NEW.owner_user_id IS NOT NULL AND length(NEW.owner_user_id)>0
 AND EXISTS(SELECT 1 FROM orchestration_events WHERE thread_id=NEW.thread_id AND method='token-usage.updated')
BEGIN
 INSERT INTO orchestration_usage_export_invalidations(owner_user_id,tenant_id,thread_id,reason)
 VALUES(NEW.owner_user_id,NEW.tenant_id,NEW.thread_id,'scope-entered');
END;
`;
const definitions = SCHEMA.trim()
  .split(/(?=CREATE (?:TABLE|TRIGGER) )/)
  .filter(Boolean);
const normalize = (sql: string) =>
  sql.trim().replace(/;$/, '').replace(/\s+/g, ' ');

export function ensureUsageExportInvalidations(
  db: SqliteDatabase & { readonly isTransaction: boolean },
): void {
  db.exec('SAVEPOINT usage_export_invalidations');
  try {
    const initialized = db
      .prepare(
        'SELECT completed_at FROM orchestration_event_store_backfills WHERE name=?',
      )
      .get(USAGE_EXPORT_JOURNAL_MARKER);
    const existing = db
      .prepare(
        "SELECT name,sql FROM sqlite_master WHERE name GLOB 'orchestration_usage_export_*'",
      )
      .all();
    if (existing.length === 0) {
      if (initialized)
        throw new Error(
          'Previously initialized usage export journal is missing; refusing repair',
        );
      db.exec(SCHEMA);
      db.exec('INSERT INTO orchestration_usage_export_state VALUES(1,0,0)');
      db.prepare(
        "INSERT INTO orchestration_event_store_backfills(name,completed_at) VALUES(?,strftime('%Y-%m-%dT%H:%M:%fZ','now'))",
      ).run(USAGE_EXPORT_JOURNAL_MARKER);
    } else {
      if (!initialized)
        throw new Error(
          'Usage export journal initialization evidence is missing; refusing repair',
        );
      const actual = existing.map((row) => {
        if (
          !row ||
          typeof row !== 'object' ||
          !('sql' in row) ||
          typeof row.sql !== 'string'
        )
          throw new Error('Usage export invalidation schema is unavailable');
        return normalize(row.sql);
      });
      if (
        actual.length !== definitions.length ||
        definitions.some((sql) => !actual.includes(normalize(sql)))
      )
        throw new Error(
          'Usage export invalidation schema is incomplete or changed; refusing repair',
        );
    }
    const state = db
      .prepare(
        'SELECT revision,retained_after FROM orchestration_usage_export_state WHERE singleton=1',
      )
      .get();
    if (
      !state ||
      typeof state !== 'object' ||
      !('revision' in state) ||
      typeof state.revision !== 'number' ||
      !Number.isSafeInteger(state.revision) ||
      state.revision < 0 ||
      !('retained_after' in state) ||
      state.retained_after !== Math.max(0, state.revision - 10000)
    )
      throw new Error(
        'Usage export invalidation state is unavailable; refusing repair',
      );
    db.exec('RELEASE usage_export_invalidations');
  } catch (error) {
    if (db.isTransaction)
      db.exec(
        'ROLLBACK TO usage_export_invalidations; RELEASE usage_export_invalidations',
      );
    throw error;
  }
}
