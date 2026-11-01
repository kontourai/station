import type { KernelCommand } from '@kontourai/monument';
import type { InterruptTurnResult } from '@kontourai/station-contracts/orchestration';
import type { CanonicalRuntimeEvent } from '@kontourai/station-contracts/runtime-events';
import { z } from 'zod';
import {
  type TransactionalSqliteDatabase,
  writeTransaction,
} from './delegation-result-delivery.js';
import {
  CASCADE_TRIGGER_METHODS,
  cascadeTriggerSql,
  ownedDescendantsBottomUp,
  SESSION_ACTIVITY_METHODS,
} from './ownership-tree.js';
import {
  ACTIVE_TURN_FOLD_METHODS,
  interruptibleTurnIdForEvents,
} from './session-lifecycle-service.js';
import type { SqliteDatabase } from './sqlite-database.js';

export const CANCELLATION_FENCE_SCHEMA = `CREATE TABLE IF NOT EXISTS orchestration_cancellation_fences (
  thread_id TEXT NOT NULL,
  terminal_event_id TEXT NOT NULL,
  PRIMARY KEY (thread_id, terminal_event_id)
);
CREATE TABLE IF NOT EXISTS orchestration_cascade_stop_intents (
  parent_session_id TEXT NOT NULL,
  child_session_id TEXT NOT NULL,
  terminal_event_id TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('pending', 'completed')),
  PRIMARY KEY (child_session_id, terminal_event_id)
) ;
CREATE TABLE IF NOT EXISTS orchestration_cascade_stop_custody (
  child_session_id TEXT NOT NULL,
  terminal_event_id TEXT NOT NULL,
  custody TEXT NOT NULL CHECK (custody IN ('local', 'peer', 'unknown')),
  evidence_json TEXT NOT NULL,
  PRIMARY KEY (child_session_id, terminal_event_id)
) ;
CREATE TABLE IF NOT EXISTS orchestration_cascade_stop_results (
  child_session_id TEXT NOT NULL,
  terminal_event_id TEXT NOT NULL,
  result_json TEXT NOT NULL,
  PRIMARY KEY (child_session_id, terminal_event_id)
)`;

const interruptResult = z.discriminatedUnion('outcome', [
  z.object({
    outcome: z.literal('cooperative'),
    threadId: z.string(),
    turnId: z.string(),
  }),
  z.object({
    outcome: z.literal('forced'),
    threadId: z.string(),
    turnId: z.string(),
  }),
  z.object({
    outcome: z.literal('turn-completed'),
    threadId: z.string(),
    turnId: z.string(),
  }),
  z.object({ outcome: z.literal('pending-turn-start'), threadId: z.string() }),
  z.object({ outcome: z.literal('no-active-turn'), threadId: z.string() }),
]);

export function readCascadeInterruptResult(
  db: SqliteDatabase,
  childId: string,
  terminalId: string,
): InterruptTurnResult | undefined {
  const row = z
    .object({ result_json: z.string() })
    .optional()
    .parse(
      db
        .prepare(
          'SELECT result_json FROM orchestration_cascade_stop_results WHERE child_session_id = ? AND terminal_event_id = ?',
        )
        .get(childId, terminalId),
    );
  if (!row) return undefined;
  const result = interruptResult.parse(JSON.parse(row.result_json));
  return result;
}

export function completeCascadeStop(
  db: TransactionalSqliteDatabase,
  childId: string,
  terminalId: string,
  result?: InterruptTurnResult,
): void {
  writeTransaction(db, 'complete_cascade_stop', () => {
    if (result && result.threadId !== childId)
      throw new Error('Cascade interruption result has a different target.');
    if (result)
      db.prepare(
        'INSERT OR IGNORE INTO orchestration_cascade_stop_results VALUES (?, ?, ?)',
      ).run(childId, terminalId, JSON.stringify(result));
    db.prepare(
      "UPDATE orchestration_cascade_stop_intents SET state = 'completed' WHERE child_session_id = ? AND terminal_event_id = ?",
    ).run(childId, terminalId);
    db.prepare(`DELETE FROM orchestration_cancellation_fences WHERE thread_id = ? AND terminal_event_id = ?
      AND EXISTS (SELECT 1 FROM orchestration_cascade_stop_intents WHERE child_session_id = ? AND parent_session_id = ? AND terminal_event_id = ? AND state = 'completed')`).run(
      childId,
      terminalId,
      childId,
      childId,
      terminalId,
    );
  });
}

