/** Once v5 is used, older writers must not append even after retention. */
export const PROJECT_TASK_ROOM_MEMBERS_MIGRATION = `
BEGIN IMMEDIATE;
CREATE TABLE IF NOT EXISTS project_task_room_member_formats (
 channel_id TEXT PRIMARY KEY, version INTEGER NOT NULL CHECK(version = 5)
);
DROP TRIGGER IF EXISTS project_task_room_v3_writer_fence;
CREATE TRIGGER project_task_room_v3_writer_fence
 BEFORE INSERT ON project_task_room_records
 WHEN EXISTS(SELECT 1 FROM project_task_room_formats WHERE channel_id=NEW.channel_id)
 AND (json_extract(NEW.record_json, '$.schemaVersion') IS NULL OR json_extract(NEW.record_json, '$.schemaVersion') NOT IN ('station.project-task-room/v3', 'station.project-task-room/v4', 'station.project-task-room/v5'))
 BEGIN SELECT RAISE(ABORT, 'room requires v3 writer'); END;
DROP TRIGGER IF EXISTS project_task_room_v4_writer_fence;
CREATE TRIGGER project_task_room_v4_writer_fence
 BEFORE INSERT ON project_task_room_records
 WHEN EXISTS(SELECT 1 FROM project_task_room_attachment_formats WHERE channel_id=NEW.channel_id)
 AND (json_extract(NEW.record_json, '$.schemaVersion') IS NULL OR json_extract(NEW.record_json, '$.schemaVersion') NOT IN ('station.project-task-room/v4', 'station.project-task-room/v5'))
 BEGIN SELECT RAISE(ABORT, 'room requires v4 writer'); END;
CREATE TRIGGER IF NOT EXISTS project_task_room_v5_writer_fence
 BEFORE INSERT ON project_task_room_records
 WHEN EXISTS(SELECT 1 FROM project_task_room_member_formats WHERE channel_id=NEW.channel_id)
 AND json_extract(NEW.record_json, '$.schemaVersion') IS NOT 'station.project-task-room/v5'
 BEGIN SELECT RAISE(ABORT, 'room requires v5 writer'); END;
COMMIT;
`;
