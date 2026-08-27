/** One durable, idempotent context-boundary reservation per successor Session. */
export const CONVERSATION_CONTEXT_BOUNDARY_MIGRATION = `
CREATE TABLE IF NOT EXISTS orchestration_conversation_context_boundaries (
  boundary_id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  predecessor_session_id TEXT NOT NULL,
  successor_session_id TEXT NOT NULL UNIQUE,
  idempotency_key TEXT NOT NULL,
  policy TEXT NOT NULL CHECK (policy IN ('continue-from-history', 'empty-next-cold-start')),
  status TEXT NOT NULL CHECK (status IN ('reserved', 'claimed', 'consumed', 'cancelled', 'failed', 'indeterminate')),
  actor_id TEXT NOT NULL,
  client_origin TEXT,
  created_at TEXT NOT NULL,
  claimed_at TEXT,
  start_command_id TEXT,
  consumed_at TEXT,
  UNIQUE (conversation_id, idempotency_key)
);
CREATE INDEX IF NOT EXISTS idx_conversation_context_boundaries_conversation
  ON orchestration_conversation_context_boundaries(conversation_id, created_at ASC);
-- One conversation has exactly one live reset/re-anchor reservation.  A
-- distinct idempotency key must observe the winner rather than mint a sibling.
CREATE UNIQUE INDEX IF NOT EXISTS idx_conversation_context_boundaries_active_conversation
  ON orchestration_conversation_context_boundaries(conversation_id)
  WHERE status IN ('reserved', 'claimed', 'indeterminate');
`;

/** Upgrade a home opened by an earlier build of this unmerged feature safely. */
export function ensureConversationContextBoundaryColumns(db: {
  exec(sql: string): void;
  prepare(sql: string): { all(): unknown[] };
}): void {
  const columns = db
    .prepare('PRAGMA table_info(orchestration_conversation_context_boundaries)')
    .all() as Array<{ name?: string }>;
  if (!columns.some((column) => column.name === 'start_command_id')) {
    db.exec(
      'ALTER TABLE orchestration_conversation_context_boundaries ADD COLUMN start_command_id TEXT',
    );
  }

  // Earlier pre-release homes made predecessor_session_id globally unique.
  // A cancelled unstarted boundary deliberately retires only its lineage edge
  // while retaining its audit marker, so that legacy constraint would prevent
  // a later reset from reserving a fresh successor for the same predecessor.
  // SQLite cannot drop an inline UNIQUE constraint; rebuild this small table
  // transactionally and preserve every audit row exactly.
  const indexes = db
    .prepare('PRAGMA index_list(orchestration_conversation_context_boundaries)')
    .all() as Array<{ name?: string; unique?: number }>;
  const hasLegacyPredecessorUnique = indexes.some((index) => {
    if (!index.unique || !index.name) return false;
    const indexColumns = db
      .prepare(`PRAGMA index_info(${index.name})`)
      .all() as Array<{ name?: string }>;
    return (
      indexColumns.length === 1 &&
      indexColumns[0]?.name === 'predecessor_session_id'
    );
  });
  if (!hasLegacyPredecessorUnique) return;
  db.exec(`
    BEGIN IMMEDIATE;
    CREATE TABLE orchestration_conversation_context_boundaries_rebuilt (
      boundary_id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL,
      predecessor_session_id TEXT NOT NULL,
      successor_session_id TEXT NOT NULL UNIQUE,
      idempotency_key TEXT NOT NULL,
      policy TEXT NOT NULL CHECK (policy IN ('continue-from-history', 'empty-next-cold-start')),
      status TEXT NOT NULL CHECK (status IN ('reserved', 'claimed', 'consumed', 'cancelled', 'failed', 'indeterminate')),
      actor_id TEXT NOT NULL,
      client_origin TEXT,
      created_at TEXT NOT NULL,
      claimed_at TEXT,
      start_command_id TEXT,
      consumed_at TEXT,
      UNIQUE (conversation_id, idempotency_key)
    );
    INSERT INTO orchestration_conversation_context_boundaries_rebuilt
      SELECT boundary_id, conversation_id, predecessor_session_id,
             successor_session_id, idempotency_key, policy, status, actor_id,
             client_origin, created_at, claimed_at, start_command_id,
             consumed_at
        FROM orchestration_conversation_context_boundaries;
    DROP TABLE orchestration_conversation_context_boundaries;
    ALTER TABLE orchestration_conversation_context_boundaries_rebuilt
      RENAME TO orchestration_conversation_context_boundaries;
    CREATE INDEX idx_conversation_context_boundaries_conversation
      ON orchestration_conversation_context_boundaries(conversation_id, created_at ASC);
    CREATE UNIQUE INDEX idx_conversation_context_boundaries_active_conversation
      ON orchestration_conversation_context_boundaries(conversation_id)
      WHERE status IN ('reserved', 'claimed', 'indeterminate');
    COMMIT;
  `);
}