export function recordCascadeStopIntent(
  db: TransactionalSqliteDatabase,
  parentId: string,
  childId: string,
  terminalId: string,
): boolean {
  return writeTransaction(
    db,
    'cascade_stop_intent',
    () => {
      const terminal = db
        .prepare(
          `SELECT 1 FROM orchestration_events e WHERE id = ? AND thread_id = ? AND ${cascadeTriggerSql('e')}`,
        )
        .get(terminalId, parentId);
      if (!terminal) throw new Error('Cascade parent terminal is unavailable.');
      const existing = db
        .prepare(
          'SELECT parent_session_id, state FROM orchestration_cascade_stop_intents WHERE child_session_id = ? AND terminal_event_id = ?',
        )
        .get(childId, terminalId) as
        | { parent_session_id: string; state: string }
        | undefined;
      if (existing && existing.parent_session_id !== parentId)
        throw new Error('Cascade intent parent conflict.');
      db.prepare(
        'INSERT OR IGNORE INTO orchestration_cascade_stop_intents VALUES (?, ?, ?, ?)',
      ).run(parentId, childId, terminalId, 'pending');
      if (parentId === childId && existing?.state === 'completed') return false;
      db.prepare(
        'INSERT OR IGNORE INTO orchestration_cancellation_fences VALUES (?, ?)',
      ).run(childId, terminalId);
      return existing === undefined;
    },
    'immediate',
  );
}

export function deriveCascadeStopIntents(
  db: TransactionalSqliteDatabase,
  event: {
    method: string;
    eventId: string;
    threadId: string;
    sessionState?: string;
    turnId?: string;
  },
  sequence: number,
  settled: (childId: string) => boolean,
): void {
  const requested = event.method === 'session.cancellation-requested';
  if (requested && event.turnId) {
    // Validate the committed prefix under the writer lock, including on replay.
    const prefix = z.array(z.object({ payload: z.string() })).parse(
      db
        .prepare(`SELECT payload FROM orchestration_events
      WHERE thread_id = ? AND global_sequence < ? AND method IN (${ACTIVE_TURN_FOLD_METHODS.map(() => '?').join(',')}) ORDER BY global_sequence`)
        .all(event.threadId, sequence, ...ACTIVE_TURN_FOLD_METHODS),
    );
    if (
      interruptibleTurnIdForEvents(
        prefix.map(
          ({ payload }) => JSON.parse(payload) as CanonicalRuntimeEvent,
        ),
      ) !== event.turnId
    )
      throw new Error(
        'Cascade interrupt target is no longer active; no child stop was recorded.',
      );
  }
  if (
    !CASCADE_TRIGGER_METHODS.includes(event.method) &&
    !(
      event.method === 'session.state-changed' &&
      event.sessionState === 'canceled'
    )
  )
    return;
  // An ancestor's durable request already includes this fenced subtree.
  if (!requested && isCancellationFenced(db, event.threadId)) return;
  if (
    !requested &&
    db
      .prepare(`SELECT 1 FROM orchestration_events r WHERE r.thread_id = ?
    AND r.method = 'session.cancellation-requested' AND r.global_sequence < ?
    AND r.global_sequence > COALESCE((SELECT MAX(global_sequence) FROM orchestration_events
      WHERE thread_id = r.thread_id AND global_sequence < ? AND method IN (${SESSION_ACTIVITY_METHODS.map((method) => `'${method}'`).join(', ')})), 0) LIMIT 1`)
      .get(event.threadId, sequence, sequence)
  )
    return;
  const descendants = ownedDescendantsBottomUp(db, event.threadId, sequence);
  for (const childId of descendants)
    if (!settled(childId))
      recordCascadeStopIntent(db, event.threadId, childId, event.eventId);
  if (requested)
    recordCascadeStopIntent(db, event.threadId, event.threadId, event.eventId);
}

const cascadeFactsRows = z.array(
  z.object({
    child_id: z.string(),
    confirmed_stop: z.number(),
    terminal: z.number(),
    active: z.number(),
    owner_json: z.string().nullable(),
  }),
);
const boundaryOwner = z.object({
  id: z.string(),
  pid: z.number(),
  birth: z.string().nullable(),
  identityKind: z.string(),
});
export interface CascadeSessionFacts {
  childId: string;
  confirmedStop: boolean;
  terminal: boolean;
  active: boolean;
  owner?: z.infer<typeof boundaryOwner>;
}

