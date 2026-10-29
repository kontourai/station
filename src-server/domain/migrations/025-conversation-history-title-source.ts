/**
 * #4266: where a runtime conversation's history title came from, so a
 * model-generated title replaces only a title derived from a prompt and never
 * one supplied with the start or set by an agent. Nullable: rows written
 * before this column are prompt- or start-derived, and readers treat a NULL
 * source as replaceable, exactly like `'prompt'`.
 *
 * Values written today (`ConversationHistoryTitleSource` in the event store):
 * `'prompt'`, `'provider'` (a delegation title supplied with the start) and
 * `'generated'`. No CHECK constraint: SQLite cannot widen one without a table
 * rebuild, and only the event store writes the column.
 */
export function ensureConversationHistoryTitleSourceColumn(db: {
  prepare(sql: string): { all(): unknown[] };
  exec(sql: string): void;
}): void {
  const hasColumn = () =>
    (
      db
        .prepare('PRAGMA table_info(orchestration_conversation_history)')
        .all() as Array<{ name?: unknown }>
    ).some((column) => column?.name === 'title_source');
  if (hasColumn()) return;
  try {
    db.exec(
      'ALTER TABLE orchestration_conversation_history ADD COLUMN title_source TEXT',
    );
  } catch (error) {
    // Two EventStore instances can race the additive upgrade; only the
    // already-landed column makes that benign.
    if (!hasColumn()) throw error;
  }
}
