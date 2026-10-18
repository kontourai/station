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
 *  - a single-use SUPPRESSION of the turn it stops. When that turn is not in
 *    the log yet, the suppression waits as the service's own pending
 *    interrupt does: every waiting one binds to the next turn that appears
 *    there within the service's pending-interrupt TTL (so refusing one leaves
 *    the others), and a terminal the service also drops its pending cancel
 *    on (not `runtime.error`), logged on the child's Session whether or not
 *    it settled a turn, drops those still waiting. A transition found late
 *    (after a restart) takes only suppressions older than this process; a
 *    turn running in this process only those made since it started. A
 *    bound one cancels that turn's result only if the turn did not complete
 *    normally (the interrupt stopped it). It is spent by its turn's
 *    settlement, whatever that cancels;
 *  - a LINK from each open row to the token. A row is cancelled while any link
 *    exists. A refusal deletes its own links and unspent suppression, and
 *    reopens a row only if no other link remains and the row is still
 *    `cancelled`: a later read, delivery or second interrupt wins.
 *
 * An interrupt the service reports stopped nothing (`no-active-turn`: no turn
 * running, or not the turn it named) is undone exactly as a refusal is.
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
  deliverSessionMessage,
  parseSessionDeliveryDecision,
  type SessionDeliveryBranch,
  type SessionMessageDeliveryPorts,
  type SessionStartResult,
  type SessionSteerResult,
} from '@kontourai/monument';
import {
  CLIENT_ORIGIN_VERSION,
  type ClientOrigin,
  UNKNOWN_CLIENT_REPORTED_ORIGIN,
} from '@kontourai/station-contracts/client-origin';
import {
  type InterruptTurnResult,
  PENDING_TURN_INTERRUPT_TTL_MS,
} from '@kontourai/station-contracts/orchestration';
import {
  isPrincipalRef,
  type PrincipalRef,
} from '@kontourai/station-contracts/principal';
import {
  isSessionLifecycleState,
  isSessionLifecycleStateAtRest,
} from '@kontourai/station-contracts/session-lifecycle';
import type { StartOwnerAttribution } from './session-owner-attribution.js';
import {
  evaluateSessionWait,
  type SessionSettledTurn,
  type SessionTurnWaitPorts,
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
 * turn's `turn.started`: exactly as long as the orchestration service keeps
 * the interrupt itself armed for a turn that has not started
 * (`PENDING_TURN_INTERRUPT_TTL_MS`). A turn that appears later was not
 * stopped by this interrupt (its pending cancel had expired), so its result
 * is not suppressed. Valid while `now < created + window`, as the service's
 * `expiresAt` is.
 */
export const DELEGATION_RESULT_UNLOGGED_TURN_WINDOW_MS =
  PENDING_TURN_INTERRUPT_TTL_MS;
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
  from_unlogged INTEGER NOT NULL DEFAULT 0,
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

/**
 * Bring a database written by an earlier version of this schema up to date.
 * `CREATE TABLE IF NOT EXISTS` leaves an existing table as it was, so every
 * column added since the tables first shipped is added here when missing.
 * Owners recorded before attribution was stored get `unattributed-agent`:
 * the weakest attribution, never an upgrade. A claimed row an earlier
 * version fenced as cancelled keeps that cancel as a link.
 */
export function migrateDelegationResultSchema(
  db: TransactionalSqliteDatabase,
): void {
  // All or nothing, so a crash cannot leave a column added but not
  // backfilled.
  writeTransaction(db, 'delegation_result_migration', () =>
    migrateDelegationResultSchemaNow(db),
  );
}

/** The EventStore connection, as far as a write transaction needs it. */
export type TransactionalSqliteDatabase = SqliteDatabase & {
  /** node:sqlite: true while any transaction or savepoint is open. */
  readonly isTransaction: boolean;
};

/**
 * Run `run` as one write transaction on a connection a peer runtime may be
 * writing to (a shared STATION_HOME, archive#2895).
 *
 * At top level it is `BEGIN IMMEDIATE`, as `EventStore` opens its own write
 * transactions (`reserveAttachmentCapacity`): the write lock is taken first,
 * through the busy timeout. A deferred transaction (a bare SAVEPOINT) that
 * reads before it writes holds a read snapshot when it asks for the write
 * lock, and SQLite then answers SQLITE_BUSY at once, without consulting the
 * busy handler, whenever a peer holds that lock. Nested in a caller's
 * transaction it is a SAVEPOINT, and the caller owns how the lock was taken.
 */
function writeTransaction<T>(
  db: TransactionalSqliteDatabase,
  savepoint: string,
  run: () => T,
): T {
  if (db.isTransaction) {
    db.exec(`SAVEPOINT ${savepoint}`);
    try {
      const value = run();
      db.exec(`RELEASE ${savepoint}`);
      return value;
    } catch (error) {
      try {
        db.exec(`ROLLBACK TO ${savepoint}`);
        db.exec(`RELEASE ${savepoint}`);
      } catch {
        // The original failure is the one to report.
      }
      throw error;
    }
  }
  db.exec('BEGIN IMMEDIATE');
  try {
    const value = run();
    db.exec('COMMIT');
    return value;
  } catch (error) {
    try {
      // A failure SQLite already rolled back leaves nothing to roll back,
      // and "no transaction is active" must not replace the real error.
      if (db.isTransaction) db.exec('ROLLBACK');
    } catch {
      // The original failure is the one to report.
    }
    throw error;
  }
}

function migrateDelegationResultSchemaNow(db: SqliteDatabase): void {
  db.exec(DELEGATION_RESULT_DELIVERY_SCHEMA);
  const columns = (table: string) =>
    new Set(
      (
        db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]
      ).map((column) => column.name),
    );
  const owners = columns('delegation_result_owners');
  if (!owners.has('owner_attribution'))
    db.exec(
      `ALTER TABLE delegation_result_owners
       ADD COLUMN owner_attribution TEXT NOT NULL DEFAULT 'unattributed-agent'`,
    );
  if (!owners.has('owner_principal_json'))
    db.exec(
      'ALTER TABLE delegation_result_owners ADD COLUMN owner_principal_json TEXT',
    );
  if (!owners.has('last_activity_at'))
    db.exec(
      `ALTER TABLE delegation_result_owners
       ADD COLUMN last_activity_at INTEGER NOT NULL DEFAULT 0`,
    );
  // Every run, not only when the column was just added: an owner left at the
  // column default by an interrupted earlier migration would otherwise read
  // as idle since 1970 and be pruned with its result undelivered.
  db.exec(
    `UPDATE delegation_result_owners SET last_activity_at = armed_at
     WHERE last_activity_at = 0`,
  );
  const deliveries = columns('delegation_result_deliveries');
  if (!deliveries.has('attempts'))
    db.exec(
      `ALTER TABLE delegation_result_deliveries
       ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0`,
    );
  if (!deliveries.has('unconfirmed'))
    db.exec(
      'ALTER TABLE delegation_result_deliveries ADD COLUMN unconfirmed TEXT',
    );
  const suppressions = columns('delegation_result_suppressions');
  if (!suppressions.has('from_unlogged')) {
    db.exec(
      `ALTER TABLE delegation_result_suppressions
       ADD COLUMN from_unlogged INTEGER NOT NULL DEFAULT 0`,
    );
    // An earlier version wrote an unlogged-turn suppression as a row with no
    // turn yet. Left at the default it would read as one that NAMED its
    // turn and cancel even a turn that completed normally. A bound unspent
    // row cannot be told apart from an explicit one and stays explicit.
    db.exec(
      `UPDATE delegation_result_suppressions SET from_unlogged = 1
       WHERE turn_id IS NULL AND spent = 0`,
    );
  }
  db.exec(
    `INSERT OR IGNORE INTO delegation_result_cancel_links
       (child_conversation_id, transition_key, token)
     SELECT child_conversation_id, transition_key, 'migrated-cancel'
     FROM delegation_result_deliveries
     WHERE state = 'claimed' AND fence = 'cancelled'`,
  );
  db.exec(
    `UPDATE delegation_result_deliveries SET fence = NULL
     WHERE state = 'claimed' AND fence = 'cancelled'`,
  );
}

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
  db: TransactionalSqliteDatabase,
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
  /**
   * One transition, all or nothing, holding the write lock from its first
   * statement (see `writeTransaction`): `arm` and `spendSuppressions` read
   * before they write.
   */
  let savepoints = 0;
  const atomically = <T>(run: () => T): T => {
    savepoints += 1;
    return writeTransaction(db, `delegation_result_${savepoints}`, run);
  };
  const unloggedSince = () => now() - DELEGATION_RESULT_UNLOGGED_TURN_WINDOW_MS;
  /** When this store was opened: the start of this process's live events. */
  const openedAt = now();
  /**
   * Forget the unlogged-turn suppressions no turn has taken yet, or only
   * those created before `createdBefore` (see `record`).
   */
  const dropUnbound = (childConversationId: string, createdBefore?: number) =>
    db
      .prepare(
        `DELETE FROM delegation_result_suppressions
         WHERE child_conversation_id = ? AND spent = 0 AND turn_id IS NULL
           AND created_at < ?`,
      )
      .run(childConversationId, createdBefore ?? Number.MAX_SAFE_INTEGER);
  /**
   * A turn is now in the log: drop unlogged-turn suppressions past their
   * window, then bind EVERY one still waiting to this turn, unless one is
   * already bound to it. This mirrors the service, which keeps ONE pending
   * interrupt per thread (a second replaces the first) and applies it to the
   * thread's next `turn.started` only (`CooperativeStop
   * .recordPendingTurnInterrupt` / `applyPendingTurnInterrupt`): however many
   * interrupts preceded this turn, they stop this turn or nothing, so they
   * are bound together, spent together, and none can reach a later turn.
   * Keeping each one (rather than only the newest) is what lets a refusal
   * undo just itself: the service still holds the other interrupt's pending
   * cancel, and its suppression must still be here when that cancel stops
   * the turn, whichever of them was refused.
   *
   * `epoch` is which suppressions this turn may take. A turn running in this
   * process (`since-open`: its `turn.started` or terminal landed live, or it
   * is open in the log) takes only those created since the store opened:
   * the service's pending interrupts are in memory, so one recorded before a
   * restart can no longer stop anything. A transition found late
   * (`before-open`; see `record`) takes only the older ones.
   */
  const bindUnlogged = (
    childConversationId: string,
    turnId: string,
    epoch: 'since-open' | 'before-open',
  ) => {
    db.prepare(
      `DELETE FROM delegation_result_suppressions
       WHERE child_conversation_id = ? AND spent = 0 AND turn_id IS NULL
         AND created_at <= ?`,
    ).run(childConversationId, unloggedSince());
    const bound = db
      .prepare(
        `SELECT 1 AS present FROM delegation_result_suppressions
         WHERE child_conversation_id = ? AND turn_id = ? AND from_unlogged = 1`,
      )
      .get(childConversationId, turnId);
    if (bound) return;
    db.prepare(
      `UPDATE delegation_result_suppressions SET turn_id = ?
       WHERE child_conversation_id = ? AND spent = 0 AND turn_id IS NULL
         AND created_at >= ? AND created_at < ?`,
    ).run(
      turnId,
      childConversationId,
      epoch === 'since-open' ? openedAt : 0,
      epoch === 'since-open' ? Number.MAX_SAFE_INTEGER : openedAt,
    );
  };
  /**
   * Spend every unspent suppression bound to this turn, once, and return the
   * tokens whose cancel applies. The two kinds deliberately differ for a turn
   * that completed normally:
   *  - a suppression for a turn the interrupt NAMED (it was in the log)
   *    cancels the result whatever the outcome: the parent asked to stop that
   *    turn, so even a completion that won the race is not pushed to it;
   *  - an unlogged-turn suppression cancels only a turn that did not complete
   *    normally. It was bound by position (the next turn the log showed), not
   *    by identity, so a turn that completed normally is delivered: either
   *    the interrupt lost the race or that turn was not the one it stopped.
   */
  const spend = (
    childConversationId: string,
    turnId: string,
    outcome: SessionSettledTurn['outcome'],
  ): string[] => {
    const matched = db
      .prepare(
        `SELECT token, from_unlogged FROM delegation_result_suppressions
         WHERE child_conversation_id = ? AND turn_id = ? AND spent = 0`,
      )
      .all(childConversationId, turnId) as {
      token: string;
      from_unlogged: number;
    }[];
    for (const { token } of matched)
      db.prepare(
        'UPDATE delegation_result_suppressions SET spent = 1 WHERE token = ?',
      ).run(token);
    return matched
      .filter(
        (suppression) =>
          suppression.from_unlogged !== 1 || outcome !== 'completed',
      )
      .map((suppression) => suppression.token);
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
      return atomically(() => this.armNow(owner));
    },
    armNow(owner: DelegationResultArm): 'armed' | 'already-armed' | 'capacity' {
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
    /** When this store was opened (see `record`'s `caughtUp`). */
    openedAt,
    /**
     * Insert a transition's row once, and in the same transaction spend the
     * suppressions its turn matches: the row is cancelled and linked to each
     * applying token, so a refused interrupt can reopen it. Returns whether
     * this call wrote the row; a suppression is never spent by a row that
     * was not written.
     *
     * `caughtUp`: the transition is found late, not as its terminal event
     * landed (startup reconciliation, an arm, a read or a reopen got there
     * first). An armed child's terminals are recorded as they land from the
     * moment this store opens, and no interrupt can suppress a child before
     * it is armed, so a late transition's terminal came before either: an
     * unlogged-turn suppression created since the store opened waits for a
     * later turn and is neither bound to this transition nor dropped by it.
     * Only those created before the store opened (whose interrupts may have
     * been for this turn) are. Conversely a transition recorded as it lands
     * binds only suppressions created since the store opened (see
     * `bindUnlogged`).
     */
    record(
      row: Omit<
        DelegationResultRow,
        'fence' | 'decision' | 'unconfirmed' | 'attempts' | 'state'
      >,
      options: { readonly caughtUp?: boolean } = {},
    ): boolean {
      const waitingBefore = options.caughtUp ? openedAt : undefined;
      return atomically(() => {
        const at = now();
        const written =
          changes(
            db
              .prepare(
                `INSERT OR IGNORE INTO delegation_result_deliveries
                   (child_conversation_id, transition_key, transition, parent_conversation_id,
                    child_session_id, child_turn_id, outcome, delivery_id, text, state,
                    created_at, updated_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
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
                at,
                at,
              ),
          ) > 0;
        if (!written) return false;
        if (row.childTurnId) {
          bindUnlogged(
            row.childConversationId,
            row.childTurnId,
            options.caughtUp ? 'before-open' : 'since-open',
          );
          const tokens = spend(
            row.childConversationId,
            row.childTurnId,
            row.outcome,
          );
          for (const token of tokens)
            db.prepare(
              `INSERT OR IGNORE INTO delegation_result_cancel_links
                 (child_conversation_id, transition_key, token) VALUES (?, ?, ?)`,
            ).run(row.childConversationId, row.transitionKey, token);
          if (tokens.length > 0)
            db.prepare(
              `UPDATE delegation_result_deliveries SET state = 'cancelled'
               WHERE child_conversation_id = ? AND transition_key = ?`,
            ).run(row.childConversationId, row.transitionKey);
        }
        // A terminal ends a pending interrupt the turns so far did not take,
        // so a stale cancel cannot reach a turn started later: exactly the
        // terminals on which the service drops its own pending cancel
        // (`turn.completed`, `turn.aborted`, `session.exited`;
        // `CooperativeStop.applyPendingTurnInterrupt`). A `runtime.error`
        // leaves the service's cancel armed for the next turn, so it leaves
        // the suppression waiting for that turn too.
        if (row.outcome !== 'error')
          dropUnbound(row.childConversationId, waitingBefore);
        this.touchOwner(row.childConversationId);
        return true;
      });
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
      return atomically(() => this.consumeNow(childConversationId));
    },
    consumeNow(childConversationId: string): number {
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
      atomically(() => this.beginCancelNow(childConversationId, token, turnId));
    },
    beginCancelNow(
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
             (token, child_conversation_id, turn_id, from_unlogged, created_at)
           VALUES (?, ?, ?, ?, ?)`,
        ).run(
          token,
          childConversationId,
          turnId ?? null,
          turnId === undefined ? 1 : 0,
          at,
        );
    },
    /**
     * The child's Session logged a terminal the service drops its pending
     * cancel on, whether or not it settled a turn: forget the unlogged-turn
     * suppressions still waiting (see `DelegationResultDelivery.onFoldEvent`).
     */
    dropUnboundSuppressions(childConversationId: string): void {
      atomically(() => dropUnbound(childConversationId));
    },
    /**
     * A turn is open in the log, so it runs in this process (a process that
     * died mid-turn left no engine behind): see `bindUnlogged`.
     */
    bindUnloggedSuppressions(
      childConversationId: string,
      turnId: string,
    ): void {
      atomically(() => bindUnlogged(childConversationId, turnId, 'since-open'));
    },
    /** Spend a turn's suppressions; see `spend`. */
    spendSuppressions(
      childConversationId: string,
      turnId: string,
      outcome: SessionSettledTurn['outcome'],
    ): string[] {
      return atomically(() => spend(childConversationId, turnId, outcome));
    },
    /**
     * The interrupt behind `token` was refused: delete its unspent
     * suppression and its links, and reopen a row only when no other link
     * holds it and it is still `cancelled`. A row a read consumed, a
     * delivery claimed, or another interrupt holds stays as it is.
     */
    refuseCancel(token: string): void {
      atomically(() => this.refuseCancelNow(token));
    },
    refuseCancelNow(token: string): void {
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
    prune: () => atomically(prune),
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
    invocationId?: string,
  ): readonly DelegationResultOutputEvent[];
  /** The conversation a Session belongs to (itself when it has none). */
  conversationOf(threadId: string): string;
  /** A conversation's current execution Session. */
  currentSessionId(conversationId: string): string;
  /** Whether the live coordinator holds a turn the log has not shown yet. */
  coordinatorBusy(threadId: string): boolean;
  readInputlessTurnDisposition?: SessionTurnWaitPorts['readInputlessTurnDisposition'];
  readInvocationTerminal?: SessionTurnWaitPorts['readInvocationTerminal'];
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

/** The orchestration service's receipted dispatch, as the steer port uses it. */
export type DelegationResultSteerDispatch = (
  command: {
    readonly type: 'steerTurn';
    readonly threadId: string;
    readonly input: string;
    readonly clientInputId: string;
  },
  context: {
    readonly userId: string;
    readonly ownerAttribution: StartOwnerAttribution;
    readonly principal?: PrincipalRef;
    readonly clientOrigin: ClientOrigin;
  },
) => Promise<{ readonly result?: unknown }>;

/**
 * The steer port over the service's `steerTurn`, as the actor the delegating
 * dispatch carried and with Station's internal origin. A throw may follow an
 * accepted steer, so it is never read as "nothing was sent": it is
 * `indeterminate`, and the steer receipt settles a later re-drive. Only the
 * service's explicit refusals mean no effect.
 */
export function createDelegationResultSteerPort(
  dispatch: DelegationResultSteerDispatch,
): DelegationResultDeliveryPorts['steer'] {
  return async ({ threadId, actor, text, clientInputId }) => {
    let dispatched: { readonly result?: unknown };
    try {
      dispatched = await dispatch(
        { type: 'steerTurn', threadId, input: text, clientInputId },
        {
          userId: actor.userId,
          ownerAttribution: actor.attribution,
          ...(actor.principal ? { principal: actor.principal } : {}),
          clientOrigin: DELEGATION_RESULT_CLIENT_ORIGIN,
        },
      );
    } catch {
      return { outcome: 'indeterminate' };
    }
    const result = dispatched.result as
      | { outcome?: string; turnId?: string }
      | undefined;
    switch (result?.outcome) {
      case 'steered':
        return { outcome: 'steered', turnId: result.turnId ?? '' };
      case 'no-active-turn':
      case 'unsupported-engine':
      case 'concurrent-steer':
        return { outcome: result.outcome };
      default:
        return { outcome: 'indeterminate' };
    }
  };
}

/**
 * The terminals on which the orchestration service drops a pending cancel
 * that no turn has taken (`CooperativeStop.applyPendingTurnInterrupt`); a
 * `runtime.error` leaves it armed.
 */
const PENDING_INTERRUPT_TERMINALS = new Set([
  'turn.completed',
  'turn.aborted',
  'session.exited',
]);

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
  invocationId?: string,
): { text: string; incomplete: boolean } {
  const completed = ports.turnEvents(
    threadId,
    turnId,
    ['turn.completed'],
    1,
    invocationId,
  );
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
    invocationId,
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

type ResultSettlementIdentity =
  | {
      threadId: string;
      kind: 'invocation' | 'native';
      value: string;
      nativeOnlyLegacy?: true;
    }
  | { threadId: string; kind: 'sequence'; value: number };
const RESULT_SETTLEMENT_CODEC = 'station.delegation-result/2';
function settlementKey(identity: ResultSettlementIdentity): string {
  return JSON.stringify([
    RESULT_SETTLEMENT_CODEC,
    identity.threadId,
    identity.kind,
    identity.value,
  ]);
}
function readSettlementIdentity(
  row: DelegationResultRow,
): ResultSettlementIdentity | undefined {
  if (row.transitionKey.startsWith('[')) {
    let decoded: unknown;
    try {
      decoded = JSON.parse(row.transitionKey);
    } catch {
      return undefined;
    }
    if (
      !Array.isArray(decoded) ||
      decoded.length !== 4 ||
      decoded[0] !== RESULT_SETTLEMENT_CODEC ||
      decoded[1] !== row.childSessionId ||
      JSON.stringify(decoded) !== row.transitionKey
    )
      return undefined;
    const threadId = row.childSessionId;
    const kind: unknown = decoded[2];
    const value: unknown = decoded[3];
    if (
      (kind === 'invocation' || kind === 'native') &&
      typeof value === 'string' &&
      value !== '' &&
      (kind !== 'native' || row.childTurnId === value)
    )
      return { threadId, kind, value };
    if (
      kind === 'sequence' &&
      typeof value === 'number' &&
      Number.isSafeInteger(value) &&
      value > 0 &&
      row.childTurnId === undefined
    )
      return { threadId, kind, value };
    return undefined;
  }
  const prefix = `settled:${row.childSessionId}:`;
  if (!row.transitionKey.startsWith(prefix)) return undefined;
  const value = row.transitionKey.slice(prefix.length);
  if (value === row.childTurnId) {
    // Old native and invocation encodings overlap; absence of a witness cannot disambiguate them.
    return value.startsWith('invocation-')
      ? undefined
      : {
          threadId: row.childSessionId,
          kind: 'native',
          value,
          nativeOnlyLegacy: true,
        };
  }
  if (value.startsWith('invocation-') && value.length > 'invocation-'.length)
    return {
      threadId: row.childSessionId,
      kind: 'invocation',
      value: value.slice('invocation-'.length),
    };
  if (row.childTurnId === undefined && /^sequence-[1-9][0-9]*$/.test(value)) {
    const sequence = Number(value.slice('sequence-'.length));
    if (Number.isSafeInteger(sequence))
      return {
        threadId: row.childSessionId,
        kind: 'sequence',
        value: sequence,
      };
  }
  return undefined;
}

function deliveryIdFor(childConversationId: string, transitionKey: string) {
  return `dr-${createHash('sha256').update(`${childConversationId}\u0000${transitionKey}`).digest('hex').slice(0, 40)}`;
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
        this.onFoldEvent(threadId, method);
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
   *
   * `turnId` is the turn the interrupt request names. The service stops only
   * that turn, running or held for it (`CooperativeStop`), so exactly that
   * turn is suppressed, as a turn the interrupt named, whether or not the
   * log shows it yet. While the child has an engine session, a named turn
   * that is not the running one gets `no-active-turn` (unless the stop
   * coalesces onto one already in flight; see {@link settleCancellation}),
   * and {@link settleCancellation} undoes this. A dormant Session (restored
   * at boot, no engine) also gets `no-active-turn`. A Session with no engine
   * that is not dormant gets `pending-turn-start` for any named turn, so the
   * cancel is kept. Accepted
   * gap: a named suppression has no TTL, while the service drops its held
   * stop after `PENDING_TURN_INTERRUPT_TTL_MS`. A named turn that starts only
   * after that is still suppressed; one that never starts sits inert until
   * `prune`.
   */
  beginCancel(
    taskReference: string,
    by: DelegationResultCanceller,
    turnId?: string,
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
      turnId ??
        open ??
        // A turn the coordinator accepted but the log has not shown yet.
        (this.ports.coordinatorBusy(thread) ? undefined : null),
    );
    return cancellation;
  }

  /**
   * The interrupt behind `cancellation` ran: keep its cancel only if the
   * stop did something, as the orchestration service derived it
   * (`InterruptTurnResult`). `no-active-turn` means nothing was interrupted
   * (no turn was running, or the requested turn was not the running one), so
   * the cancel is undone exactly as a refused interrupt's is. Every other
   * outcome is an effect: `cooperative` and `forced` stopped the turn,
   * `pending-turn-start` holds the stop for the turn not yet started, and
   * `turn-completed` means the stop reached the running turn as it finished
   * (a turn the interrupt named is suppressed even then; see `spend`). An
   * outcome the stopping Station did not report keeps the cancel, as before
   * outcomes were reported. Accepted gap: a second stop coalesced onto one
   * already running reports that stop's outcome without checking its own
   * requested turn (`CooperativeStop.interruptUserTurnCooperatively`), so an
   * interrupt naming a stale turn that coalesces onto the user's own Stop
   * keeps its cancel.
   */
  settleCancellation(
    cancellation: DelegationResultCancellation,
    outcome: InterruptTurnResult['outcome'] | undefined,
  ): void {
    if (outcome === 'no-active-turn') this.reopenCancellation(cancellation);
  }

  /** The interrupt was refused or stopped nothing: undo only this cancellation. */
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
      readInvocationTerminal: this.ports.readInvocationTerminal,
      readInputlessTurnDisposition: this.ports.readInputlessTurnDisposition,
      foldEvents: (threadId: string) => this.ports.foldEvents(threadId),
      headSequence: (threadId: string) => this.ports.headSequence(threadId),
      coordinatorBusy: (threadId: string) =>
        this.ports.coordinatorBusy(threadId),
    };
  }

  private onFoldEvent(threadId: string, method: string): void {
    if (this.stopped) return;
    const conversationId = this.ports.conversationOf(threadId);
    if (this.ports.store.owner(conversationId)) {
      this.ports.store.touchOwner(conversationId);
      this.evaluateChild(conversationId, 'live');
      // The service drops its pending cancel on any of these terminals for
      // the thread, settled turn or not (`CooperativeStop
      // .applyPendingTurnInterrupt`): a held dispatch whose Session exits
      // before its `turn.started` settles nothing, so `record` never runs.
      // This event landed after every suppression already recorded.
      if (
        PENDING_INTERRUPT_TERMINALS.has(method) &&
        threadId === this.ports.currentSessionId(conversationId)
      )
        this.ports.store.dropUnboundSuppressions(conversationId);
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
   * outlives the terminal event must not hide a settlement. `live` is the
   * evaluation of an event that just landed; any other finds a transition
   * late (see the store's `record`).
   */
  private evaluateChild(
    childConversationId: string,
    source: 'live' | 'caught-up' = 'caught-up',
  ): void {
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
    if (
      settled.invocationId !== undefined &&
      this.ports.readInvocationTerminal?.(
        thread,
        settled.invocationId,
        settled.turnId,
      )?.kind !== 'found'
    )
      return;
    if (
      settled.invocationId === undefined &&
      this.ports.readInputlessTurnDisposition?.(thread)?.kind !== 'inputless'
    )
      return;
    const identity: ResultSettlementIdentity =
      settled.invocationId !== undefined
        ? { threadId: thread, kind: 'invocation', value: settled.invocationId }
        : settled.turnId !== undefined
          ? { threadId: thread, kind: 'native', value: settled.turnId }
          : { threadId: thread, kind: 'sequence', value: settled.sequence };
    const transitionKey = settlementKey(identity);
    if (this.ports.store.has(childConversationId, transitionKey)) return;
    for (const row of this.ports.store.listForChild(childConversationId)) {
      const retained = readSettlementIdentity(row);
      if (retained && settlementKey(retained) === transitionKey) return;
      if (
        row.childSessionId === thread &&
        row.childTurnId === settled.turnId &&
        (retained === undefined ||
          (retained.kind === 'native' && retained.nativeOnlyLegacy === true) ||
          ((row.state === 'pending' || row.state === 'claimed') &&
            !this.canDeliverRow(row)))
      )
        return;
    }
    const output = settled.turnId
      ? storedTurnOutput(
          this.ports,
          thread,
          settled.turnId,
          settled.invocationId,
        )
      : { text: '', incomplete: false };
    this.ports.store.record(
      {
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
      },
      { caughtUp: source === 'caught-up' },
    );
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

  private canDeliverRow(row: DelegationResultRow): boolean {
    const identity = readSettlementIdentity(row);
    if (!identity) return false;
    if (
      identity.kind !== 'invocation' &&
      this.ports.readInputlessTurnDisposition?.(row.childSessionId)?.kind !==
        'inputless'
    )
      return false;
    if (identity.kind === 'native' && identity.nativeOnlyLegacy) {
      try {
        if (
          this.ports
            .foldEvents(row.childSessionId)
            .some(
              ({ event }) =>
                event.turnId === row.childTurnId &&
                event.invocationId !== undefined,
            )
        )
          return false;
      } catch {
        return false;
      }
    }
    return (
      identity.kind !== 'invocation' ||
      this.ports.readInvocationTerminal?.(
        row.childSessionId,
        identity.value,
        row.childTurnId,
      )?.kind === 'found'
    );
  }

  private async attempt(row: DelegationResultRow): Promise<void> {
    const store = this.ports.store;
    if (!this.canDeliverRow(row)) return;
    const owner = store.owner(row.childConversationId);
    if (!owner) return store.settle(row, 'refused', 'owner-missing');
    let pinned: { branch: SessionDeliveryBranch; threadId: string } | undefined;
    if (row.state === 'pending') {
      if (!store.claim(row)) return;
    } else if (row.state !== 'claimed') return;
    // An attempt that may have landed pins every later one to its branch and
    // Session; otherwise a claimed row re-drives its own recorded decision.
    pinned = parseSessionDeliveryDecision(row.unconfirmed ?? row.decision);
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
        // A refused steer also proves an earlier unconfirmed steer to this
        // Session never landed, because the re-drive reuses its Session,
        // `clientInputId` and text: `steerTurn` reads the steer receipt
        // (`EventStore.readSteerInput`) before any refusal branch
        // (`orchestration-service.ts`, `case 'steerTurn'`), and the receipt
        // is claimed (`claimSteerInput`) before the adapter is called. A
        // steer that reached the engine therefore answers `steered` or
        // `indeterminate` from its receipt, never a refusal. Receipts are
        // removed only with the whole thread (`deleteThread`). See the
        // real-service re-drive tests in
        // `__tests__/delegation-result-delivery.test.ts`.
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

  /**
   * A timer's re-drive. It runs outside any caller, so it never throws and
   * the row stays as it is for the next event or startup. A store closed at
   * shutdown (`node:sqlite` answers `ERR_INVALID_STATE`) is expected and
   * logged as such; any other failure is a defect and is logged with its
   * stack.
   */
  private redrivePending(row: DelegationResultRow): void {
    if (this.stopped) return;
    try {
      const current = this.ports.store.read(
        row.childConversationId,
        row.transitionKey,
      );
      if (current?.state === 'pending') this.drive(current, false);
    } catch (error) {
      const storeClosed =
        (error as { code?: unknown } | null)?.code === 'ERR_INVALID_STATE';
      this.ports.logger.warn(
        storeClosed
          ? 'delegation result re-check skipped: the store is closed'
          : 'delegation result re-check failed',
        {
          deliveryId: row.deliveryId,
          error: error instanceof Error ? error.message : String(error),
          ...(storeClosed
            ? {}
            : { stack: error instanceof Error ? error.stack : undefined }),
        },
      );
    }
  }

  /** Drive a released row again once its current attempt has finished. */
  private recheckSoon(row: DelegationResultRow): void {
    if (this.stopped) return;
    const timer = setTimeout(() => this.redrivePending(row), 0);
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
      () => this.redrivePending(row),
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
