/**
 * Out-of-line runtime event content (docs/design/event-content-spill.md).
 *
 * One row per distinct value per thread. Rows are written in the event
 * append's savepoint and deleted with their thread by `deleteThread`, so a
 * row lives exactly as long as the events that reference it. The digest's
 * preimage includes the kind, so a string and an object with the same JSON
 * text never share a row.
 */
export const EVENT_CONTENT_MIGRATION = `
-- 024-event-content.ts  (orchestration DB)
CREATE TABLE IF NOT EXISTS orchestration_event_content (
  thread_id TEXT NOT NULL,
  digest TEXT NOT NULL CHECK (digest GLOB 'sha256-*' AND length(digest) = 71),
  kind TEXT NOT NULL CHECK (kind IN ('string', 'json')),
  body TEXT NOT NULL,
  bytes INTEGER NOT NULL CHECK (bytes >= 0),
  PRIMARY KEY (thread_id, digest)
) WITHOUT ROWID;
`;

/**
 * Rows whose thread has no events left: an older Station (which knows nothing
 * of this table) deleted the thread after a downgrade. Run once at open.
 */
export const EVENT_CONTENT_ORPHAN_SWEEP = `
DELETE FROM orchestration_event_content
WHERE NOT EXISTS (
  SELECT 1 FROM orchestration_events
  WHERE orchestration_events.thread_id = orchestration_event_content.thread_id
  LIMIT 1
)
`;
