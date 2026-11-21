/**
 * #373: lifetime usage analytics' per-thread fold results, so a pass refolds
 * only the threads whose events changed rather than every usage row the store
 * retains.
 *
 * A cached row is the shared usage fold's output for one thread. A row that
 * is missing means "fold this thread again", which is always correct, so every
 * invalidation here deletes rather than edits:
 *
 * - Appends never touch this table. Every insert takes `high_water + 1` from
 *   `orchestration_stream_identity`, so the reader finds them by
 *   `global_sequence` above the checkpoint's watermark. The append hot path
 *   pays nothing.
 * - Deletes and rewrites invalidate through the triggers, in the writer's own
 *   transaction. That covers thread deletion, a compaction that removes rows
 *   from the middle of a thread (#5078), and a repair that rewrites a row,
 *   whichever connection or Station version performs it.
 *
 * The checkpoint names the projection version it was written under. A
 * different version, or a watermark ahead of the store's high-water (a store
 * that went backwards), makes the reader rebuild from nothing.
 */
export const USAGE_PROJECTION_CACHE_MIGRATION = `
CREATE TABLE IF NOT EXISTS orchestration_usage_projection_cache (
  thread_id TEXT PRIMARY KEY,
  projection TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS orchestration_usage_projection_checkpoint (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  version TEXT NOT NULL,
  watermark INTEGER NOT NULL CHECK (watermark >= 0)
);
CREATE TRIGGER IF NOT EXISTS orchestration_usage_projection_event_deleted
AFTER DELETE ON orchestration_events
BEGIN
  DELETE FROM orchestration_usage_projection_cache WHERE thread_id = OLD.thread_id;
END;
CREATE TRIGGER IF NOT EXISTS orchestration_usage_projection_event_updated
AFTER UPDATE ON orchestration_events
BEGIN
  DELETE FROM orchestration_usage_projection_cache
  WHERE thread_id IN (OLD.thread_id, NEW.thread_id);
END;
`;
