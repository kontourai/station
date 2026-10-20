/** NULL legacy digests remain unknown: a retry cannot establish the original input. */
export function ensureTurnDedupInputDigest(db: {
  prepare(sql: string): { all(): unknown[] };
  exec(sql: string): void;
}): void {
  const hasColumn = () =>
    (
      db.prepare('PRAGMA table_info(orchestration_turn_dedup)').all() as Array<{
        name?: string;
      }>
    ).some((column) => column.name === 'input_digest');
  if (!hasColumn()) {
    try {
      db.exec(
        'ALTER TABLE orchestration_turn_dedup ADD COLUMN input_digest TEXT',
      );
    } catch (error) {
      if (!hasColumn()) throw error;
    }
  }
}
