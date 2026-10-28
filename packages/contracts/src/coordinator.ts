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
 * the next delivery the cap allows, and an item already delivered is never
 * delivered again.
 */

/** A person's designated coordinator conversation. */
export interface CoordinatorDesignation {
  readonly conversationId: string;
  readonly designatedAt: string;
}

/** `GET /api/orchestration/coordinator`: the caller's designation, if any. */
export interface CoordinatorDesignationRead {
  readonly designation: CoordinatorDesignation | null;
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

/** The inbox key a coordinator wake turn is sent under. */
export function coordinatorWakeClientTurnId(wakeId: string): string {
  return `coordinator-wake:${wakeId}`;
}
