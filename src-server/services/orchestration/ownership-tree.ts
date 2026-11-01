import type { CanonicalRuntimeEvent } from '@kontourai/station-contracts/runtime-events';
import { z } from 'zod';
import {
  type TransactionalSqliteDatabase,
  writeTransaction,
} from './delegation-result-delivery.js';
import type { SqliteDatabase } from './sqlite-database.js';

export const CASCADE_TRIGGER_METHODS: readonly string[] = [
  'session.exited',
  'turn.aborted',
  'session.cancellation-requested',
];
export const SESSION_ACTIVITY_METHODS = [
  'session.started',
  'turn.started',
] as const;
export function cascadeTriggerSql(alias: string): string {
  return `(${alias}.method IN (${CASCADE_TRIGGER_METHODS.map((method) => `'${method}'`).join(', ')}) OR (${alias}.method = 'session.state-changed' AND ${alias}.session_state = 'canceled'))`;
}
export function hasStarted(
  db: SqliteDatabase,
  threadId: string,
  before = Number.MAX_SAFE_INTEGER,
): boolean {
  return Boolean(
    db
      .prepare(
        "SELECT 1 FROM orchestration_events WHERE thread_id = ? AND method = 'session.started' AND global_sequence < ? LIMIT 1",
      )
      .get(threadId, before),
  );
}

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
  ON orchestration_session_ownership(parent_session_id, binding, background_boundary);
