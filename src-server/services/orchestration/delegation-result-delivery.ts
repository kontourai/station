/**
 * #3158: put a delegated task's result into the conversation that delegated
 * it, once, without the parent polling.
 *
 * Who is told. The `POST /delegations` route records ownership when the
 * context `request-delegation.ts` derived from a station-control caller
 * (`caller-derived` provenance) names that caller's own conversation as the
 * parent. Nothing a model writes (`parentTaskId`, a `_delegation` argument, a
 * root conversation id) can name the conversation a result wakes, and a
 * grandchild's result reaches only its own parent. `caller-derived` covers
 * every caller channel, including a copied (`bearer-exposed`) or app-held
 * (`delegated-custody`) token, so the route also records the attribution the
 * dispatch itself carried (`verified-bound` only for a bound caller acting for
 * an authenticated owner, otherwise `unattributed-agent`) and delivery replays
 * exactly that attribution, never a stronger one. That is no more than the
 * same caller can already do with `send_to_session` into its own Session.
 *
 * What triggers it. A child state TRANSITION, read from the durable event log
 * after the event was persisted (the bus publishes after the append) and
 * re-read at startup. Today the only transition is `settled` (the child's
 * current Session has no open turn and its newest turn ended); a later slice
 * adds `needs_input`/`blocked`/`failed` as further transition kinds keyed the
 * same way (#3628).
 *
 * Exactly once. Each transition is one row, keyed by the child conversation
 * and the transition (`settled:<session>:<turn>`), holding the text composed
 * from the child's stored output when the row was written, so every re-drive
 * sends identical text. The row's state is the ONE consumption record that
 * automatic delivery and `get_task` race through:
 *
 *   pending  --claim-->  claimed  --effect-->  delivered
 *      |                    |  (refused, no effect) -> pending, or its fence
 *      |                    |  (indeterminate) stays claimed; re-driven at
 *      |                    |   startup under the SAME delivery id
 *      +-- get_task read -> consumed     +-- interrupt_task -> cancelled
 *
 * A read that arrives while a row is claimed (an effect may be in flight)
 * cannot retract it; it sets a fence the row takes if the attempt turns out to
 * have had no effect. A row that keeps failing, or stays unconfirmed, is
 * settled `undeliverable` after a bounded number of attempts.
 *
 * Cancellation. An `interrupt_task` is recorded before its effect as two
 * kinds of record keyed by that interrupt's own token, so a refused interrupt
 * undoes only itself:
 *  - a single-use SUPPRESSION of the turn it stops (or, when the turn is not
 *    in the log yet, of the turn that appears there within a short window),
 *    spent by the first settlement it matches;
 *  - a LINK from each open row to the token. A row is cancelled while any link
 *    exists. A refusal deletes its own links and unspent suppression, and
 *    reopens a row only if no other link remains and the row is still
 *    `cancelled`: a later read, delivery or second interrupt wins.
 *
 * How it is delivered. Through `deliverSessionMessage` (`auto`): an idle
 * parent gets a new turn; a running one is steered only when its adapter
 * reports mid-turn steer; otherwise the row stays pending and is driven again
 * when the parent's turn ends (the durable next-turn input). The delivery id
 * is the start's `clientTurnId` and the steer's `clientInputId`, and the
 * branch and Session are recorded before the effect. Turn deduplication is
 * per Session, so an unconfirmed start is re-driven only into the Session it
 * named; if the parent has moved to another Session, the row is settled
 * `undeliverable` (possibly delivered) rather than started again.
 */
import { createHash, randomUUID } from 'node:crypto';
import {
  CLIENT_ORIGIN_VERSION,
  type ClientOrigin,
  UNKNOWN_CLIENT_REPORTED_ORIGIN,
} from '@kontourai/station-contracts/client-origin';
import {
  isPrincipalRef,
  type PrincipalRef,
} from '@kontourai/station-contracts/principal';
import {
  isSessionLifecycleState,
  isSessionLifecycleStateAtRest,
} from '@kontourai/station-contracts/session-lifecycle';
import {
  deliverSessionMessage,
  type SessionDeliveryBranch,
  type SessionMessageDeliveryPorts,
  type SessionStartResult,
  type SessionSteerResult,
} from './session-message-delivery.js';
import type { StartOwnerAttribution } from './session-owner-attribution.js';
import {
  evaluateSessionWait,
  type SessionSettledTurn,
  type SessionWaitFoldEvent,
} from './session-turn-wait.js';
import type { SqliteDatabase } from './sqlite-database.js';

/**
 * The origin a delivered result's turn records: Station's own server code,
 * never a person (`isPersonActor` stays false). Which child sent it is the
 * row's record here; projecting it as a turn's sender is #3419's
 * `delegation-result` kind.
 */
export const DELEGATION_RESULT_CLIENT_ORIGIN: ClientOrigin = Object.freeze({
  version: CLIENT_ORIGIN_VERSION,
  actor: Object.freeze({ kind: 'internal' as const }),
  reported: UNKNOWN_CLIENT_REPORTED_ORIGIN,
});

/** The child transitions that produce a delivery. #3628 slice 2 adds more. */
export type DelegationResultTransition = 'settled';

export type DelegationResultState =
  | 'pending'
  | 'claimed'
  | 'delivered'
  | 'consumed'
  | 'cancelled'
  /** The parent no longer belongs to the owner that delegated; never sent. */
  | 'refused'
  /** Bounded attempts ran out; `result_json.reason` says whether it may have landed. */
  | 'undeliverable';

/** The most children one Station tracks; arming past it is refused, not evicted. */
const DELEGATION_RESULT_MAX_OWNERS = 10_000;
/** Settled rows and idle owners are forgotten after this long. */
const DELEGATION_RESULT_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
/** The longest child output a delivery quotes; the rest stays in the child. */
const DELEGATION_RESULT_OUTPUT_MAX_CHARS = 8_000;
/** The most streamed text chunks one turn's output read takes. */
const DELEGATION_RESULT_OUTPUT_MAX_EVENTS = 2_000;
/** Failed or unconfirmed attempts before a row is settled `undeliverable`. */
const DELEGATION_RESULT_MAX_ATTEMPTS = 5;
/** Delays of the bounded re-checks after a refusal or failure. */
const RETRY_DELAYS_MS = [2_000, 10_000, 30_000, 120_000] as const;
/**
 * How long a suppression for a turn the log has not shown yet waits for that
 * turn's `turn.started`. A held turn reaches the log within seconds; a later
 * turn is someone else's and must not be suppressed.
 */
