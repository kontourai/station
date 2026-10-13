/**
 * #3158: put a delegated task's result into the conversation that delegated
 * it, once, without the parent polling.
 *
 * Who is told. Ownership is recorded by the `POST /delegations` route from
 * the context `request-delegation.ts` DERIVED for a verified station-control
 * caller (`caller-derived` provenance): the child's immediate parent is that
 * caller's own conversation. Nothing a model writes (`parentTaskId`, a
 * `_delegation` argument, a root conversation id) can name the conversation a
 * result wakes, and a grandchild's result reaches only its own parent.
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
 * A read or an interrupt that arrives while a row is claimed (an effect may be
 * in flight) cannot retract it; it sets a fence the row takes if the attempt
 * turns out to have had no effect.
 *
 * How it is delivered. Through `deliverSessionMessage` (`auto`): an idle
 * parent gets a new turn; a running one is steered only when its adapter
 * reports mid-turn steer; otherwise the row stays pending and is driven again
 * when the parent's turn ends (the durable next-turn input). The delivery id
 * is the start's `clientTurnId` and the steer's `clientInputId`, and the
 * branch is recorded before its effect, so a re-drive cannot deliver twice.
 */
import { createHash } from 'node:crypto';
import {
  CLIENT_ORIGIN_VERSION,
  type ClientOrigin,
  UNKNOWN_CLIENT_REPORTED_ORIGIN,
} from '@kontourai/station-contracts/client-origin';
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
  | 'refused';

/** The most children one Station tracks; arming past it is refused, not evicted. */
const DELEGATION_RESULT_MAX_OWNERS = 10_000;
/** Settled rows and their owners are forgotten after this long. */
const DELEGATION_RESULT_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
/** The longest child output a delivery quotes; the rest stays in the child. */
const DELEGATION_RESULT_OUTPUT_MAX_CHARS = 8_000;
/** Bounded retries of a delivery a start refused without effect. */
const RETRY_DELAYS_MS = [2_000, 10_000, 30_000, 120_000] as const;

export const DELEGATION_RESULT_DELIVERY_SCHEMA = `CREATE TABLE IF NOT EXISTS delegation_result_owners (
  child_conversation_id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  parent_conversation_id TEXT NOT NULL,
  owner_user_id TEXT NOT NULL,
  child_agent TEXT,
  suppressed_turn_id TEXT,
  armed_at INTEGER NOT NULL
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
  result_json TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (child_conversation_id, transition_key)
);
CREATE INDEX IF NOT EXISTS delegation_result_deliveries_open
  ON delegation_result_deliveries (state, parent_conversation_id)`;

export interface DelegationResultOwner {
  readonly childConversationId: string;
  readonly taskId: string;
  readonly parentConversationId: string;
  readonly ownerUserId: string;
  readonly childAgent?: string;
  readonly suppressedTurnId?: string;
}

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
  readonly fence?: 'consumed' | 'cancelled';
  readonly decision?: string;
}

function changes(result: unknown): number {
  const value = (result as { changes?: number | bigint } | undefined)?.changes;
  return typeof value === 'bigint' ? Number(value) : (value ?? 0);
}

