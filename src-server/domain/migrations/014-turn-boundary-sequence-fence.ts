/** Preserve legacy timestamp ordering; only new boundary writers supply a fence. */
export function ensureTurnBoundarySequenceFence(db: {
  prepare(sql: string): { all(): unknown[] };
  exec(sql: string): void;
}): void {
  const hasColumn = () =>
    (
      db
        .prepare('PRAGMA table_info(orchestration_turn_boundaries)')
        .all() as Array<{ name?: string }>
    ).some((column) => column.name === 'created_sequence');
  if (!hasColumn()) {
    try {
      db.exec(
        'ALTER TABLE orchestration_turn_boundaries ADD COLUMN created_sequence INTEGER CHECK (created_sequence >= 0)',
      );
    } catch (error) {
      // Another opener may have completed the same additive upgrade.
      if (!hasColumn()) throw error;
    }
  }
}
