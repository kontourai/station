import type { TurnDeliveryOutcome } from '@kontourai/station-contracts/orchestration';

/**
 * Where one message the user wrote stands on its way to the agent, named only
 * from facts this device has observed. Pure: every input below is a recorded
 * signal, and nothing here estimates.
 *
 * - `sending`: this device's request is out and no answer has come back yet.
 * - `received`: Station said it has the request (the session may still be
 *   starting); the agent does not have the turn yet. Safe to close the app.
 * - `delivered`: the agent has the turn (Station answered with its turn id,
 *   the delivery lookup said `started`, or the turn's start was seen).
 * - `waiting-to-send`: kept on this device and sent automatically when
 *   Station can be reached. Station has not seen it.
 * - `waiting-behind-unsent`: kept on this device, but an earlier message of
 *   the same chat was not sent and holds it back (the outbox keeps a chat's
 *   order). It goes once that one is retried or discarded.
 * - `waiting-for-station`: kept on this device for the Station it was written
 *   for; it is never sent to any other.
 * - `held-on-device`: kept on this device behind a running turn; it is sent
 *   when that turn ends. Station has not seen it, and it lives only as long
 *   as this app's session storage.
 * - `not-sent`: Station refused it, or proved it never received it. Retrying
 *   reuses the same key, so a retry can never make a second turn.
 * - `unconfirmed`: it may have reached the agent and nothing can prove which
 *   way. Never resent automatically; a check asks Station again.
 * - `unanswered`: this device sent it in this session and holds no answer
 *   about it (a stopped send, an attachment send that ended without a turn);
 *   no outbox row keeps it either.
 *
 * Extension point: a state for "accepted by Station and waiting behind a
 * turn" belongs here once something computes it (a Station-held queue); it
 * would come from a lookup outcome, like `received`.
 */
export type MessageDeliveryState =
  | 'sending'
  | 'received'
  | 'delivered'
  | 'waiting-to-send'
  | 'waiting-behind-unsent'
  | 'waiting-for-station'
  | 'held-on-device'
  | 'not-sent'
  | 'unconfirmed'
  | 'unanswered';

/** The durable outbox row's status (`lib/outboundQueue.ts`). */
export type OutboxDeliveryStatus =
  | 'pending'
  | 'invoking'
  | 'accepted'
  | 'failed'
  | 'may-have-started';

export interface MessageDeliverySignals {
  /** The transcript holds this message's turn (its `turn.started` matched). */
  turnStarted?: boolean;
  /** Station answered the send with the provider turn id. */
  providerAccepted?: boolean;
  /** This device's request is out with no answer yet. */
  requestInFlight?: boolean;
  /** The message's row in the durable outbox, if it has one. */
  outbox?: OutboxDeliveryStatus;
  /** Held in this chat's local queue behind a running turn. */
  heldBehindTurn?: boolean;
  /** Station refused the send outright (a definitive answer, not a timeout). */
  refused?: boolean;
  /** The newest delivery-lookup answer for this message's key. */
  lookup?: TurnDeliveryOutcome;
  /** The outbox row waits for the Station it was written for. */
  outboxWaitsForStation?: boolean;
  /** The outbox row is held back by an earlier not-sent row of its chat. */
  outboxBehindUnsent?: boolean;
  /** This device sent it in this session (its own optimistic bubble). */
  sentHere?: boolean;
}

/**
 * Most decisive fact first: the agent having the turn outranks everything;
 * a possible effect outranks a refusal or a hold (it must never be presented
 * as safe to resend); a hold outranks the transport (nothing was sent).
 * `undefined` when there is no delivery fact at all (e.g. another device's
 * message read from history), which renders nothing.
 */
export function deriveMessageDeliveryState(
  signals: MessageDeliverySignals,
): MessageDeliveryState | undefined {
  if (
    signals.turnStarted ||
    signals.providerAccepted ||
    signals.lookup === 'started' ||
    signals.outbox === 'accepted'
  )
    return 'delivered';
  if (
    signals.lookup === 'indeterminate' ||
    signals.lookup === 'expired' ||
    signals.lookup === 'unknown' ||
    signals.outbox === 'may-have-started'
  )
    return 'unconfirmed';
  if (signals.refused || signals.outbox === 'failed') return 'not-sent';
  if (signals.heldBehindTurn) return 'held-on-device';
  if (signals.lookup === 'received') return 'received';
  if (signals.requestInFlight || signals.outbox === 'invoking')
    return 'sending';
  if (signals.outbox === 'pending')
    return signals.outboxWaitsForStation
      ? 'waiting-for-station'
      : signals.outboxBehindUnsent
        ? 'waiting-behind-unsent'
        : 'waiting-to-send';
  // A lookup that found nothing, with no request out and no row kept: the
  // message never reached Station and nothing here will send it.
  if (signals.lookup === 'not-received') return 'not-sent';
  // No fact at all, yet this device sent it: say so rather than let it read
  // as delivered. Another device's message (or history) never gets here.
  if (signals.sentHere) return 'unanswered';
  return undefined;
}

/** The chat facts a bubble's delivery reads (a structural slice of the chat). */
export interface MessageDeliveryChatFacts {
  pendingClientTurnId?: string;
  sendAwaitingTurnStart?: boolean;
  deliveryChecks?: Readonly<Record<string, TurnDeliveryOutcome>>;
  /** Keys this device sent in this session that Station has not started. */
  localSendKeys?: readonly string[];
  outboundQueuedTurns?: ReadonlyArray<{
    clientTurnId: string;
    status: OutboxDeliveryStatus;
    deliveryCheck?: { outcome: TurnDeliveryOutcome };
    waitingForStation?: string;
    behindUnsent?: true;
  }>;
}

/**
 * One transcript message's delivery, from its chat's recorded facts. The
 * user's own bubble carries its send key as `clientId`; any message without
 * one (another device's, history) is only `delivered` when its turn is known.
 */
export function messageDeliveryStateFor(
  chat: MessageDeliveryChatFacts | null | undefined,
  message: { role: string; clientId?: string; turnId?: string },
): MessageDeliveryState | undefined {
  if (message.role !== 'user') return undefined;
  const key = message.clientId;
  const row = key
    ? chat?.outboundQueuedTurns?.find((turn) => turn.clientTurnId === key)
    : undefined;
  return deriveMessageDeliveryState({
    turnStarted: message.turnId !== undefined,
    requestInFlight:
      key !== undefined &&
      chat?.sendAwaitingTurnStart === true &&
      chat.pendingClientTurnId === key,
    outbox: row?.status,
    lookup: (key && chat?.deliveryChecks?.[key]) || row?.deliveryCheck?.outcome,
    outboxWaitsForStation: row?.waitingForStation !== undefined,
    outboxBehindUnsent: row?.behindUnsent === true,
    sentHere: key !== undefined && chat?.localSendKeys?.includes(key) === true,
  });
}

/** A row of the durable outbox, as the queued-messages list shows it. */
export function outboxTurnDeliveryState(row: {
  status: OutboxDeliveryStatus;
  deliveryCheck?: { outcome: TurnDeliveryOutcome };
  /** A held copy listed here: kept on a device, sent only on Send. */
  heldElsewhere?: true;
  waitingForStation?: string;
  behindUnsent?: true;
}): MessageDeliveryState | undefined {
  return deriveMessageDeliveryState({
    outbox: row.status,
    heldBehindTurn: row.heldElsewhere === true,
    lookup: row.deliveryCheck?.outcome,
    outboxWaitsForStation: row.waitingForStation !== undefined,
    outboxBehindUnsent: row.behindUnsent === true,
  });
}
