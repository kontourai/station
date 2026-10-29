/** Save ordinals survive operation pruning and changes to operation encoding. */
export const PROJECT_TASK_ROOM_SAVE_REVISIONS_MIGRATION = `
CREATE TABLE IF NOT EXISTS project_task_room_save_revisions (
  project_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  document_id TEXT NOT NULL,
  revision TEXT NOT NULL,
  ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
  PRIMARY KEY(project_id, task_id, document_id, revision),
  UNIQUE(project_id, task_id, document_id, ordinal)
);
`;
