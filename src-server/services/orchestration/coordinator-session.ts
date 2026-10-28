/**
 * #3628: a person's coordinator Session, and its wake on attention states.
 *
 * Designation. One conversation per person (the request principal's user id)
 * is their coordinator. It is a row on EventStore's own connection, so it
 * survives a restart. A second designation is refused unless the person asks
 * to replace the first (`replace`), and a conversation is one person's
 * coordinator at most. The sender a wake turn replays is the person's own
 * dispatch actor as recorded at designation, never a stronger one.
 *
 * Wake. When work the person can read reaches an attention state (needs you,
 * failed, finished), Station already writes a notification for it
 * (`approval-inbox.ts`, `turn-completion-notifications.ts`, `notify_user`).
 * Every one of those reaches the bus as NOTIFICATION_DELIVERED; this module
 * reads that one stream rather than a second copy of each producer's rules.
 * An item is recorded once per person (keyed by the notification's dedupe
 * tag, else its id), so the same item never wakes the coordinator twice, and
 * items are gathered for `COORDINATOR_WAKE_COALESCE_MS` before one framed
 * turn names them all. At most `COORDINATOR_WAKE_MAX_PER_HOUR` wakes go out
 * per rolling hour; items past the cap wait for the next slot rather than
 * being dropped, and past `COORDINATOR_WAKE_MAX_PENDING_ITEMS` waiting items
 * a new one is refused (it still shows in the person's Attention).
 *
 * Who is not woken, so a wake can never cause another wake:
 * - the coordinator for its own conversation's turns (its wake turn ending
 *   writes a "finished" notification of its own);
 * - the coordinator for a finished or failed child it delegated: #3158's
 *   delegation result delivery already brings that settled turn back, once.
 *   A delegated child that needs the person does wake it: nothing else would.
 *
 * Delivery is the conversation's durable inbox (#3568), the path agent
 * wake-ups use: a running coordinator turn finishes before the wake is
 * placed, and the inbox applies the live continuation's permission rule. The
 * wake row and its items are committed before the inbox is called, and the
 * inbox key is derived from the wake's id, so a restart between the two
 * submits the same turn again and the inbox accepts it once.
 */
import { randomUUID } from 'node:crypto';
import type { Notification } from '@kontourai/station-contracts';
import {
  CLIENT_ORIGIN_VERSION,
  type ClientOrigin,
  UNKNOWN_CLIENT_REPORTED_ORIGIN,
} from '@kontourai/station-contracts/client-origin';
import {
  COORDINATOR_WAKE_COALESCE_MS,
  COORDINATOR_WAKE_MAX_ITEMS_PER_TURN,
  COORDINATOR_WAKE_MAX_PENDING_ITEMS,
  COORDINATOR_WAKE_MAX_PER_HOUR,
  COORDINATOR_WAKE_WINDOW_MS,
  type CoordinatorAttentionKind,
  type CoordinatorDesignation,
  type CoordinatorRefusalCode,
  coordinatorWakeClientTurnId,
} from '@kontourai/station-contracts/coordinator';
import {
  isPrincipalRef,
  type PrincipalRef,
} from '@kontourai/station-contracts/principal';
import { SERVER_EVENTS } from '@kontourai/station-contracts/runtime-events';
import { readNotificationEnvelope } from '@kontourai/station-shared/notification-envelope';
import { classifyNotificationCategory } from '@kontourai/station-shared/notification-priority';
import { notificationSessionIdentity } from '../notifications/notification-session.js';
import {
  type TransactionalSqliteDatabase,
  writeTransaction,
} from './delegation-result-delivery.js';
import type { EventBus } from './event-bus.js';
import type { EventStore } from './event-store.js';
import { cutText, singleLine } from './quoted-text.js';
import type { StartOwnerAttribution } from './session-owner-attribution.js';
import type {
  ThreadInboxDelivery,
  ThreadInboxPayload,
  ThreadInboxSubmission,
} from './thread-inbox.js';