export function readCascadeSessionFacts(
  db: SqliteDatabase,
  childIds: readonly string[],
): Map<string, CascadeSessionFacts> {
  const result = new Map<string, CascadeSessionFacts>();
  const unique = [...new Set(childIds)];
  for (let offset = 0; offset < unique.length; offset += 500) {
    const chunk = unique.slice(offset, offset + 500);
    const rows = cascadeFactsRows.parse(
      db
        .prepare(`WITH requested(child_id) AS (VALUES ${chunk.map(() => '(?)').join(', ')})
      SELECT r.child_id,
        EXISTS (SELECT 1 FROM orchestration_cascade_stop_intents i
          JOIN orchestration_cancellation_fences f ON f.thread_id = i.child_session_id AND f.terminal_event_id = i.terminal_event_id
          WHERE i.child_session_id = r.child_id AND i.state = 'completed') AS confirmed_stop,
        EXISTS (SELECT 1 FROM orchestration_events e WHERE e.thread_id = r.child_id AND (e.method = 'session.exited' OR EXISTS (SELECT 1 FROM orchestration_cascade_stop_intents done WHERE done.child_session_id = r.child_id AND done.terminal_event_id = e.id AND done.state = 'completed'))
          AND e.global_sequence > MAX(
            COALESCE((SELECT MAX(global_sequence) FROM orchestration_events WHERE thread_id = r.child_id AND method IN (${SESSION_ACTIVITY_METHODS.map((method) => `'${method}'`).join(', ')})), 0),
            COALESCE(b.created_sequence, 0),
            COALESCE((SELECT created_head FROM orchestration_ownership_starts WHERE child_session_id = r.child_id), 0)
          )) AS terminal,
        (s.status = 'running' OR b.state IN ('prepared', 'invoking', 'accepted', 'indeterminate')
          OR EXISTS (SELECT 1 FROM orchestration_ownership_starts WHERE child_session_id = r.child_id)) IS TRUE AS active,
        CASE WHEN b.boundary_id IS NULL THEN NULL ELSE json_object('id', b.owner_id, 'pid', b.owner_pid,
          'birth', b.owner_birth, 'identityKind', b.owner_identity_kind) END AS owner_json
      FROM requested r LEFT JOIN orchestration_turn_boundaries b ON b.thread_id = r.child_id
      LEFT JOIN provider_session_state s ON s.thread_id = r.child_id`)
        .all(...chunk),
    );
    for (const row of rows)
      result.set(row.child_id, {
        childId: row.child_id,
        confirmedStop: Boolean(row.confirmed_stop),
        terminal: Boolean(row.terminal),
        active: Boolean(row.active),
        ...(row.owner_json === null
          ? {}
          : { owner: boundaryOwner.parse(JSON.parse(row.owner_json)) }),
      });
  }
  return result;
}

/** A current terminal ends its old owner claim; a held binding still requires teardown. */
export function isCascadeStopSettled(
  facts: CascadeSessionFacts,
  locallyHeld: boolean,
): boolean {
  return facts.confirmedStop || (facts.terminal && !locallyHeld);
}

export function backfillCascadeStopIntents(
  db: TransactionalSqliteDatabase,
  settled: (childId: string) => boolean,
): void {
  writeTransaction(db, 'cascade_recovery', () => {
    const rows = z
      .array(
        z.object({
          id: z.string(),
          thread_id: z.string(),
          method: z.string(),
          global_sequence: z.number().int(),
          session_state: z.string().nullable(),
          turn_id: z.string().nullable(),
        }),
      )
      .parse(
        db
          .prepare(`
      SELECT id, thread_id, method, global_sequence, session_state, turn_id FROM orchestration_events e
      WHERE ${cascadeTriggerSql('e')} ORDER BY global_sequence`)
          .all(),
      );
    for (const row of rows)
      deriveCascadeStopIntents(
        db,
        {
          method: row.method,
          eventId: row.id,
          threadId: row.thread_id,
          ...(row.session_state ? { sessionState: row.session_state } : {}),
          ...(row.turn_id ? { turnId: row.turn_id } : {}),
        },
        row.global_sequence,
        settled,
      );
  });
}

/** Call while holding the same SQLite writer transaction as admission. */
function isCancellationFenced(
  db: SqliteDatabase,
  threadId: string,
): boolean {
  return Boolean(
    db
      .prepare(
        'SELECT 1 FROM orchestration_cancellation_fences WHERE thread_id = ? LIMIT 1',
      )
      .get(threadId),
  );
}

export function isCancellationAdmissionBlocked(
  db: SqliteDatabase,
  command: KernelCommand,
): boolean {
  if (command.type === 'turnBoundary.create')
    return (
      command.state !== 'lifecycle' &&
      isCancellationFenced(db, command.threadId)
    );
  if (
    command.type !== 'turnBoundary.beginInvocation' &&
    command.type !== 'turnBoundary.resumePrepared' &&
    !(command.type === 'turnBoundary.transition' && command.to === 'invoking')
  )
    return false;
  const row = z
    .object({ thread_id: z.string(), state: z.string() })
    .optional()
    .parse(
      db
        .prepare(
          'SELECT thread_id, state FROM orchestration_turn_boundaries WHERE boundary_id = ?',
        )
        .get(command.boundaryId),
    );
  return (
    row !== undefined &&
    row.state !== 'lifecycle' &&
    isCancellationFenced(db, row.thread_id)
  );
}