const DELEGATION_RESULT_UNLOGGED_TURN_WINDOW_MS = 120_000;
/** Startup reconciliation yields to the event loop after this many owners. */
const RECONCILE_CHUNK = 200;

export const DELEGATION_RESULT_DELIVERY_SCHEMA = `CREATE TABLE IF NOT EXISTS delegation_result_owners (
  child_conversation_id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  parent_conversation_id TEXT NOT NULL,
  owner_user_id TEXT NOT NULL,
  owner_attribution TEXT NOT NULL,
  owner_principal_json TEXT,
  child_agent TEXT,
  armed_at INTEGER NOT NULL,
  last_activity_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS delegation_result_owners_task
  ON delegation_result_owners (task_id);
CREATE TABLE IF NOT EXISTS delegation_result_deliveries (
  child_conversation_id TEXT NOT NULL,
  transition_key TEXT NOT NULL,
  transition TEXT NOT NULL,
  parent_conversation_id TEXT NOT NULL,
  child_session_id TEXT NOT NULL,
  child_turn_id TEXT,
  outcome TEXT NOT NULL,
  delivery_id TEXT NOT NULL,
  text TEXT NOT NULL,
  state TEXT NOT NULL,
  fence TEXT,
  decision TEXT,
  unconfirmed TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  result_json TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (child_conversation_id, transition_key)
);
CREATE INDEX IF NOT EXISTS delegation_result_deliveries_open
  ON delegation_result_deliveries (state, parent_conversation_id);
CREATE TABLE IF NOT EXISTS delegation_result_suppressions (
  token TEXT PRIMARY KEY,
  child_conversation_id TEXT NOT NULL,
  turn_id TEXT,
  spent INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS delegation_result_suppressions_child
  ON delegation_result_suppressions (child_conversation_id, spent);
CREATE TABLE IF NOT EXISTS delegation_result_cancel_links (
  child_conversation_id TEXT NOT NULL,
  transition_key TEXT NOT NULL,
  token TEXT NOT NULL,
  PRIMARY KEY (child_conversation_id, transition_key, token)
);
CREATE INDEX IF NOT EXISTS delegation_result_cancel_links_token
  ON delegation_result_cancel_links (token)`;

/** Who a delivery acts as: exactly what the delegating dispatch carried. */
export interface DelegationResultActor {
  readonly userId: string;
  readonly attribution: StartOwnerAttribution;
  readonly principal?: PrincipalRef;
}

export interface DelegationResultOwner {
  readonly childConversationId: string;
  readonly taskId: string;
  readonly parentConversationId: string;
  readonly actor: DelegationResultActor;
  readonly childAgent?: string;
}

export type DelegationResultArm = Pick<
  DelegationResultOwner,
  'childConversationId' | 'taskId' | 'parentConversationId' | 'actor'
> & { readonly childAgent?: string };

export interface DelegationResultRow {
  readonly childConversationId: string;
  readonly transitionKey: string;
  readonly transition: DelegationResultTransition;
  readonly parentConversationId: string;
  readonly childSessionId: string;
  readonly childTurnId?: string;
  readonly outcome: SessionSettledTurn['outcome'];
  readonly deliveryId: string;
  readonly text: string;
  readonly state: DelegationResultState;
  readonly fence?: 'consumed';
  readonly decision?: string;
  /** The branch and Session of an attempt that may have landed; sticky. */
  readonly unconfirmed?: string;
  readonly attempts: number;
}

/** Who asked to cancel: the recorded parent conversation, or its owner in person. */
export type DelegationResultCanceller =
  | { readonly kind: 'conversation'; readonly conversationId: string }
  | { readonly kind: 'person'; readonly userId: string };

/** A provisional cancel, undone if the interrupt it guards is refused. */
export interface DelegationResultCancellation {
  readonly childConversationId: string;
  readonly token: string;
}

function changes(result: unknown): number {
  const value = (result as { changes?: number | bigint } | undefined)?.changes;
  return typeof value === 'bigint' ? Number(value) : (value ?? 0);
}