CREATE TABLE IF NOT EXISTS orchestration_ownership_starts (
  child_session_id TEXT PRIMARY KEY,
  parent_session_id TEXT NOT NULL,
  created_head INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ownership_starts_parent ON orchestration_ownership_starts(parent_session_id)`;

export interface SessionOwnershipEdge {
  childId: string;
  parentId: string;
  binding: 'verified' | 'claimed';
  createdSequence: number;
  eventId: string;
  backgroundBoundary: boolean;
}

const ownershipRows = z.array(
  z.object({
    child_session_id: z.string(),
    parent_session_id: z.string(),
    binding: z.enum(['verified', 'claimed']),
    created_seq: z.number().int(),
    event_id: z.string(),
    background_boundary: z.union([z.literal(0), z.literal(1)]),
  }),
);
const sourceRows = z.array(
  z.object({
    event_id: z.string(),
    child_session_id: z.string(),
    source_method: z.enum(['session.started', 'session.configured']),
    global_sequence: z.number().int(),
    payload: z
      .string()
      .transform((value) => JSON.parse(value))
      .pipe(
        z.object({ metadata: z.record(z.string(), z.unknown()).optional() }),
      ),
  }),
);

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
    !hasStarted(db, event.threadId, sequence) &&
    hasStarted(db, exactParent, sequence);
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
  if (verified)
    db.prepare(
      'DELETE FROM orchestration_ownership_starts WHERE child_session_id = ?',
    ).run(event.threadId);
}

/** Enroll before the provider effect so cancellation cannot miss a child still starting. */
export function reserveOwnershipStart(
  db: TransactionalSqliteDatabase,
  childId: string,
  metadata?: Record<string, unknown>,
): void {
  const raw = metadata?.delegation;
  if (
    metadata?.stationDelegationProvenance !== 'caller-derived' ||
    metadata?.backgroundBoundary === true ||
    !raw ||
    typeof raw !== 'object' ||
    !('parentSessionId' in raw) ||
    typeof raw.parentSessionId !== 'string'
  )
    return;
  const parentId = raw.parentSessionId;
  writeTransaction(
    db,
    'reserve_ownership_start',
    () => {
      const cancelled = db
        .prepare(`SELECT 1 FROM orchestration_cancellation_fences WHERE thread_id = ?
      UNION ALL SELECT 1 FROM orchestration_events e WHERE e.thread_id = ?
      AND ${cascadeTriggerSql('e')}
      AND e.global_sequence > COALESCE((SELECT MAX(global_sequence) FROM orchestration_events WHERE thread_id = ? AND method IN (${SESSION_ACTIVITY_METHODS.map((method) => `'${method}'`).join(', ')})), 0) LIMIT 1`)
        .get(parentId, parentId, parentId);
      if (cancelled)
        throw new Error(
          'The initiating Session is cancellation-fenced; no child was started.',
        );
      if (hasStarted(db, childId)) return;
      if (!hasStarted(db, parentId))
        throw new Error(
          'The initiating Session is unavailable; no child was started.',
        );
      db.prepare(`INSERT INTO orchestration_ownership_starts VALUES (?, ?,
      (SELECT high_water FROM orchestration_stream_identity WHERE singleton = 1))
      ON CONFLICT(child_session_id) DO NOTHING`).run(childId, parentId);
      const current = z
        .object({ parent_session_id: z.string() })
        .parse(
          db
            .prepare(
              'SELECT parent_session_id FROM orchestration_ownership_starts WHERE child_session_id = ?',
            )
            .get(childId),
        );
      if (current.parent_session_id !== parentId)
        throw new Error('Initiating Session ownership conflicts.');
    },
    'immediate',
  );
}

/** The naming index selects source events; naming alone still grants no authority. */
export function backfillSessionOwnership(
  db: TransactionalSqliteDatabase,
): void {
  writeTransaction(db, 'ownership_backfill', () => {
    const rows = sourceRows.parse(
      db
        .prepare(`SELECT m.event_id, m.child_session_id, m.source_method, m.global_sequence, e.payload
      FROM orchestration_session_parent_mentions m JOIN orchestration_events e ON e.id = m.event_id
      WHERE NOT EXISTS (SELECT 1 FROM orchestration_session_ownership o WHERE o.event_id = m.event_id)
      ORDER BY m.global_sequence`)
        .all(),
    );
    for (const row of rows) {
      recordSessionOwnership(
        db,
        {
          method: row.source_method,
          threadId: row.child_session_id,
          eventId: row.event_id,
          metadata: row.payload.metadata,
        },
        row.global_sequence,
      );
    }
  });
}

function readSessionOwnership(
  db: SqliteDatabase,
  parentId: string,
): SessionOwnershipEdge[] {
  const rows = db
    .prepare(
      'SELECT * FROM orchestration_session_ownership WHERE parent_session_id = ? ORDER BY created_seq',
    )
    .all(parentId);
  return ownershipRows.parse(rows).map((row) => ({
    childId: row.child_session_id,
    parentId: row.parent_session_id,
    binding: row.binding,
    createdSequence: row.created_seq,
    eventId: row.event_id,
    backgroundBoundary: row.background_boundary === 1,
  }));
}

export function ownedDescendantsBottomUp(
  db: SqliteDatabase,
  parentId: string,
  before = Number.MAX_SAFE_INTEGER,
): string[] {
  const seen = new Set<string>([parentId]);
  const ordered: string[] = [];
  const visit = (parent: string) => {
    const children = readSessionOwnership(db, parent)
      .filter(
        (edge) =>
          edge.binding === 'verified' &&
          !edge.backgroundBoundary &&
          !(
            edge.createdSequence >= before &&
            db
              .prepare(`SELECT 1 FROM orchestration_events WHERE thread_id = ?
        AND global_sequence > ? AND global_sequence < ? AND method IN (${SESSION_ACTIVITY_METHODS.map((method) => `'${method}'`).join(', ')}) LIMIT 1`)
              .get(parent, before, edge.createdSequence)
          ),
      )
      .map((edge) => edge.childId);
    const starts = z
      .array(
        z.object({ child_session_id: z.string(), created_head: z.number() }),
      )
      .parse(
        db
          .prepare(
            'SELECT child_session_id, created_head FROM orchestration_ownership_starts WHERE parent_session_id = ?',
          )
          .all(parent),
      );
    children.push(
      ...starts
        .filter((start) => start.created_head < before)
        .map((start) => start.child_session_id),
    );
    for (const child of children) {
      if (seen.has(child)) continue;
      seen.add(child);
      visit(child);
      ordered.push(child);
    }
  };
  visit(parentId);
  return ordered;
}
