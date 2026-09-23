import type { ConversationTurnActivity } from '@kontourai/station-contracts/orchestration';

/**
 * #2309: the client's reading of the server's `ConversationTurnActivity`.
 *
 * The server folds "is a turn open, and what is it doing" once, for the whole
 * conversation (every execution child), and delivers that record on several
 * carriers: snapshot rows, stream bindings, the sessions list, the event
 * window, the conversation list and the open resolution. Every device reads
 * the same record, so every device agrees. The client keeps the newest copy
 * per conversation and never re-derives liveness from the event stream while
 * one is present.
 *
 * The one piece of liveness the client still owns is the optimistic send
 * window: from the moment this composer submits until the server reports the
 * turn open (or refuses it). `sendAwaitingTurnStart` names that window.
 */
export type ConversationActivityCarrier = {
  conversationActivity?: ConversationTurnActivity;
  status?: string | null;
  sendAwaitingTurnStart?: boolean;
  /**
   * The turn a Stop receipt reported settled (interrupted, forced, or
   * already finished). That receipt is the server's own answer about exactly
   * that turn, and it can beat the `turn.aborted` frame that updates the
   * record; until the record moves on, that turn is not live.
   */
  stopSettledTurnId?: string;
};

/**
 * Keep the value with the highest `asOfSequence` (the contract's rule for
 * every carrier). An equal sequence takes the incoming copy: the watchdog's
 * `progressSilence` can change with no new committed event, so a later read
 * at the same sequence is the fresher one. A record for a different
 * conversation never replaces the current one.
 */
export function newerConversationActivity(
  current: ConversationTurnActivity | undefined,
  incoming: ConversationTurnActivity | undefined,
): ConversationTurnActivity | undefined {
  if (!incoming) return current;
  if (!current) return incoming;
  if (incoming.conversationId !== current.conversationId) return current;
  return incoming.asOfSequence >= current.asOfSequence ? incoming : current;
}

/**
 * Is a turn live for this chat, by the server's record?
 *
 * `undefined` means there is no server record (an older server, or a chat
 * with no conversation lineage), and the caller falls back to its legacy
 * client fold. Otherwise the answer is the server's open turn, or this
 * composer's own send that the server has not acknowledged yet. A stale
 * `status: 'sending'` outside that window never counts.
 */
export function serverTurnLive(
  session: ConversationActivityCarrier | null | undefined,
): boolean | undefined {
  const activity = session?.conversationActivity;
  if (!activity) return undefined;
  return (
    (activity.openTurn !== undefined &&
      activity.openTurn.turnId !== session?.stopSettledTurnId) ||
    (session?.status === 'sending' && session.sendAwaitingTurnStart === true)
  );
}

/**
 * Where Stop and steer are addressed. The server's open turn names the exact
 * execution child running it, which after a continuation or handoff is not
 * necessarily the tab's own id, and the exact turn.
 *
 * Without a server open turn (an older server, or this composer's own send
 * that the server has not opened yet) the legacy routing stands: the
 * receipted current session and NO server turn id. Callers that historically
 * named the turn this client's `turn.started` stamped (steer) keep doing so
 * themselves; the interrupt never did, and a stale local id must not start
 * addressing a turn that may have ended.
 */
export function liveTurnTarget(
  chat: {
    conversationActivity?: ConversationTurnActivity;
    currentSessionId?: string;
    conversationId?: string;
  },
  fallbackThreadId: string,
): { threadId: string; turnId?: string } {
  const openTurn = chat.conversationActivity?.openTurn;
  if (openTurn) return { threadId: openTurn.threadId, turnId: openTurn.turnId };
  return {
    threadId: chat.currentSessionId ?? chat.conversationId ?? fallbackThreadId,
  };
}

/** Epoch ms of the open turn's server start, or undefined when unknown. */
export function openTurnStartedAtMs(
  activity: ConversationTurnActivity | undefined,
): number | undefined {
  const startedAt = activity?.openTurn?.startedAt;
  if (!startedAt) return undefined;
  const ms = Date.parse(startedAt);
  return Number.isNaN(ms) ? undefined : ms;
}
