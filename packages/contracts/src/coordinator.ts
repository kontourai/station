/**
 * #3628: a person's coordinator Session.
 *
 * One conversation per person (request principal) is designated their
 * coordinator: a persistent chat that delegates, is woken when work the person
 * owns needs them, finishes or fails, and brings back results and decisions.
 * Its product name lives in the UI's copy source only; wire names, routes and
 * storage keys say `coordinator`.
 *
 * Bounds are refusals or holds, never silent loss: an item past a cap waits for
 * the next delivery the cap allows, and an item already delivered is not
 * delivered again within `COORDINATOR_WAKE_DEDUPE_WINDOW_MS`.
 */

/** A person's designated coordinator conversation. */
export interface CoordinatorDesignation {
  readonly conversationId: string;
  readonly designatedAt: string;
}

/**
 * Whether Station can reach the coordinator now, derived from its current
 * Session when the designation is read.
 *
 * - `wakes`: `blocked` when the inbox would hold a wake indefinitely: the
 *   Session's last turn has ended (its terminal is in the log), yet its
 *   durable turn boundary is still held (#4051: engines whose turn terminals
 *   carry no invocation id). `ready` otherwise, including during a long turn
 *   or an approval wait.
 * - `toolsPending`: the current Session is live and started without the
 *   built-in Station tools; they arrive when its next Session starts.
 * - `engine`: the current Session's provider, when it has started.
 */
export interface CoordinatorDelivery {
  readonly wakes: 'ready' | 'blocked';
  readonly toolsPending: boolean;
  readonly engine?: string;
}

/** `GET /api/orchestration/coordinator`: the caller's designation, if any. */
export interface CoordinatorDesignationRead {
  readonly designation: CoordinatorDesignation | null;
  /** Present with a designation. */
  readonly delivery?: CoordinatorDelivery;
}

/** `PUT /api/orchestration/coordinator` body. */
export interface CoordinatorDesignateRequest {
  readonly conversationId: string;
  /**
   * Replace an existing designation explicitly. Without it, a second
   * designation is refused (`coordinator_already_designated`).
   */
  readonly replace?: boolean;
}

export type CoordinatorRefusalCode =
  /** The person already has a coordinator and did not ask to replace it. */
  | 'coordinator_already_designated'
  /** The conversation is another person's coordinator. */
  | 'coordinator_conversation_taken'
  /** This Station cannot keep a coordinator (hosted, or no durable store). */
  | 'coordinator_unavailable';

/** What a wake reports about one piece of the person's work. */
export type CoordinatorAttentionKind = 'needs-you' | 'failed' | 'finished';

/**
 * How long Station gathers attention items before it wakes the coordinator,
 * so a burst (a fan-out settling, several approvals at once) is one turn.
 */
export const COORDINATOR_WAKE_COALESCE_MS = 30_000;
/** Wakes per person per rolling hour. Items past it wait for the next slot. */
export const COORDINATOR_WAKE_MAX_PER_HOUR = 12;
/** The rolling window the per-hour cap counts over. */
export const COORDINATOR_WAKE_WINDOW_MS = 60 * 60 * 1000;
/**
 * Items named in one wake. More than this are counted ("and N more"), and the
 * coordinator reads the rest from Station.
 */
export const COORDINATOR_WAKE_MAX_ITEMS_PER_TURN = 10;
/**
 * Items a person may have waiting for a wake. Past it, a new item is refused
 * (it is still in the person's Attention); the waiting ones are kept.
 */
export const COORDINATOR_WAKE_MAX_PENDING_ITEMS = 100;
/**
 * Waits before trying a wake again after the inbox took nothing (a capacity
 * or permission refusal, or an error), in order; the last repeats. Every
 * attempt counts toward `COORDINATOR_WAKE_MAX_PER_HOUR`.
 */
export const COORDINATOR_WAKE_RETRY_DELAYS_MS: readonly number[] = [
  60_000,
  5 * 60_000,
  15 * 60_000,
  60 * 60_000,
];
/**
 * How long a delivered item is remembered, so a repeat of it is not sent
 * again. Producers key items per turn or per request and a notification
 * lives at most a day, so a repeat after this window can only come from a
 * replay; it would be sent as a new item.
 */
export const COORDINATOR_WAKE_DEDUPE_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
/**
 * The longest a wake may wait in the coordinator's inbox. One still queued
 * after this is refused when the inbox would place it, and nothing is sent:
 * its items were readable when it was queued, and that check is not allowed
 * to stand for longer.
 */
export const COORDINATOR_WAKE_QUEUED_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/** The inbox key a coordinator wake turn is sent under. */
export function coordinatorWakeClientTurnId(wakeId: string): string {
  return `coordinator-wake:${wakeId}`;
}

/** Whether an inbox key is a coordinator wake's. */
export function isCoordinatorWakeClientTurnId(clientTurnId: string): boolean {
  return clientTurnId.startsWith('coordinator-wake:');
}