/** A wake's turn is Station's own, never a person's or an agent's. */
const COORDINATOR_WAKE_CLIENT_ORIGIN: ClientOrigin = Object.freeze({
  version: CLIENT_ORIGIN_VERSION,
  actor: Object.freeze({ kind: 'internal' as const }),
  reported: UNKNOWN_CLIENT_REPORTED_ORIGIN,
});

/** Delivered items are remembered this long, so a late repeat stays quiet. */
const DELIVERED_ITEM_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
/** The longest item title a wake quotes. */
const ITEM_TITLE_MAX_CHARS = 160;

const COORDINATOR_SCHEMA = `CREATE TABLE IF NOT EXISTS coordinator_designations (
  user_id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL UNIQUE,
  actor_attribution TEXT,
  actor_principal_json TEXT,
  designated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS coordinator_wake_items (
  user_id TEXT NOT NULL,
  item_key TEXT NOT NULL,
  kind TEXT NOT NULL,
  session_id TEXT NOT NULL,
  title TEXT NOT NULL,
  observed_at INTEGER NOT NULL,
  wake_id TEXT,
  PRIMARY KEY (user_id, item_key)
);
CREATE INDEX IF NOT EXISTS coordinator_wake_items_waiting
  ON coordinator_wake_items (user_id, wake_id, observed_at);
CREATE TABLE IF NOT EXISTS coordinator_wakes (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  message TEXT NOT NULL,
  state TEXT NOT NULL,
  reason_code TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS coordinator_wakes_user
  ON coordinator_wakes (user_id, created_at)`;

/** Who a wake turn is sent as: the person, as their designation resolved. */
export interface CoordinatorActor {
  readonly userId: string;
  /** Absent for a person's own request: replayed as absent, never stronger. */
  readonly attribution?: StartOwnerAttribution;
  readonly principal?: PrincipalRef;
}

export interface CoordinatorDesignationRecord extends CoordinatorDesignation {
  readonly actor: CoordinatorActor;
}

/** One piece of the person's work that reached an attention state. */
export interface CoordinatorAttentionItem {
  readonly kind: CoordinatorAttentionKind;
  readonly sessionId: string;
  /** Stable per item: a repeat of the same key is the same item. */
  readonly itemKey: string;
  readonly title: string;
}

export type CoordinatorWakeState = 'sending' | 'sent' | 'failed';

export interface CoordinatorWakeRecord {
  readonly id: string;
  readonly userId: string;
  readonly conversationId: string;
  readonly message: string;
  readonly state: CoordinatorWakeState;
  readonly reasonCode?: string;
  readonly createdAtMs: number;
}

export type DesignateResult =
  | {
      readonly outcome: 'designated';
      readonly designation: CoordinatorDesignationRecord;
    }
  | { readonly outcome: 'refused'; readonly code: CoordinatorRefusalCode };

const iso = (ms: number) => new Date(ms).toISOString();

