/** Preserve v2/v3 records and fence older writers once a room uses attachments. */
export const PROJECT_TASK_ROOM_ATTACHMENTS_MIGRATION = `
BEGIN IMMEDIATE;
CREATE TABLE IF NOT EXISTS project_task_room_attachment_formats (
 channel_id TEXT PRIMARY KEY, version INTEGER NOT NULL CHECK(version = 4)
);
DROP TRIGGER IF EXISTS project_task_room_v3_writer_fence;
CREATE TRIGGER project_task_room_v3_writer_fence
 BEFORE INSERT ON project_task_room_records
 WHEN EXISTS(SELECT 1 FROM project_task_room_formats WHERE channel_id=NEW.channel_id)
 AND (json_extract(NEW.record_json, '$.schemaVersion') IS NULL OR json_extract(NEW.record_json, '$.schemaVersion') NOT IN ('station.project-task-room/v3', 'station.project-task-room/v4'))
 BEGIN SELECT RAISE(ABORT, 'room requires v3 writer'); END;
CREATE TRIGGER IF NOT EXISTS project_task_room_v4_writer_fence
 BEFORE INSERT ON project_task_room_records
 WHEN EXISTS(SELECT 1 FROM project_task_room_attachment_formats WHERE channel_id=NEW.channel_id)
 AND json_extract(NEW.record_json, '$.schemaVersion') IS NOT 'station.project-task-room/v4'
 BEGIN SELECT RAISE(ABORT, 'room requires v4 writer'); END;
COMMIT;
`;
