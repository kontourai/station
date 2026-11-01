import type { InterruptTurnResult } from '@kontourai/station-contracts/orchestration';
import type { CanonicalRuntimeEvent } from '@kontourai/station-contracts/runtime-events';
import { z } from 'zod';
import {
  type TransactionalSqliteDatabase,
  writeTransaction,
} from './delegation-result-delivery.js';
import { ownedDescendantsBottomUp } from './ownership-tree.js';
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
  if (result.threadId !== childId)
    throw new Error('Cascade interruption result has a different target.');
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
  return writeTransaction(db, 'cascade_stop_intent', () => {
    // A nested caller may have opened a deferred transaction; take its writer
    // reservation before reading any authority or admission state.
    db.prepare(
      'UPDATE orchestration_stream_identity SET high_water = high_water WHERE singleton = 1',
    ).run();
    const terminal = db
      .prepare(
        "SELECT 1 FROM orchestration_events WHERE id = ? AND thread_id = ? AND (method IN ('session.exited', 'turn.aborted', 'session.cancellation-requested') OR (method = 'session.state-changed' AND session_state = 'canceled'))",
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
  });
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
    !requested &&
    event.method !== 'session.exited' &&
    event.method !== 'turn.aborted' &&
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
      WHERE thread_id = r.thread_id AND global_sequence < ? AND method IN ('turn.started', 'session.started')), 0) LIMIT 1`)
      .get(event.threadId, sequence, sequence)
  )
    return;
  const descendants = ownedDescendantsBottomUp(db, event.threadId, sequence);
  for (const childId of descendants)
    if (!isCascadeStopSettled(db, childId))
      recordCascadeStopIntent(db, event.threadId, childId, event.eventId);
  if (requested)
    recordCascadeStopIntent(db, event.threadId, event.threadId, event.eventId);
}

/** A retained cancellation fence keeps a confirmed stopped child outside new turn admission. */
export function isCascadeStopSettled(
  db: SqliteDatabase,
  childId: string,
): boolean {
  return Boolean(
    db
      .prepare(`SELECT 1 FROM orchestration_cascade_stop_intents i
    JOIN orchestration_cancellation_fences f ON f.thread_id = i.child_session_id AND f.terminal_event_id = i.terminal_event_id
    WHERE i.child_session_id = ? AND i.state = 'completed' LIMIT 1`)
      .get(childId),
  );
}

export function backfillCascadeStopIntents(
  db: TransactionalSqliteDatabase,
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
      SELECT id, thread_id, method, global_sequence, session_state, turn_id FROM orchestration_events
      WHERE method IN ('session.exited', 'turn.aborted', 'session.cancellation-requested')
        OR (method = 'session.state-changed' AND session_state = 'canceled') ORDER BY global_sequence`)
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
      );
  });
}

/** Call while holding the same SQLite writer transaction as admission. */
export function isCancellationFenced(
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