function parsePrincipal(value: unknown): PrincipalRef | undefined {
  if (typeof value !== 'string') return undefined;
  try {
    const parsed: unknown = JSON.parse(value);
    return isPrincipalRef(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function designationOf(
  row: Record<string, unknown>,
): CoordinatorDesignationRecord {
  const principal = parsePrincipal(row.actor_principal_json);
  return {
    conversationId: String(row.conversation_id),
    designatedAt: iso(Number(row.designated_at)),
    actor: {
      userId: String(row.user_id),
      // Only the two values a start knows; any other stored value replays as
      // the weaker one, and none (a person) as none.
      ...(row.actor_attribution === null || row.actor_attribution === undefined
        ? {}
        : {
            attribution:
              row.actor_attribution === 'verified-bound'
                ? ('verified-bound' as const)
                : ('unattributed-agent' as const),
          }),
      ...(principal ? { principal } : {}),
    },
  };
}

function wakeOf(row: Record<string, unknown>): CoordinatorWakeRecord {
  return {
    id: String(row.id),
    userId: String(row.user_id),
    conversationId: String(row.conversation_id),
    message: String(row.message),
    state: String(row.state) as CoordinatorWakeState,
    ...(typeof row.reason_code === 'string'
      ? { reasonCode: row.reason_code }
      : {}),
    createdAtMs: Number(row.created_at),
  };
}

function changed(result: unknown): boolean {
  return Number((result as { changes?: number | bigint }).changes ?? 0) > 0;
}

/** The durable designations, items and wakes; every transition is one statement. */
export function createSqliteCoordinatorStore(db: TransactionalSqliteDatabase) {
  db.exec(COORDINATOR_SCHEMA);
  const readDesignation = (userId: string) => {
    const row = db
      .prepare('SELECT * FROM coordinator_designations WHERE user_id = ?')
      .get(userId) as Record<string, unknown> | undefined;
    return row ? designationOf(row) : undefined;
  };
  return {
    designation: readDesignation,
    /** The person whose coordinator this conversation is, if any. */
    designationForConversation(conversationId: string) {
      const row = db
        .prepare(
          'SELECT * FROM coordinator_designations WHERE conversation_id = ?',
        )
        .get(conversationId) as Record<string, unknown> | undefined;
      return row ? designationOf(row) : undefined;
    },
    designations(): CoordinatorDesignationRecord[] {
      return (
        db.prepare('SELECT * FROM coordinator_designations').all() as Record<
          string,
          unknown
        >[]
      ).map(designationOf);
    },
    /**
     * Record the person's coordinator. Refused when they already have one
     * and did not ask to replace it, or when the conversation is someone
     * else's. Re-designating the same conversation is a no-op success.
     */
    designate(input: {
      conversationId: string;
      actor: CoordinatorActor;
      replace: boolean;
      now: number;
    }): DesignateResult {
      return writeTransaction(db, 'coordinator_designate', () => {
        const taken = this.designationForConversation(input.conversationId);
        if (taken && taken.actor.userId !== input.actor.userId)
          return {
            outcome: 'refused' as const,
            code: 'coordinator_conversation_taken' as const,
          };
        const existing = readDesignation(input.actor.userId);
        if (existing?.conversationId === input.conversationId)
          return { outcome: 'designated' as const, designation: existing };
        if (existing && !input.replace)
          return {
            outcome: 'refused' as const,
            code: 'coordinator_already_designated' as const,
          };
        db.prepare(
          'DELETE FROM coordinator_designations WHERE user_id = ?',
        ).run(input.actor.userId);
        db.prepare(
          `INSERT INTO coordinator_designations (user_id, conversation_id,
             actor_attribution, actor_principal_json, designated_at)
           VALUES (?, ?, ?, ?, ?)`,
        ).run(
          input.actor.userId,
          input.conversationId,
          input.actor.attribution ?? null,
          input.actor.principal ? JSON.stringify(input.actor.principal) : null,
          input.now,
        );
        return {
          outcome: 'designated' as const,
          designation: readDesignation(input.actor.userId)!,
        };
      });
    },
    /**
     * Clear the person's designation and the items still waiting for it.
     * False when they had none.
     */
    undesignate(userId: string): boolean {
      return writeTransaction(db, 'coordinator_undesignate', () => {
        db.prepare(
          'DELETE FROM coordinator_wake_items WHERE user_id = ? AND wake_id IS NULL',
        ).run(userId);
        return changed(
          db
            .prepare('DELETE FROM coordinator_designations WHERE user_id = ?')
            .run(userId),
        );
      });
    },
    /**
     * Record an item for the person. `duplicate` when the same item was
     * recorded before (waiting or delivered), `full` when
     * `COORDINATOR_WAKE_MAX_PENDING_ITEMS` are already waiting.
     */
    recordItem(
      userId: string,
      item: CoordinatorAttentionItem,
      now: number,
    ): 'recorded' | 'duplicate' | 'full' {
      return writeTransaction(db, 'coordinator_item_insert', () => {
        db.prepare(
          `DELETE FROM coordinator_wake_items
            WHERE wake_id IS NOT NULL AND observed_at <= ?`,
        ).run(now - DELIVERED_ITEM_RETENTION_MS);
        const seen = db
          .prepare(
            'SELECT 1 FROM coordinator_wake_items WHERE user_id = ? AND item_key = ?',
          )
          .get(userId, item.itemKey);
        if (seen) return 'duplicate' as const;
        const waiting = db
          .prepare(
            'SELECT item_key FROM coordinator_wake_items WHERE user_id = ? AND wake_id IS NULL LIMIT ?',
          )
          .all(userId, COORDINATOR_WAKE_MAX_PENDING_ITEMS + 1);
        if (waiting.length >= COORDINATOR_WAKE_MAX_PENDING_ITEMS)
          return 'full' as const;
        db.prepare(
          `INSERT INTO coordinator_wake_items (user_id, item_key, kind,
             session_id, title, observed_at, wake_id)
           VALUES (?, ?, ?, ?, ?, ?, NULL)`,
        ).run(userId, item.itemKey, item.kind, item.sessionId, item.title, now);
        return 'recorded' as const;
      });
    },
    /** People with items waiting for a wake. */
    usersWithWaitingItems(): string[] {
      return (
        db
          .prepare(
            'SELECT DISTINCT user_id FROM coordinator_wake_items WHERE wake_id IS NULL',
          )
          .all() as { user_id: string }[]
      ).map((row) => row.user_id);
    },
    waitingItems(userId: string): CoordinatorAttentionItem[] {
      return (
        db
          .prepare(
            `SELECT * FROM coordinator_wake_items
              WHERE user_id = ? AND wake_id IS NULL ORDER BY observed_at, item_key`,
          )
          .all(userId) as Record<string, unknown>[]
      ).map((row) => ({
        kind: String(row.kind) as CoordinatorAttentionKind,
        sessionId: String(row.session_id),
        itemKey: String(row.item_key),
        title: String(row.title),
      }));
    },
    /**
     * Claim every waiting item into one new wake, unless the person has used
     * their hourly wakes. Returns the wake, `capped` with the time the next
     * slot opens, or `empty`. One transaction: two flushes cannot both claim
     * an item or both pass the cap.
     */
    claimWake(input: {
      designation: CoordinatorDesignationRecord;
      now: number;
      compose: (items: readonly CoordinatorAttentionItem[]) => string;
    }):
      | { readonly outcome: 'claimed'; readonly wake: CoordinatorWakeRecord }
      | { readonly outcome: 'capped'; readonly nextSlotAt: number }
      | { readonly outcome: 'empty' } {
      return writeTransaction(db, 'coordinator_wake_claim', () => {
        const userId = input.designation.actor.userId;
        const windowStart = input.now - COORDINATOR_WAKE_WINDOW_MS;
        db.prepare(
          "DELETE FROM coordinator_wakes WHERE state != 'sending' AND created_at <= ?",
        ).run(windowStart);
        const items = this.waitingItems(userId);
        if (items.length === 0) return { outcome: 'empty' as const };
        const recent = db
          .prepare(
            `SELECT created_at FROM coordinator_wakes
              WHERE user_id = ? AND created_at > ? ORDER BY created_at LIMIT ?`,
          )
          .all(userId, windowStart, COORDINATOR_WAKE_MAX_PER_HOUR + 1) as {
          created_at: number;
        }[];
        if (recent.length >= COORDINATOR_WAKE_MAX_PER_HOUR)
          return {
            outcome: 'capped' as const,
            nextSlotAt:
              Number(recent[0]!.created_at) + COORDINATOR_WAKE_WINDOW_MS,
          };
        const id = randomUUID();
        db.prepare(
          `INSERT INTO coordinator_wakes (id, user_id, conversation_id, message,
             state, created_at, updated_at)
           VALUES (?, ?, ?, ?, 'sending', ?, ?)`,
        ).run(
          id,
          userId,
          input.designation.conversationId,
          input.compose(items),
          input.now,
          input.now,
        );
        db.prepare(
          'UPDATE coordinator_wake_items SET wake_id = ? WHERE user_id = ? AND wake_id IS NULL',
        ).run(id, userId);
        return {
          outcome: 'claimed' as const,
          wake: this.wake(id)!,
        };
      });
    },
    wake(id: string): CoordinatorWakeRecord | undefined {
      const row = db
        .prepare('SELECT * FROM coordinator_wakes WHERE id = ?')
        .get(id) as Record<string, unknown> | undefined;
      return row ? wakeOf(row) : undefined;
    },
    /** Wakes a restart may have cut short between commit and hand-off. */
    sendingWakes(): CoordinatorWakeRecord[] {
      return (
        db
          .prepare(
            "SELECT * FROM coordinator_wakes WHERE state = 'sending' ORDER BY created_at",
          )
          .all() as Record<string, unknown>[]
      ).map(wakeOf);
    },
    /**
     * Settle a wake still `sending`. `release` puts its items back to wait
     * for the next wake: only when nothing reached the inbox.
     */
    settleWake(
      id: string,
      to: 'sent' | 'failed',
      now: number,
      detail: { reasonCode?: string; release?: boolean } = {},
    ): boolean {
      return writeTransaction(db, 'coordinator_wake_settle', () => {
        const settled = changed(
          db
            .prepare(
              `UPDATE coordinator_wakes SET state = ?, reason_code = ?, updated_at = ?
                WHERE id = ? AND state = 'sending'`,
            )
            .run(to, detail.reasonCode ?? null, now, id),
        );
        if (settled && detail.release)
          db.prepare(
            'UPDATE coordinator_wake_items SET wake_id = NULL WHERE wake_id = ?',
          ).run(id);
        return settled;
      });
    },
  };
}

export type CoordinatorStore = ReturnType<typeof createSqliteCoordinatorStore>;

/**
 * The attention item a delivered notification names, or undefined when it is
 * not one: a category outside the needs-you / failed / finished tiers, a
 * stop the person asked for, or a record naming no Session (pairing requests,
 * scheduler housekeeping: nothing the coordinator can open).
 */
export function coordinatorAttentionOf(
  notification: Pick<Notification, 'id' | 'category' | 'title' | 'metadata'>,
): CoordinatorAttentionItem | undefined {
  if (notification.category === 'turn-stopped') return undefined;
  const outcome = classifyNotificationCategory(notification.category);
  const kind: CoordinatorAttentionKind | undefined =
    outcome === 'needs-input'
      ? 'needs-you'
      : outcome === 'failed'
        ? 'failed'
        : outcome === 'done'
          ? 'finished'
          : undefined;
  if (!kind) return undefined;
  const envelope = readNotificationEnvelope(notification);
  const sessionId = notificationSessionIdentity(notification, envelope);
  if (!sessionId) return undefined;
  const dedupeTag = (notification.metadata as { dedupeTag?: unknown } | null)
    ?.dedupeTag;
  return {
    kind,
    sessionId,
    itemKey: `${kind}:${typeof dedupeTag === 'string' ? dedupeTag : `notification:${notification.id}`}`,
    title: cutText(singleLine(notification.title), ITEM_TITLE_MAX_CHARS),
  };
}

const KIND_LABEL: Record<CoordinatorAttentionKind, string> = {
  'needs-you': 'Needs the person',
  failed: 'Failed',
  finished: 'Finished',
};

/**
 * What the coordinator reads when it is woken. Station's own words frame it:
 * the turn is sent as the person (the conversation's own permissions), so
 * it says plainly that Station wrote it. The only outside text is each
 * notification's title, one line, cut, and quoted as data.
 */
export function coordinatorWakeMessage(
  items: readonly CoordinatorAttentionItem[],
): string {
  const shown = items.slice(0, COORDINATOR_WAKE_MAX_ITEMS_PER_TURN);
  const lines = shown.map(
    (item) =>
      `- ${KIND_LABEL[item.kind]}: Session ${item.sessionId}\n  > ${item.title}`,
  );
  const more = items.length - shown.length;
  return [
    '[Station] Work you coordinate for the person changed. This message is from Station, not the person.',
    "Read each Session's stored output before you report to the person; a status alone is not the result. Decisions and approvals stay with the person.",
    '',
    ...lines,
    ...(more > 0
      ? [`- and ${more} more; list the person's work to see them.`]
      : []),
  ].join('\n');
}

export interface CoordinatorWakePorts {
  readonly store: CoordinatorStore;
  /** Whether the person may read the Session (the same rule as its readers). */
  mayRead(userId: string, sessionId: string): boolean;
  /** The conversation a Session belongs to (itself when it has none). */
  conversationOf(sessionId: string): string;
  /** The conversation that delegated this one, when one did (#3158). */
  delegatedBy(conversationId: string): string | undefined;
  /** Hand a wake to the coordinator conversation's inbox. */
  submit(input: {
    conversationId: string;
    clientTurnId: string;
    payload: ThreadInboxPayload;
  }): ThreadInboxSubmission;
  readonly logger: {
    warn(message: string, meta?: Record<string, unknown>): void;
  };
  readonly now?: () => number;
  /** Test seam: replaces the unref'd `setTimeout` behind coalescing. */
  readonly setTimer?: (callback: () => void, delayMs: number) => () => void;
}

export type CoordinatorObserveOutcome = {
  readonly userId: string;
  readonly outcome: 'recorded' | 'duplicate' | 'full';
};

function defaultSetTimer(callback: () => void, delayMs: number) {
  const timer = setTimeout(callback, delayMs);
  timer.unref?.();
  return () => clearTimeout(timer);
}

/** Gathers attention items per person and sends the coordinator one turn. */
export class CoordinatorWakeDelivery {
  private readonly timers = new Map<string, () => void>();
  private stopped = false;

  constructor(private readonly ports: CoordinatorWakePorts) {}

  private now(): number {
    return this.ports.now?.() ?? Date.now();
  }

  /**
   * A notification was delivered: record it for every person whose
   * coordinator should hear of it, and arm their coalescing timer.
   */
  observeNotification(
    notification: Parameters<typeof coordinatorAttentionOf>[0],
  ): CoordinatorObserveOutcome[] {
    const item = coordinatorAttentionOf(notification);
    return item ? this.observe(item) : [];
  }

  observe(item: CoordinatorAttentionItem): CoordinatorObserveOutcome[] {
    if (this.stopped) return [];
    const conversationId = this.ports.conversationOf(item.sessionId);
    const delegatedBy = this.ports.delegatedBy(conversationId);
    const outcomes: CoordinatorObserveOutcome[] = [];
    for (const designation of this.ports.store.designations()) {
      if (designation.conversationId === conversationId) continue;
      // #3158 already returns a delegated child's settled turn (any
      // outcome) to its parent; a child waiting on the person does not settle.
      if (
        delegatedBy === designation.conversationId &&
        item.kind !== 'needs-you'
      )
        continue;
      const userId = designation.actor.userId;
      let readable = false;
      try {
        readable = this.ports.mayRead(userId, item.sessionId);
      } catch {
        readable = false;
      }
      if (!readable) continue;
      const outcome = this.ports.store.recordItem(userId, item, this.now());
      outcomes.push({ userId, outcome });
      if (outcome === 'recorded')
        this.arm(userId, COORDINATOR_WAKE_COALESCE_MS);
    }
    return outcomes;
  }

  /** Startup: hand over wakes a restart cut short, and arm waiting items. */
  reconcile(): void {
    for (const wake of this.ports.store.sendingWakes()) this.send(wake);
    for (const userId of this.ports.store.usersWithWaitingItems())
      this.arm(userId, COORDINATOR_WAKE_COALESCE_MS);
  }

  stop(): void {
    this.stopped = true;
    for (const cancel of this.timers.values()) cancel();
    this.timers.clear();
  }

  /** Arm the person's flush unless one is already armed: a burst is one wake. */
  private arm(userId: string, delayMs: number): void {
    if (this.stopped || this.timers.has(userId)) return;
    const setTimer = this.ports.setTimer ?? defaultSetTimer;
    this.timers.set(
      userId,
      setTimer(
        () => {
          this.timers.delete(userId);
          this.flush(userId);
        },
        Math.max(0, delayMs),
      ),
    );
  }

  /** Send the person's waiting items as one wake, if the hourly cap allows. */
  flush(
    userId: string,
  ): 'sent' | 'capped' | 'empty' | 'failed' | 'undesignated' {
    if (this.stopped) return 'failed';
    const designation = this.ports.store.designation(userId);
    if (!designation) return 'undesignated';
    const now = this.now();
    const claimed = this.ports.store.claimWake({
      designation,
      now,
      compose: coordinatorWakeMessage,
    });
    if (claimed.outcome === 'empty') return 'empty';
    if (claimed.outcome === 'capped') {
      this.arm(userId, claimed.nextSlotAt - now);
      return 'capped';
    }
    return this.send(claimed.wake);
  }

  private send(wake: CoordinatorWakeRecord): 'sent' | 'failed' {
    const now = this.now();
    const designation = this.ports.store.designation(wake.userId);
    if (!designation || designation.conversationId !== wake.conversationId) {
      // Undesignated or moved since it was claimed: nothing was handed over.
      this.ports.store.settleWake(wake.id, 'failed', now, {
        reasonCode: 'undesignated',
      });
      return 'failed';
    }
    let submitted: ThreadInboxSubmission;
    try {
      submitted = this.ports.submit({
        conversationId: wake.conversationId,
        clientTurnId: coordinatorWakeClientTurnId(wake.id),
        payload: {
          message: wake.message,
          actor: {
            userId: designation.actor.userId,
            ...(designation.actor.attribution
              ? { ownerAttribution: designation.actor.attribution }
              : {}),
            ...(designation.actor.principal
              ? { principal: designation.actor.principal }
              : {}),
          },
          clientOrigin: COORDINATOR_WAKE_CLIENT_ORIGIN,
        },
      });
    } catch (error) {
      this.ports.logger.warn('coordinator wake could not be sent', {
        wakeId: wake.id,
        error: error instanceof Error ? error.message : String(error),
      });
      this.ports.store.settleWake(wake.id, 'failed', now, {
        reasonCode: 'send_failed',
        release: true,
      });
      return 'failed';
    }
    if (submitted.outcome === 'queued') {
      this.ports.store.settleWake(wake.id, 'sent', now);
      return 'sent';
    }
    // Nothing was written to the inbox: the items wait for the next wake.
    this.ports.store.settleWake(wake.id, 'failed', now, {
      reasonCode:
        submitted.outcome === 'not-permitted'
          ? 'not_permitted'
          : submitted.outcome,
      release: true,
    });
    return 'failed';
  }
}

/**
 * The production wiring: one EventBus listener for NOTIFICATION_DELIVERED,
 * the inbox's submit, and the conversation and delegation reads. Kept here
 * so the integration test drives exactly what the runtime runs. Never throws
 * into the bus (a throwing listener is dropped).
 */
export function wireCoordinatorWakes(deps: {
  readonly eventBus: Pick<EventBus, 'subscribe'>;
  readonly eventStore: Pick<
    EventStore,
    'conversationForSession' | 'delegationResultStore'
  >;
  readonly store: CoordinatorStore;
  readonly threadInbox: Pick<ThreadInboxDelivery, 'submit'>;
  mayRead(userId: string, sessionId: string): boolean;
  readonly logger: CoordinatorWakePorts['logger'];
  readonly now?: () => number;
  readonly setTimer?: CoordinatorWakePorts['setTimer'];
}): CoordinatorWakeDelivery & { unsubscribe(): void } {
  const delivery = new CoordinatorWakeDelivery({
    store: deps.store,
    mayRead: deps.mayRead,
    conversationOf: (sessionId) =>
      deps.eventStore.conversationForSession(sessionId)?.conversationId ??
      sessionId,
    delegatedBy: (conversationId) =>
      deps.eventStore.delegationResultStore().owner(conversationId)
        ?.parentConversationId,
    submit: (input) => deps.threadInbox.submit(input),
    logger: deps.logger,
    ...(deps.now ? { now: deps.now } : {}),
    ...(deps.setTimer ? { setTimer: deps.setTimer } : {}),
  });
  const unsubscribe = deps.eventBus.subscribe((frame) => {
    if (frame.event !== SERVER_EVENTS.NOTIFICATION_DELIVERED) return;
    try {
      delivery.observeNotification(frame.data as unknown as Notification);
    } catch (error) {
      deps.logger.warn('coordinator wake could not read a notification', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });
  return Object.assign(delivery, {
    unsubscribe: () => {
      unsubscribe();
      delivery.stop();
    },
  });
}
