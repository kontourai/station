import type { ConversationInboxEntry } from '@kontourai/station-contracts/orchestration';

/**
 * The pending-message list's shared rules: its count, which rows are in the
 * send order it numbers, and which need the person. The list
 * (`QueuedMessages`), the dock that builds its outbox rows and the chat's
 * context card all read them here, so they cannot disagree.
 */

/** The fields of an outbox row these rules read. */
export interface PendingOutboxTurn {
  status: 'pending' | 'invoking' | 'accepted' | 'failed' | 'may-have-started';
  /** The window holding this copy is proven closed. */
  heldByClosedWindow?: true;
}

/**
 * An outbox row only the person can settle: it was not sent, it may have
 * reached the agent, or its copy was held by a window that has closed. A
 * copy another open window holds is that window's ordinary follow-up.
 */
export function outboxNeedsReview(turn: PendingOutboxTurn): boolean {
  return (
    turn.status === 'failed' ||
    turn.status === 'may-have-started' ||
    turn.heldByClosedWindow === true
  );
}

/** A Station-held row Station sends itself when the turn ends, in position order. */
export function heldSendsInOrder(entry: ConversationInboxEntry): boolean {
  return entry.state === 'queued';
}

/**
 * The list's one count: every row it lists. A follow-up queued here that
 * Station also holds is one row (Station's copy), so it counts once.
 */
export function pendingMessageCount({
  localIds,
  held,
  outboxCount,
}: {
  /** This window's queued follow-ups, by their delivery key where known. */
  localIds: readonly (string | undefined)[];
  /** Station-held entries still listed (`visibleInboxEntries`). */
  held: readonly ConversationInboxEntry[];
  outboxCount: number;
}): number {
  const heldKeys = new Set(
    held.flatMap((entry) => (entry.clientTurnId ? [entry.clientTurnId] : [])),
  );
  const local = localIds.filter((id) => !id || !heldKeys.has(id)).length;
  return local + held.length + outboxCount;
}