function parsePrincipal(value: unknown): PrincipalRef | undefined {
  if (typeof value !== 'string') return undefined;
  try {
    const parsed: unknown = JSON.parse(value);
    return isPrincipalRef(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/** The durable records; every transition is one conditional UPDATE. */
export function createSqliteDelegationResultStore(
  db: SqliteDatabase,
  now: () => number = () => Date.now(),
) {
  const ownerOf = (row: Record<string, unknown>): DelegationResultOwner => {
    const principal = parsePrincipal(row.owner_principal_json);
    return {
      childConversationId: String(row.child_conversation_id),
      taskId: String(row.task_id),
      parentConversationId: String(row.parent_conversation_id),
      actor: {
        userId: String(row.owner_user_id),
        attribution: row.owner_attribution as StartOwnerAttribution,
        ...(principal ? { principal } : {}),
      },
      ...(row.child_agent ? { childAgent: String(row.child_agent) } : {}),
    };
  };
  const rowOf = (row: Record<string, unknown>): DelegationResultRow => ({
    childConversationId: String(row.child_conversation_id),
    transitionKey: String(row.transition_key),
    transition: row.transition as DelegationResultTransition,
    parentConversationId: String(row.parent_conversation_id),
    childSessionId: String(row.child_session_id),
    ...(row.child_turn_id ? { childTurnId: String(row.child_turn_id) } : {}),
    outcome: row.outcome as SessionSettledTurn['outcome'],
    deliveryId: String(row.delivery_id),
    text: String(row.text),
    state: row.state as DelegationResultState,
    ...(row.fence === 'consumed' ? { fence: 'consumed' as const } : {}),
    ...(row.decision ? { decision: String(row.decision) } : {}),
    ...(row.unconfirmed ? { unconfirmed: String(row.unconfirmed) } : {}),
    attempts: Number(row.attempts ?? 0),
  });
  const rowKey = (
    row: Pick<DelegationResultRow, 'childConversationId' | 'transitionKey'>,
  ) => [row.childConversationId, row.transitionKey];
  const ownerCount = () =>
    (
      db
        .prepare('SELECT COUNT(*) AS total FROM delegation_result_owners')
        .get() as { total: number }
    ).total;
  /** The state a claim falls back to when its attempt had no effect. */
  const RELEASED_STATE = `CASE
    WHEN fence = 'consumed' THEN 'consumed'
    WHEN EXISTS (SELECT 1 FROM delegation_result_cancel_links link
      WHERE link.child_conversation_id = delegation_result_deliveries.child_conversation_id
        AND link.transition_key = delegation_result_deliveries.transition_key)
      THEN 'cancelled'
    ELSE 'pending' END`;
  const readOwner = (childConversationId: string) => {
    const row = db
      .prepare(
        'SELECT * FROM delegation_result_owners WHERE child_conversation_id = ?',
      )
      .get(childConversationId) as Record<string, unknown> | undefined;
    return row ? ownerOf(row) : undefined;
  };
  const prune = () => {
    const cutoff = now() - DELEGATION_RESULT_RETENTION_MS;
    db.prepare(
      `DELETE FROM delegation_result_deliveries
       WHERE updated_at < ? AND state NOT IN ('pending', 'claimed')`,
    ).run(cutoff);
    db.prepare(
      `DELETE FROM delegation_result_cancel_links WHERE NOT EXISTS (
         SELECT 1 FROM delegation_result_deliveries row
         WHERE row.child_conversation_id = delegation_result_cancel_links.child_conversation_id
           AND row.transition_key = delegation_result_cancel_links.transition_key)`,
    ).run();
    db.prepare(
      'DELETE FROM delegation_result_suppressions WHERE created_at < ?',
    ).run(cutoff);
    db.prepare(
      `DELETE FROM delegation_result_owners WHERE last_activity_at < ?
       AND child_conversation_id NOT IN (
         SELECT child_conversation_id FROM delegation_result_deliveries
         WHERE state IN ('pending', 'claimed'))`,
    ).run(cutoff);
  };

  return {
    /**
     * Record ownership once; a later arm of the same child keeps the first.
     * At the cap, expired owners are pruned first; still full is a refusal.
     */
    arm(owner: DelegationResultArm): 'armed' | 'already-armed' | 'capacity' {
      if (readOwner(owner.childConversationId)) return 'already-armed';
      if (ownerCount() >= DELEGATION_RESULT_MAX_OWNERS) {
        prune();
        if (ownerCount() >= DELEGATION_RESULT_MAX_OWNERS) return 'capacity';
      }
      const at = now();
      const inserted = db
        .prepare(
          `INSERT OR IGNORE INTO delegation_result_owners
             (child_conversation_id, task_id, parent_conversation_id, owner_user_id,
              owner_attribution, owner_principal_json, child_agent, armed_at, last_activity_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          owner.childConversationId,
          owner.taskId,
          owner.parentConversationId,
          owner.actor.userId,
          owner.actor.attribution,
          owner.actor.principal ? JSON.stringify(owner.actor.principal) : null,
          owner.childAgent ?? null,
          at,
          at,
        );
      return changes(inserted) > 0 ? 'armed' : 'already-armed';
    },
    owner: readOwner,
    /** The owner a task reference names: its conversation id or task id. */
    ownerByReference(reference: string): DelegationResultOwner | undefined {
      const row = db
        .prepare(
          `SELECT * FROM delegation_result_owners
           WHERE child_conversation_id = ? OR task_id = ? OR task_id = ?
           LIMIT 1`,
        )
        .get(reference, reference, `task:${reference}`) as
        | Record<string, unknown>
        | undefined;
      return row ? ownerOf(row) : undefined;
    },
    listOwners(limit = DELEGATION_RESULT_MAX_OWNERS): DelegationResultOwner[] {
      return (
        db
          .prepare(
            'SELECT * FROM delegation_result_owners ORDER BY armed_at DESC LIMIT ?',
          )
          .all(limit) as Record<string, unknown>[]
      ).map(ownerOf);
    },
    has(childConversationId: string, transitionKey: string): boolean {
      return (
        db
          .prepare(
            `SELECT 1 AS present FROM delegation_result_deliveries
             WHERE child_conversation_id = ? AND transition_key = ?`,
          )
          .get(childConversationId, transitionKey) !== undefined
      );
    },
    /**
     * Insert a transition's row once; returns whether this call wrote it. A
     * row a suppression cancels is linked to each spent suppression's token,
     * so a refused interrupt can reopen it.
     */
    record(
      row: Omit<
        DelegationResultRow,
        'fence' | 'decision' | 'unconfirmed' | 'attempts' | 'state'
      > & { readonly cancelledBy: readonly string[] },
    ): boolean {
      const at = now();
      const written =
        changes(
          db
            .prepare(
              `INSERT OR IGNORE INTO delegation_result_deliveries
                 (child_conversation_id, transition_key, transition, parent_conversation_id,
                  child_session_id, child_turn_id, outcome, delivery_id, text, state,
                  created_at, updated_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            )
            .run(
              row.childConversationId,
              row.transitionKey,
              row.transition,
              row.parentConversationId,
              row.childSessionId,
              row.childTurnId ?? null,
              row.outcome,
              row.deliveryId,
              row.text,
              row.cancelledBy.length > 0 ? 'cancelled' : 'pending',
              at,
              at,
            ),
        ) > 0;
      if (!written) return false;
      for (const token of row.cancelledBy)
        db.prepare(
          `INSERT OR IGNORE INTO delegation_result_cancel_links
             (child_conversation_id, transition_key, token) VALUES (?, ?, ?)`,
        ).run(row.childConversationId, row.transitionKey, token);
      this.touchOwner(row.childConversationId);
      return true;
    },
    /** The owner's child is active: keep it from being pruned as idle. */
    touchOwner(childConversationId: string): void {
      db.prepare(
        `UPDATE delegation_result_owners SET last_activity_at = ?
         WHERE child_conversation_id = ?`,
      ).run(now(), childConversationId);
    },
    read(
      childConversationId: string,
      transitionKey: string,
    ): DelegationResultRow | undefined {
      const row = db
        .prepare(
          `SELECT * FROM delegation_result_deliveries
           WHERE child_conversation_id = ? AND transition_key = ?`,
        )
        .get(childConversationId, transitionKey) as
        | Record<string, unknown>
        | undefined;
      return row ? rowOf(row) : undefined;
    },
    listForChild(childConversationId: string): DelegationResultRow[] {
      return (
        db
          .prepare(
            `SELECT * FROM delegation_result_deliveries
             WHERE child_conversation_id = ? ORDER BY created_at ASC`,
          )
          .all(childConversationId) as Record<string, unknown>[]
      ).map(rowOf);
    },
    /** Rows not yet settled, optionally only those addressed to one parent. */
    listOpen(parentConversationId?: string): DelegationResultRow[] {
      return (
        (parentConversationId === undefined
          ? db
              .prepare(
                `SELECT * FROM delegation_result_deliveries
                 WHERE state IN ('pending', 'claimed') ORDER BY created_at ASC`,
              )
              .all()
          : db
              .prepare(
                `SELECT * FROM delegation_result_deliveries
                 WHERE state IN ('pending', 'claimed') AND parent_conversation_id = ?
                 ORDER BY created_at ASC`,
              )
              .all(parentConversationId)) as Record<string, unknown>[]
      ).map(rowOf);
    },
    /** pending -> claimed; false when a read or interrupt got there first. */
    claim(row: DelegationResultRow): boolean {
      return (
        changes(
          db
            .prepare(
              `UPDATE delegation_result_deliveries SET state = 'claimed', updated_at = ?
               WHERE child_conversation_id = ? AND transition_key = ? AND state = 'pending'`,
            )
            .run(now(), ...rowKey(row)),
        ) > 0
      );
    },
    /** Persist the branch and Session before the effect, so a re-drive pins both. */
    recordDecision(row: DelegationResultRow, decision: string): void {
      db.prepare(
        `UPDATE delegation_result_deliveries SET decision = ?, updated_at = ?
         WHERE child_conversation_id = ? AND transition_key = ? AND state = 'claimed'`,
      ).run(decision, now(), ...rowKey(row));
    },
    delivered(row: DelegationResultRow, result: unknown): void {
      db.prepare(
        `UPDATE delegation_result_deliveries
         SET state = 'delivered', result_json = ?, updated_at = ?
         WHERE child_conversation_id = ? AND transition_key = ? AND state = 'claimed'`,
      ).run(JSON.stringify(result), now(), ...rowKey(row));
    },
    /** A final state for a row that will not be sent (or not again). */
    settle(
      row: DelegationResultRow,
      state: 'refused' | 'undeliverable',
      reason: string,
    ): void {
      db.prepare(
        `UPDATE delegation_result_deliveries
         SET state = ?, result_json = ?, updated_at = ?
         WHERE child_conversation_id = ? AND transition_key = ?
           AND state IN ('pending', 'claimed')`,
      ).run(state, JSON.stringify({ reason }), now(), ...rowKey(row));
    },
    /**
     * claimed -> consumed, cancelled or pending: the attempt provably had no
     * effect, so its branch is forgotten and a read or interrupt that arrived
     * during it now applies. `clearUnconfirmed` only when the refusal proves
     * an earlier unconfirmed attempt never landed either (a steer receipt
     * answering no turn / not supported).
     */
    release(row: DelegationResultRow, clearUnconfirmed = false): void {
      db.prepare(
        `UPDATE delegation_result_deliveries
         SET state = ${RELEASED_STATE}, decision = NULL,
             unconfirmed = CASE WHEN ? THEN NULL ELSE unconfirmed END,
             updated_at = ?
         WHERE child_conversation_id = ? AND transition_key = ? AND state = 'claimed'`,
      ).run(clearUnconfirmed ? 1 : 0, now(), ...rowKey(row));
    },
    /**
     * Count one failed or unconfirmed attempt and return the new total. A
     * failure (no effect) also releases the claim; an unconfirmed attempt
     * keeps it and pins its branch and Session for good (`unconfirmed`), so
     * no later attempt can land in another Session or on another branch.
     */
    countAttempt(row: DelegationResultRow, release: boolean): number {
      db.prepare(
        `UPDATE delegation_result_deliveries
         SET attempts = attempts + 1,
             unconfirmed = CASE WHEN ? THEN unconfirmed ELSE COALESCE(unconfirmed, decision) END,
             state = CASE WHEN ? THEN ${RELEASED_STATE} ELSE state END,
             decision = CASE WHEN ? THEN NULL ELSE decision END,
             updated_at = ?
         WHERE child_conversation_id = ? AND transition_key = ? AND state = 'claimed'`,
      ).run(
        release ? 1 : 0,
        release ? 1 : 0,
        release ? 1 : 0,
        now(),
        ...rowKey(row),
      );
      return (
        this.read(row.childConversationId, row.transitionKey)?.attempts ?? 0
      );
    },
    /**
     * A `get_task` read: every open or provisionally cancelled row of the
     * child is consumed now, a claimed row through its fence. A consumed row
     * is never reopened by a refused interrupt.
     */
    consume(childConversationId: string): number {
      const at = now();
      db.prepare(
        `UPDATE delegation_result_deliveries SET fence = 'consumed', updated_at = ?
         WHERE child_conversation_id = ? AND state = 'claimed'`,
      ).run(at, childConversationId);
      return changes(
        db
          .prepare(
            `UPDATE delegation_result_deliveries SET state = 'consumed', updated_at = ?
             WHERE child_conversation_id = ? AND state IN ('pending', 'cancelled')`,
          )
          .run(at, childConversationId),
      );
    },
    /**
     * An interrupt's provisional cancel: link every open or cancelled row to
     * its token (a claimed row takes the link when it is released), cancel
     * the pending ones, and record its single-use suppression. `turnId`
     * names the turn it stops; `undefined` the turn the log has not shown
     * yet; `null` nothing to suppress.
     */
    beginCancel(
      childConversationId: string,
      token: string,
      turnId: string | undefined | null,
    ): void {
      const at = now();
      db.prepare(
        `INSERT OR IGNORE INTO delegation_result_cancel_links
           (child_conversation_id, transition_key, token)
         SELECT child_conversation_id, transition_key, ?
         FROM delegation_result_deliveries
         WHERE child_conversation_id = ? AND state IN ('pending', 'claimed', 'cancelled')`,
      ).run(token, childConversationId);
      db.prepare(
        `UPDATE delegation_result_deliveries SET state = 'cancelled', updated_at = ?
         WHERE child_conversation_id = ? AND state = 'pending'`,
      ).run(at, childConversationId);
      if (turnId !== null)
        db.prepare(
          `INSERT INTO delegation_result_suppressions
             (token, child_conversation_id, turn_id, created_at) VALUES (?, ?, ?, ?)`,
        ).run(token, childConversationId, turnId ?? null, at);
    },
    /**
     * A turn is now in the log: an unspent suppression waiting for an
     * unlogged turn binds to it, if it is still inside its window. One past
     * the window is dropped: the turn it waited for never came.
     */
    bindUnloggedSuppressions(
      childConversationId: string,
      turnId: string,
    ): void {
      const since = now() - DELEGATION_RESULT_UNLOGGED_TURN_WINDOW_MS;
      db.prepare(
        `UPDATE delegation_result_suppressions SET turn_id = ?
         WHERE child_conversation_id = ? AND spent = 0 AND turn_id IS NULL
           AND created_at >= ?`,
      ).run(turnId, childConversationId, since);
      db.prepare(
        `DELETE FROM delegation_result_suppressions
         WHERE child_conversation_id = ? AND spent = 0 AND turn_id IS NULL
           AND created_at < ?`,
      ).run(childConversationId, since);
    },
    /**
     * Spend every unspent suppression this settlement matches (its turn, or
     * an unlogged turn still inside its window) and return their tokens.
     */
    spendSuppressions(childConversationId: string, turnId: string): string[] {
      const since = now() - DELEGATION_RESULT_UNLOGGED_TURN_WINDOW_MS;
      const tokens = (
        db
          .prepare(
            `SELECT token FROM delegation_result_suppressions
             WHERE child_conversation_id = ? AND spent = 0
               AND (turn_id = ? OR (turn_id IS NULL AND created_at >= ?))`,
          )
          .all(childConversationId, turnId, since) as { token: string }[]
      ).map((row) => row.token);
      for (const token of tokens)
        db.prepare(
          'UPDATE delegation_result_suppressions SET spent = 1 WHERE token = ?',
        ).run(token);
      return tokens;
    },
    /**
     * The interrupt behind `token` was refused: delete its unspent
     * suppression and its links, and reopen a row only when no other link
     * holds it and it is still `cancelled`. A row a read consumed, a
     * delivery claimed, or another interrupt holds stays as it is.
     */
    refuseCancel(token: string): void {
      db.prepare(
        'DELETE FROM delegation_result_suppressions WHERE token = ? AND spent = 0',
      ).run(token);
      const linked = db
        .prepare(
          `SELECT child_conversation_id, transition_key
           FROM delegation_result_cancel_links WHERE token = ?`,
        )
        .all(token) as {
        child_conversation_id: string;
        transition_key: string;
      }[];
      db.prepare(
        'DELETE FROM delegation_result_cancel_links WHERE token = ?',
      ).run(token);
      const at = now();
      for (const row of linked)
        db.prepare(
          `UPDATE delegation_result_deliveries SET state = 'pending', updated_at = ?
           WHERE child_conversation_id = ? AND transition_key = ? AND state = 'cancelled'
             AND NOT EXISTS (SELECT 1 FROM delegation_result_cancel_links link
               WHERE link.child_conversation_id = ? AND link.transition_key = ?)`,
        ).run(
          at,
          row.child_conversation_id,
          row.transition_key,
          row.child_conversation_id,
          row.transition_key,
        );
    },
    prune,
  };
}

export type DelegationResultStore = ReturnType<
  typeof createSqliteDelegationResultStore
>;

/** One persisted event, as the coordinator reads the child's output. */
export interface DelegationResultOutputEvent {
  readonly turnId?: string;
  readonly method: string;
  readonly payload: unknown;
}

export interface DelegationResultDeliveryPorts {
  readonly store: DelegationResultStore;
  /** The Session's lifecycle fold events, oldest first (`ACTIVE_TURN_FOLD_METHODS`). */
  foldEvents(threadId: string): readonly SessionWaitFoldEvent[];
  headSequence(threadId: string): number;
  /** One turn's events of these methods, oldest first, at most `limit`. */
  turnEvents(
    threadId: string,
    turnId: string,
    methods: readonly string[],
    limit: number,
  ): readonly DelegationResultOutputEvent[];
  /** The conversation a Session belongs to (itself when it has none). */
  conversationOf(threadId: string): string;
  /** A conversation's current execution Session. */
  currentSessionId(conversationId: string): string;
  /** Whether the live coordinator holds a turn the log has not shown yet. */
  coordinatorBusy(threadId: string): boolean;
  /** The recorded owner of a Session, read from its start record. */
  sessionOwnerId(threadId: string): string | undefined;
  /**
   * Start a turn on the parent conversation as `actor`. Throws only when the
   * start was cleanly refused (no effect); an uncertain outcome is
   * `indeterminate`.
   */
  start(input: {
    readonly parentConversationId: string;
    readonly threadId: string;
    readonly actor: DelegationResultActor;
    readonly text: string;
    readonly clientTurnId: string;
  }): Promise<SessionStartResult>;
  /** A receipted steer of the parent's running turn; never throws. */
  steer(input: {
    readonly threadId: string;
    readonly actor: DelegationResultActor;
    readonly text: string;
    readonly clientInputId: string;
  }): Promise<SessionSteerResult>;
  /** Called after each canonical event is persisted; returns the unsubscribe. */
  subscribe(
    listener: (event: { threadId: string; method: string }) => void,
  ): () => void;
  readonly logger: {
    warn(message: string, meta?: Record<string, unknown>): void;
  };
  /** Test seam for the bounded retry schedule. */
  readonly retryDelaysMs?: readonly number[];
}

const FOLD_METHODS = new Set([
  'turn.started',
  'turn.completed',
  'turn.aborted',
  'runtime.error',
  'session.exited',
]);

const OUTCOME_WORDS: Record<SessionSettledTurn['outcome'], string> = {
  completed: 'completed',
  aborted: 'was stopped',
  error: 'failed',
  exited: 'ended when its Session exited',
};

const HEADER_OPEN =
  '[Station: the result of a task this Session delegated. Station delivered it; it is not from the person.';
const LINE_TERMINATORS = /\r\n|[\n\r\v\f\u0085\u2028\u2029]/u;

/** One line of display text: no control or line-breaking characters. */
function flat(value: string): string {
  return value
    .replace(/[\p{Cc}\p{Cf}\u2028\u2029]+/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim()
    .slice(0, 200);
}

/**
 * The text the parent's engine is given. The header is fixed text plus
 * JSON-quoted, flattened identifiers (no child-controlled character can end
 * the line), and every output line is prefixed `> `, so whatever the child
 * wrote stays quoted. Compatible with #3419's framing of agent-sent text.
 */
function composeDelegationResultText(input: {
  readonly taskId: string;
  readonly agent?: string;
  readonly childSessionId: string;
  readonly outcome: SessionSettledTurn['outcome'];
  readonly output: string;
  /** The output read stopped at its event bound. */
  readonly outputIncomplete: boolean;
}): string {
  const who = `${input.agent ? `agent ${JSON.stringify(flat(input.agent))}, ` : ''}Session ${JSON.stringify(flat(input.childSessionId))}`;
  const header = `${HEADER_OPEN} Task ${JSON.stringify(flat(input.taskId))} (${who}) ${OUTCOME_WORDS[input.outcome]}.`;
  const output = input.output.trim();
  if (!output)
    return `${header} It recorded no text output; read the task for details.]`;
  const clipped =
    output.length > DELEGATION_RESULT_OUTPUT_MAX_CHARS
      ? output.slice(0, DELEGATION_RESULT_OUTPUT_MAX_CHARS)
      : output;
  const lines = clipped
    .split(LINE_TERMINATORS)
    .map((line) => (line.length === 0 ? '>' : `> ${line}`));
  const tail =
    clipped.length < output.length
      ? `\n[Station: output clipped to ${clipped.length} of ${output.length} characters; the rest is in the task's Session.]`
      : input.outputIncomplete
        ? `\n[Station: output clipped at ${DELEGATION_RESULT_OUTPUT_MAX_EVENTS} streamed chunks; the rest is in the task's Session.]`
        : '';
  return `${header} Its output follows, each line prefixed "> ".]\n${lines.join('\n')}${tail}`;
}

/**
 * The child's stored output for one turn: the engine's own final text
 * (`turn.completed.outputText`) when it recorded one, else the turn's streamed
 * assistant text in order, at most {@link DELEGATION_RESULT_OUTPUT_MAX_EVENTS}
 * chunks. Reasoning is never included.
 */
function storedTurnOutput(
  ports: Pick<DelegationResultDeliveryPorts, 'turnEvents'>,
  threadId: string,
  turnId: string,
): { text: string; incomplete: boolean } {
  const completed = ports.turnEvents(threadId, turnId, ['turn.completed'], 1);
  const outputText = (
    completed[0]?.payload as { outputText?: unknown } | undefined
  )?.outputText;
  if (typeof outputText === 'string' && outputText.trim())
    return { text: outputText, incomplete: false };
  const deltas = ports.turnEvents(
    threadId,
    turnId,
    ['content.text-delta'],
    DELEGATION_RESULT_OUTPUT_MAX_EVENTS + 1,
  );
  return {
    text: deltas
      .slice(0, DELEGATION_RESULT_OUTPUT_MAX_EVENTS)
      .map((event) => {
        const delta = (event.payload as { delta?: unknown }).delta;
        return typeof delta === 'string' ? delta : '';
      })
      .join(''),
    incomplete: deltas.length > DELEGATION_RESULT_OUTPUT_MAX_EVENTS,
  };
}

function deliveryIdFor(childConversationId: string, transitionKey: string) {
  return `dr-${createHash('sha256').update(`${childConversationId}\u0000${transitionKey}`).digest('hex').slice(0, 40)}`;
}

function parseDecision(
  decision: string | undefined,
): { branch: SessionDeliveryBranch; threadId: string } | undefined {
  if (!decision) return undefined;
  const split = decision.indexOf(':');
  const branch = decision.slice(0, split);
  if (split < 1 || (branch !== 'start' && branch !== 'steer')) return undefined;
  return { branch, threadId: decision.slice(split + 1) };
}

const rowKeyOf = (row: DelegationResultRow) =>
  `${row.childConversationId}\u0000${row.transitionKey}`;

export class DelegationResultDelivery {
  private readonly inFlight = new Map<string, Promise<void>>();
  private readonly retries = new Map<
    string,
    { attempt: number; timer: ReturnType<typeof setTimeout> }
  >();
  private unsubscribe: (() => void) | undefined;
  private stopped = false;

  constructor(private readonly ports: DelegationResultDeliveryPorts) {}

  /** Follow persisted events from now on. */
  start(): void {
    this.unsubscribe ??= this.ports.subscribe(({ threadId, method }) => {
      if (!FOLD_METHODS.has(method)) return;
      try {
        this.onFoldEvent(threadId);
      } catch (error) {
        this.ports.logger.warn('delegation result delivery failed', {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    });
  }

  stop(): void {
    this.stopped = true;
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    for (const { timer } of this.retries.values()) clearTimeout(timer);
    this.retries.clear();
  }

  /** Every in-flight drive has finished (tests and orderly shutdown). */
  async idle(): Promise<void> {
    while (this.inFlight.size > 0)
      await Promise.allSettled([...this.inFlight.values()]);
  }

  /**
   * Record that a caller's conversation owns a child's results, then look at
   * the child once: a child that settled before this ran is not missed.
   */
  arm(owner: DelegationResultArm): void {
    const armed = this.ports.store.arm(owner);
    if (armed === 'capacity') {
      this.ports.logger.warn('delegation result ownership capacity reached', {
        limit: DELEGATION_RESULT_MAX_OWNERS,
      });
      return;
    }
    this.evaluateChild(owner.childConversationId);
    this.driveChild(owner.childConversationId);
  }

  /**
   * A `get_task` read by the owning parent that reported the child at rest
   * consumes the transition it saw. The child is evaluated first, from the
   * same store the read used, so a settlement whose event the coordinator
   * has not processed yet is recorded and consumed rather than delivered
   * afterwards.
   */
  recordRead(input: {
    readonly taskReference: string;
    readonly readerConversationId: string;
    readonly status: string;
  }): boolean {
    const owner = this.ports.store.ownerByReference(input.taskReference);
    if (
      !owner ||
      owner.parentConversationId !== input.readerConversationId ||
      !isSessionLifecycleState(input.status) ||
      !isSessionLifecycleStateAtRest(input.status)
    )
      return false;
    this.evaluateChild(owner.childConversationId);
    this.ports.store.consume(owner.childConversationId);
    return true;
  }

  /**
   * `interrupt_task`, before its effect: fence the turn the interrupt will
   * stop (or, if its `turn.started` is not in the log yet, the next turn to
   * settle) and cancel results not yet delivered. Only the recorded parent
   * conversation, or the delegating owner acting in person, may cancel.
   * Returns the cancellation so a refused interrupt can undo it
   * ({@link reopenCancellation}).
   */
  beginCancel(
    taskReference: string,
    by: DelegationResultCanceller,
  ): DelegationResultCancellation | undefined {
    const owner = this.ports.store.ownerByReference(taskReference);
    if (!owner) return undefined;
    if (
      by.kind === 'conversation'
        ? by.conversationId !== owner.parentConversationId
        : by.userId !== owner.actor.userId
    )
      return undefined;
    const thread = this.ports.currentSessionId(owner.childConversationId);
    const open = evaluateSessionWait(
      { ...this.foldPorts(), coordinatorBusy: () => false },
      thread,
      'idle',
      0,
    ).view.openTurnId;
    const cancellation: DelegationResultCancellation = {
      childConversationId: owner.childConversationId,
      token: randomUUID(),
    };
    this.ports.store.beginCancel(
      owner.childConversationId,
      cancellation.token,
      // A turn the coordinator accepted but the log has not shown yet.
      open ?? (this.ports.coordinatorBusy(thread) ? undefined : null),
    );
    return cancellation;
  }

  /** The interrupt was refused: undo only this cancellation. */
  reopenCancellation(cancellation: DelegationResultCancellation): void {
    this.ports.store.refuseCancel(cancellation.token);
    this.evaluateChild(cancellation.childConversationId);
    this.driveChild(cancellation.childConversationId);
  }

  /** Startup: record transitions missed while down, then drive open rows. */
  async reconcile(): Promise<void> {
    this.ports.store.prune();
    let seen = 0;
    for (const owner of this.ports.store.listOwners()) {
      this.evaluateChild(owner.childConversationId);
      seen += 1;
      if (seen % RECONCILE_CHUNK === 0)
        await new Promise<void>((resolve) => setImmediate(resolve));
    }
    for (const row of this.ports.store.listOpen()) this.drive(row, true);
    await this.idle();
  }

  private foldPorts() {
    return {
      foldEvents: (threadId: string) => this.ports.foldEvents(threadId),
      headSequence: (threadId: string) => this.ports.headSequence(threadId),
      coordinatorBusy: (threadId: string) =>
        this.ports.coordinatorBusy(threadId),
    };
  }

  private onFoldEvent(threadId: string): void {
    if (this.stopped) return;
    const conversationId = this.ports.conversationOf(threadId);
    if (this.ports.store.owner(conversationId)) {
      this.ports.store.touchOwner(conversationId);
      this.evaluateChild(conversationId);
      this.driveChild(conversationId);
    }
    // The thread may be a parent whose turn just ended: a queued result can
    // now start its next turn.
    for (const row of this.ports.store.listOpen(conversationId))
      if (row.state === 'pending') this.drive(row, false);
  }

  /**
   * Record the child's current transition, if it has one this store has not
   * seen. The child is read from the log alone: an in-memory "busy" that
   * outlives the terminal event must not hide a settlement.
   */
  private evaluateChild(childConversationId: string): void {
    const owner = this.ports.store.owner(childConversationId);
    if (!owner) return;
    const thread = this.ports.currentSessionId(childConversationId);
    const { view } = evaluateSessionWait(
      { ...this.foldPorts(), coordinatorBusy: () => false },
      thread,
      'turn-settled',
      0,
    );
    if (view.openTurnId)
      this.ports.store.bindUnloggedSuppressions(
        childConversationId,
        view.openTurnId,
      );
    const settled = view.settledTurn;
    if (view.state !== 'idle' || !settled) return;
    const transitionKey = `settled:${thread}:${settled.turnId ?? `sequence-${settled.sequence}`}`;
    if (this.ports.store.has(childConversationId, transitionKey)) return;
    const output = settled.turnId
      ? storedTurnOutput(this.ports, thread, settled.turnId)
      : { text: '', incomplete: false };
    const cancelledBy = settled.turnId
      ? this.ports.store.spendSuppressions(childConversationId, settled.turnId)
      : [];
    this.ports.store.record({
      childConversationId,
      transitionKey,
      transition: 'settled',
      parentConversationId: owner.parentConversationId,
      childSessionId: thread,
      ...(settled.turnId ? { childTurnId: settled.turnId } : {}),
      outcome: settled.outcome,
      deliveryId: deliveryIdFor(childConversationId, transitionKey),
      text: composeDelegationResultText({
        taskId: owner.taskId,
        ...(owner.childAgent ? { agent: owner.childAgent } : {}),
        childSessionId: thread,
        outcome: settled.outcome,
        output: output.text,
        outputIncomplete: output.incomplete,
      }),
      cancelledBy,
    });
  }

  private driveChild(childConversationId: string): void {
    for (const row of this.ports.store.listForChild(childConversationId))
      if (row.state === 'pending') this.drive(row, false);
  }

  /**
   * Run one row's delivery, at most one at a time per row. A claimed row is
   * re-driven only at startup (`redriveClaimed`): it may already have had
   * its effect, and its recorded branch, Session and delivery id make the
   * re-drive land on the same turn or steer receipt rather than a new one.
   */
  private drive(row: DelegationResultRow, redriveClaimed: boolean): void {
    if (this.stopped) return;
    if (row.state === 'claimed' && !redriveClaimed) return;
    const key = rowKeyOf(row);
    if (this.inFlight.has(key)) return;
    const run = this.attempt(row)
      .catch((error) => {
        this.ports.logger.warn('delegation result delivery failed', {
          deliveryId: row.deliveryId,
          error: error instanceof Error ? error.message : String(error),
        });
      })
      .finally(() => this.inFlight.delete(key));
    this.inFlight.set(key, run);
  }

  private async attempt(row: DelegationResultRow): Promise<void> {
    const store = this.ports.store;
    const owner = store.owner(row.childConversationId);
    if (!owner) return store.settle(row, 'refused', 'owner-missing');
    let pinned: { branch: SessionDeliveryBranch; threadId: string } | undefined;
    if (row.state === 'pending') {
      if (!store.claim(row)) return;
    } else if (row.state !== 'claimed') return;
    // An attempt that may have landed pins every later one to its branch and
    // Session; otherwise a claimed row re-drives its own recorded decision.
    pinned = parseDecision(row.unconfirmed ?? row.decision);
    const current = this.ports.currentSessionId(owner.parentConversationId);
    // Turn deduplication is per Session: an unconfirmed start re-driven into
    // a successor Session would start a second turn.
    if (pinned?.branch === 'start' && pinned.threadId !== current)
      return this.giveUp(
        row,
        'parent-session-changed-after-unconfirmed-start (may have been delivered)',
      );
    const threadId = pinned?.threadId ?? current;
    // The parent must still belong to the owner that delegated; a result is
    // never sent into a conversation another principal now owns.
    if (this.ports.sessionOwnerId(threadId) !== owner.actor.userId)
      return store.settle(row, 'refused', 'parent-owner-changed');

    const ports: SessionMessageDeliveryPorts = {
      isBusy: (thread) =>
        !evaluateSessionWait(this.foldPorts(), thread, 'idle', 0).satisfied,
      start: ({ text, clientTurnId }) => {
        if (
          this.ports.currentSessionId(owner.parentConversationId) !== threadId
        )
          throw new Error('The parent moved to another Session.');
        return this.ports.start({
          parentConversationId: owner.parentConversationId,
          threadId,
          actor: owner.actor,
          text,
          clientTurnId,
        });
      },
      steer: ({ threadId: thread, text, clientInputId }) =>
        this.ports.steer({
          threadId: thread,
          actor: owner.actor,
          text,
          clientInputId,
        }),
    };
    let delivery: Awaited<ReturnType<typeof deliverSessionMessage>>;
    try {
      delivery = await deliverSessionMessage(ports, {
        threadId,
        text: row.text,
        mode: 'auto',
        deliveryId: row.deliveryId,
        ...(pinned ? { decided: pinned.branch } : {}),
        recordDecision: (branch) =>
          store.recordDecision(row, `${branch}:${threadId}`),
      });
    } catch (error) {
      // Only a start throws, and only when it was cleanly refused: free the
      // row and count the attempt. Bounded, so a parent that can never take
      // a turn (no Agent binding) settles instead of retrying forever.
      const attempts = store.countAttempt(row, true);
      if (attempts >= DELEGATION_RESULT_MAX_ATTEMPTS)
        return this.giveUp(
          row,
          `start refused: ${error instanceof Error ? error.message : String(error)}`,
        );
      this.scheduleRetry(row, 'failure');
      return;
    }
    switch (delivery.outcome) {
      case 'started':
      case 'steered':
        store.delivered(row, delivery);
        this.clearRetry(row);
        return;
      case 'session_busy':
      case 'no_active_turn':
        // Nothing was sent. Queued for the parent's next turn end. That end
        // may already have been processed while this row was claimed, so an
        // idle parent is re-checked at once; the retry covers a busy flag
        // that outlived the terminal event.
        // A refused steer or busy answer also proves an earlier unconfirmed
        // steer to this Session never landed (its receipt would answer).
        store.release(row, pinned?.branch === 'steer');
        if (!ports.isBusy(threadId)) this.recheckSoon(row);
        else this.scheduleRetry(row, 'busy');
        return;
      case 'indeterminate': {
        // Possibly delivered: never sent again under a new id. The row stays
        // claimed with its branch and is re-driven at the next startup, a
        // bounded number of times.
        const attempts = store.countAttempt(row, false);
        if (attempts >= DELEGATION_RESULT_MAX_ATTEMPTS)
          this.giveUp(row, 'unconfirmed (may have been delivered)');
        return;
      }
    }
  }

  private giveUp(row: DelegationResultRow, reason: string): void {
    this.ports.store.settle(row, 'undeliverable', reason);
    this.clearRetry(row);
    this.ports.logger.warn('delegation result not delivered', {
      deliveryId: row.deliveryId,
      reason,
    });
  }

  /** Drive a released row again once its current attempt has finished. */
  private recheckSoon(row: DelegationResultRow): void {
    if (this.stopped) return;
    const timer = setTimeout(() => {
      const current = this.ports.store.read(
        row.childConversationId,
        row.transitionKey,
      );
      if (current?.state === 'pending') this.drive(current, false);
    }, 0);
    timer.unref?.();
  }

  /**
   * A bounded re-check. Waiting on a busy parent and recovering from refused
   * starts have separate budgets, so waits cannot use up the retries that
   * take a failing row to `undeliverable`.
   */
  private scheduleRetry(
    row: DelegationResultRow,
    kind: 'busy' | 'failure',
  ): void {
    if (this.stopped) return;
    const delays = this.ports.retryDelaysMs ?? RETRY_DELAYS_MS;
    const key = `${kind}\u0000${rowKeyOf(row)}`;
    const attempt = (this.retries.get(key)?.attempt ?? 0) + 1;
    const previous = this.retries.get(key);
    if (previous) clearTimeout(previous.timer);
    if (attempt > delays.length) {
      this.retries.delete(key);
      return;
    }
    const timer = setTimeout(
      () => {
        const current = this.ports.store.read(
          row.childConversationId,
          row.transitionKey,
        );
        if (current?.state === 'pending') this.drive(current, false);
      },
      delays[attempt - 1],
    );
    timer.unref?.();
    this.retries.set(key, { attempt, timer });
  }

  private clearRetry(row: DelegationResultRow): void {
    for (const kind of ['busy', 'failure'] as const) {
      const key = `${kind}\u0000${rowKeyOf(row)}`;
      const retry = this.retries.get(key);
      if (retry) clearTimeout(retry.timer);
      this.retries.delete(key);
    }
  }
}
