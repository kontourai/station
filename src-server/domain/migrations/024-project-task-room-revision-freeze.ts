/** Keep legacy outboxes claimed: a freeze may have committed before its mark. */
export function ensureProjectTaskRoomRevisionFreezeColumn(db: {
  prepare(sql: string): { all(): unknown[] };
  exec(sql: string): void;
}): void {
  const hasColumn = () =>
    (
      db
        .prepare(
          'PRAGMA table_info(project_task_room_revision_publication_outbox)',
        )
        .all() as Array<{ name?: unknown }>
    ).some((column) => column?.name === 'freeze_requested');
  if (!hasColumn()) {
    try {
      db.exec(
        'ALTER TABLE project_task_room_revision_publication_outbox ADD COLUMN freeze_requested INTEGER NOT NULL DEFAULT 1 CHECK(freeze_requested IN (0,1))',
      );
    } catch (error) {
      if (!hasColumn()) throw error;
    }
  }
}
