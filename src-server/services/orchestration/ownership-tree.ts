import type { CanonicalRuntimeEvent } from '@kontourai/station-contracts/runtime-events';
import {
  type TransactionalSqliteDatabase,
  writeTransaction,
} from './delegation-result-delivery.js';
import type { SqliteDatabase } from './sqlite-database.js';

export const OWNERSHIP_TREE_SCHEMA = `CREATE TABLE IF NOT EXISTS orchestration_session_ownership (
  child_session_id TEXT NOT NULL,
  parent_session_id TEXT NOT NULL,
  binding TEXT NOT NULL CHECK (binding IN ('verified', 'claimed')),
  created_seq INTEGER NOT NULL,
  event_id TEXT NOT NULL,
  background_boundary INTEGER NOT NULL CHECK (background_boundary IN (0, 1)),
  PRIMARY KEY (child_session_id, event_id)
);
CREATE INDEX IF NOT EXISTS idx_session_ownership_parent
  ON orchestration_session_ownership(parent_session_id, binding, background_boundary)`;

export interface SessionOwnershipEdge {
  childId: string;
  parentId: string;
  binding: 'verified' | 'claimed';
  createdSequence: number;
  eventId: string;
  backgroundBoundary: boolean;
}

/** Only a start's server-derived initiating Session grants lifecycle authority. */
export function recordSessionOwnership(
  db: SqliteDatabase,
  event: {
    method: CanonicalRuntimeEvent['method'];
    threadId: string;
    eventId: string;
    metadata?: Record<string, unknown>;
  },
  sequence: number,
): void {
  if (
    event.method !== 'session.started' &&
    event.method !== 'session.configured'
  )
    return;
  const metadata = event.metadata;
  const context = metadata?.delegation;
  const delegation =
    context && typeof context === 'object' && !Array.isArray(context)
      ? (context as Record<string, unknown>)
      : undefined;
  const named =
    delegation?.parentConversationId ??
    metadata?.parentConversationId ??
    metadata?.parentTaskId;
  const exactParent = delegation?.parentSessionId;
  const verified =
    event.method === 'session.started' &&
    metadata?.stationDelegationProvenance === 'caller-derived' &&
    typeof exactParent === 'string' &&
    exactParent.length > 0 &&
    !db
      .prepare(
        "SELECT 1 FROM orchestration_events WHERE thread_id = ? AND method = 'session.started' AND global_sequence < ? LIMIT 1",
      )
      .get(event.threadId, sequence) &&
    Boolean(
      db
        .prepare(
          "SELECT 1 FROM orchestration_events WHERE thread_id = ? AND method = 'session.started' AND global_sequence < ? LIMIT 1",
        )
        .get(exactParent, sequence),
    );
  const parent = verified ? exactParent : named;
  if (
    typeof parent !== 'string' ||
    parent.length === 0 ||
    parent === event.threadId
  )
    return;
  db.prepare(
    'INSERT OR IGNORE INTO orchestration_session_ownership VALUES (?, ?, ?, ?, ?, ?)',
  ).run(
    event.threadId,
    parent,
    verified ? 'verified' : 'claimed',
    sequence,
    event.eventId,
    metadata?.backgroundBoundary === true ? 1 : 0,
  );
}

/** The naming index selects source events; naming alone still grants no authority. */
export function backfillSessionOwnership(
  db: TransactionalSqliteDatabase,
): void {
  writeTransaction(db, 'ownership_backfill', () => {
    const rows = db
      .prepare(`SELECT m.event_id, m.child_session_id, m.source_method, m.global_sequence, e.payload
      FROM orchestration_session_parent_mentions m JOIN orchestration_events e ON e.id = m.event_id
      WHERE NOT EXISTS (SELECT 1 FROM orchestration_session_ownership o WHERE o.event_id = m.event_id)
      ORDER BY m.global_sequence`)
      .all();
    for (const row of rows) {
      if (
        row.source_method !== 'session.started' &&
        row.source_method !== 'session.configured'
      )
        continue;
      const payload: unknown = JSON.parse(String(row.payload));
      const metadata =
        payload && typeof payload === 'object' && 'metadata' in payload
          ? payload.metadata
          : undefined;
      if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata))
        continue;
      recordSessionOwnership(
        db,
        {
          method: row.source_method,
          threadId: String(row.child_session_id),
          eventId: String(row.event_id),
          metadata: metadata as Record<string, unknown>,
        },
        Number(row.global_sequence),
      );
    }
  });
}

export function readSessionOwnership(
  db: SqliteDatabase,
  parentId?: string,
): SessionOwnershipEdge[] {
  const rows =
    parentId === undefined
      ? db
          .prepare(
            'SELECT * FROM orchestration_session_ownership ORDER BY created_seq',
          )
          .all()
      : db
          .prepare(
            'SELECT * FROM orchestration_session_ownership WHERE parent_session_id = ? ORDER BY created_seq',
          )
          .all(parentId);
  return rows.map((row) => ({
    childId: String(row.child_session_id),
    parentId: String(row.parent_session_id),
    binding: row.binding as SessionOwnershipEdge['binding'],
    createdSequence: Number(row.created_seq),
    eventId: String(row.event_id),
    backgroundBoundary: row.background_boundary === 1,
  }));
}