/** The durable records; every transition is one conditional UPDATE. */
export function createSqliteDelegationResultStore(
  db: SqliteDatabase,
  now: () => number = () => Date.now(),
) {
  const ownerOf = (row: Record<string, unknown>): DelegationResultOwner => ({
    childConversationId: String(row.child_conversation_id),
    taskId: String(row.task_id),
    parentConversationId: String(row.parent_conversation_id),
    ownerUserId: String(row.owner_user_id),
    ...(row.child_agent ? { childAgent: String(row.child_agent) } : {}),
    ...(row.suppressed_turn_id
      ? { suppressedTurnId: String(row.suppressed_turn_id) }
      : {}),
  });
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
    ...(row.fence ? { fence: row.fence as 'consumed' | 'cancelled' } : {}),
    ...(row.decision ? { decision: String(row.decision) } : {}),
  });
  const rowKey = (
    row: Pick<DelegationResultRow, 'childConversationId' | 'transitionKey'>,
  ) => [row.childConversationId, row.transitionKey];

  return {
    /** Record ownership once; a later arm of the same child keeps the first. */
    arm(
      owner: Omit<DelegationResultOwner, 'suppressedTurnId'>,
    ): 'armed' | 'already-armed' | 'capacity' {
      if (this.owner(owner.childConversationId)) return 'already-armed';
      const count = db
        .prepare('SELECT COUNT(*) AS total FROM delegation_result_owners')
        .get() as { total: number };
      if (count.total >= DELEGATION_RESULT_MAX_OWNERS) return 'capacity';
      const inserted = db
        .prepare(
          `INSERT OR IGNORE INTO delegation_result_owners
             (child_conversation_id, task_id, parent_conversation_id, owner_user_id, child_agent, armed_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(
          owner.childConversationId,
          owner.taskId,
          owner.parentConversationId,
          owner.ownerUserId,
          owner.childAgent ?? null,
          now(),
        );
      return changes(inserted) > 0 ? 'armed' : 'already-armed';
    },
    owner(childConversationId: string): DelegationResultOwner | undefined {
      const row = db
        .prepare(
          'SELECT * FROM delegation_result_owners WHERE child_conversation_id = ?',
        )
        .get(childConversationId) as Record<string, unknown> | undefined;
      return row ? ownerOf(row) : undefined;
    },
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
    /** Insert a transition's row once; returns whether this call wrote it. */
    record(row: Omit<DelegationResultRow, 'fence' | 'decision'>): boolean {
      const at = now();
      return (
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
              row.state,
              at,
              at,
            ),
        ) > 0
      );
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
    /** Persist the branch before its effect, so a re-drive pins it. */
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
    refused(row: DelegationResultRow, reason: string): void {
      db.prepare(
        `UPDATE delegation_result_deliveries
         SET state = 'refused', result_json = ?, updated_at = ?
         WHERE child_conversation_id = ? AND transition_key = ?
           AND state IN ('pending', 'claimed')`,
      ).run(JSON.stringify({ reason }), now(), ...rowKey(row));
    },
    /**
     * claimed -> its fence, or pending: the attempt provably had no effect,
     * so the branch is forgotten and a read or interrupt that arrived during
     * it now applies.
     */
    release(row: DelegationResultRow): void {
      db.prepare(
        `UPDATE delegation_result_deliveries
         SET state = COALESCE(fence, 'pending'), decision = NULL, updated_at = ?
         WHERE child_conversation_id = ? AND transition_key = ? AND state = 'claimed'`,
      ).run(now(), ...rowKey(row));
    },
    /**
     * A `get_task` read (`consumed`) or `interrupt_task` (`cancelled`) closes
     * every open row of the child: a pending row now, a claimed row through
     * its fence.
     */
    close(childConversationId: string, as: 'consumed' | 'cancelled'): number {
      const at = now();
      db.prepare(
        `UPDATE delegation_result_deliveries SET fence = ?, updated_at = ?
         WHERE child_conversation_id = ? AND state = 'claimed'`,
      ).run(as, at, childConversationId);
      return changes(
        db
          .prepare(
            `UPDATE delegation_result_deliveries SET state = ?, updated_at = ?
             WHERE child_conversation_id = ? AND state = 'pending'`,
          )
          .run(as, at, childConversationId),
      );
    },
    /** The child turn an interrupt stopped: its settlement is not delivered. */
    suppressTurn(childConversationId: string, turnId: string): void {
      db.prepare(
        `UPDATE delegation_result_owners SET suppressed_turn_id = ?
         WHERE child_conversation_id = ?`,
      ).run(turnId, childConversationId);
    },
    prune(): void {
      const cutoff = now() - DELEGATION_RESULT_RETENTION_MS;
      db.prepare(
        `DELETE FROM delegation_result_deliveries
         WHERE updated_at < ? AND state NOT IN ('pending', 'claimed')`,
      ).run(cutoff);
      db.prepare(
        `DELETE FROM delegation_result_owners WHERE armed_at < ?
         AND child_conversation_id NOT IN (
           SELECT child_conversation_id FROM delegation_result_deliveries
           WHERE state IN ('pending', 'claimed'))`,
      ).run(cutoff);
    },
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
  /** One turn's events of these methods, oldest first. */
  turnEvents(
    threadId: string,
    turnId: string,
    methods: readonly string[],
  ): readonly DelegationResultOutputEvent[];
  /** The conversation a Session belongs to (itself when it has none). */
  conversationOf(threadId: string): string;
  /** A conversation's current execution Session. */
  currentSessionId(conversationId: string): string;
  /** Whether the live coordinator holds a turn the log has not shown yet. */
  coordinatorBusy(threadId: string): boolean;
  /** The recorded owner of a Session, read from its start record. */
  sessionOwnerId(threadId: string): string | undefined;
  /** Start a turn on the parent conversation, acting as its owner. */
  start(input: {
    readonly parentConversationId: string;
    readonly threadId: string;
    readonly ownerUserId: string;
    readonly text: string;
    readonly clientTurnId: string;
  }): Promise<SessionStartResult>;
  /** A receipted steer of the parent's running turn, acting as its owner. */
  steer(input: {
    readonly threadId: string;
    readonly ownerUserId: string;
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
      : '';
  return `${header} Its output follows, each line prefixed "> ".]\n${lines.join('\n')}${tail}`;
}

/**
 * The child's stored output for one turn: the engine's own final text
 * (`turn.completed.outputText`) when it recorded one, else the turn's streamed
 * assistant text in order. Reasoning is never included.
 */
function storedTurnOutput(
  events: readonly DelegationResultOutputEvent[],
  turnId: string | undefined,
): string {
  if (!turnId) return '';
  const own = events.filter((event) => event.turnId === turnId);
  const completed = own.find((event) => event.method === 'turn.completed');
  const outputText = (
    completed?.payload as { outputText?: unknown } | undefined
  )?.outputText;
  if (typeof outputText === 'string' && outputText.trim()) return outputText;
  return own
    .filter((event) => event.method === 'content.text-delta')
    .map((event) => {
      const delta = (event.payload as { delta?: unknown }).delta;
      return typeof delta === 'string' ? delta : '';
    })
    .join('');
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
      void this.onFoldEvent(threadId).catch((error) =>
        this.ports.logger.warn('delegation result delivery failed', {
          error: error instanceof Error ? error.message : String(error),
        }),
      );
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
   * Record that a verified caller's conversation owns a child's results,
   * then look at the child once: a child that settled before this ran is not
   * missed.
   */
  arm(owner: Omit<DelegationResultOwner, 'suppressedTurnId'>): void {
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
    this.ports.store.close(owner.childConversationId, 'consumed');
    return true;
  }

  /**
   * `interrupt_task`: the parent stopped the child itself, so the turn it
   * stopped and any result not yet delivered are not sent.
   */
  cancel(taskReference: string): boolean {
    const owner = this.ports.store.ownerByReference(taskReference);
    if (!owner) return false;
    const thread = this.ports.currentSessionId(owner.childConversationId);
    const open = evaluateSessionWait(
      { ...this.foldPorts(), coordinatorBusy: () => false },
      thread,
      'idle',
      0,
    ).view.openTurnId;
    if (open) this.ports.store.suppressTurn(owner.childConversationId, open);
    this.ports.store.close(owner.childConversationId, 'cancelled');
    return true;
  }

  /** Startup: record transitions missed while down, then drive open rows. */
  async reconcile(): Promise<void> {
    this.ports.store.prune();
    for (const owner of this.ports.store.listOwners())
      this.evaluateChild(owner.childConversationId);
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

  private async onFoldEvent(threadId: string): Promise<void> {
    if (this.stopped) return;
    const conversationId = this.ports.conversationOf(threadId);
    if (this.ports.store.owner(conversationId)) {
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
    const settled = view.settledTurn;
    if (view.state !== 'idle' || !settled) return;
    const transitionKey = `settled:${thread}:${settled.turnId ?? `sequence-${settled.sequence}`}`;
    if (this.ports.store.has(childConversationId, transitionKey)) return;
    const output = settled.turnId
      ? storedTurnOutput(
          this.ports.turnEvents(thread, settled.turnId, [
            'turn.completed',
            'content.text-delta',
          ]),
          settled.turnId,
        )
      : '';
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
        output,
      }),
      state:
        settled.turnId !== undefined &&
        settled.turnId === owner.suppressedTurnId
          ? 'cancelled'
          : 'pending',
    });
  }

  private driveChild(childConversationId: string): void {
    for (const row of this.ports.store.listForChild(childConversationId))
      if (row.state === 'pending') this.drive(row, false);
  }

  /**
   * Run one row's delivery, at most one at a time per row. A claimed row is
   * re-driven only at startup (`redriveClaimed`): it may already have had
   * its effect, and its recorded branch and delivery id make the re-drive
   * land on the same turn or steer receipt rather than a new one.
   */
  private drive(row: DelegationResultRow, redriveClaimed: boolean): void {
    if (this.stopped) return;
    if (row.state === 'claimed' && !redriveClaimed) return;
    const key = `${row.childConversationId}\u0000${row.transitionKey}`;
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
    if (!owner) return store.refused(row, 'owner-missing');
    let pinned: { branch: SessionDeliveryBranch; threadId: string } | undefined;
    if (row.state === 'pending') {
      if (!store.claim(row)) return;
    } else if (row.state === 'claimed') {
      pinned = parseDecision(row.decision);
    } else return;
    const threadId =
      pinned?.threadId ??
      this.ports.currentSessionId(owner.parentConversationId);
    // The parent must still belong to the owner that delegated; a result is
    // never sent into a conversation another principal now owns.
    if (this.ports.sessionOwnerId(threadId) !== owner.ownerUserId)
      return store.refused(row, 'parent-owner-changed');

    const ports: SessionMessageDeliveryPorts = {
      isBusy: (thread) =>
        !evaluateSessionWait(this.foldPorts(), thread, 'idle', 0).satisfied,
      start: ({ text, clientTurnId }) =>
        this.ports.start({
          parentConversationId: owner.parentConversationId,
          threadId,
          ownerUserId: owner.ownerUserId,
          text,
          clientTurnId,
        }),
      steer: ({ threadId: thread, text, clientInputId }) =>
        this.ports.steer({
          threadId: thread,
          ownerUserId: owner.ownerUserId,
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
      // A start that was cleanly refused had no effect: free the row and try
      // again later (the parent's next turn end, or the bounded retry).
      store.release(row);
      this.scheduleRetry(row);
      throw error;
    }
    switch (delivery.outcome) {
      case 'started':
      case 'steered':
        store.delivered(row, delivery);
        this.clearRetry(row);
        return;
      case 'session_busy':
      case 'no_active_turn':
        // Nothing was sent. Queued for the parent's next turn end; the retry
        // covers a busy flag that outlived the terminal event.
        store.release(row);
        this.scheduleRetry(row);
        return;
      case 'indeterminate':
        // Possibly delivered: never sent again under a new id. The row stays
        // claimed with its branch and is re-driven at the next startup.
        return;
    }
  }

  private scheduleRetry(row: DelegationResultRow): void {
    if (this.stopped) return;
    const delays = this.ports.retryDelaysMs ?? RETRY_DELAYS_MS;
    const key = `${row.childConversationId}\u0000${row.transitionKey}`;
    const attempt = (this.retries.get(key)?.attempt ?? 0) + 1;
    if (attempt > delays.length) return;
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
    const previous = this.retries.get(key);
    if (previous) clearTimeout(previous.timer);
    this.retries.set(key, { attempt, timer });
  }

  private clearRetry(row: DelegationResultRow): void {
    const key = `${row.childConversationId}\u0000${row.transitionKey}`;
    const retry = this.retries.get(key);
    if (retry) clearTimeout(retry.timer);
    this.retries.delete(key);
  }
}
