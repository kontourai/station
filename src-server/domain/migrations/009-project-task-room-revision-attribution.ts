/** Durable actor-kind upgrade for atomic Project/Task revision publication. */
export function ensureProjectTaskRoomRevisionAttributionColumn(db: {
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
    ).some((column) => column?.name === 'actor_kind');
  if (!hasColumn())
    try {
      db.exec(
        "ALTER TABLE project_task_room_revision_publication_outbox ADD COLUMN actor_kind TEXT NOT NULL DEFAULT 'human' CHECK(actor_kind IN ('human','agent'))",
      );
    } catch (error) {
      // Two EventStore/worker instances can legitimately race the additive
      // upgrade. Only the exact already-landed column makes that race benign.
      if (!hasColumn()) throw error;
    }
}
