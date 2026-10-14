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
 * - `held-on-device`: kept on this device behind a running turn; it is sent
 *   when that turn ends. Station has not seen it, and it lives only as long
 *   as this app's session storage.
 * - `not-sent`: Station refused it, or proved it never received it. Retrying
 *   reuses the same key, so a retry can never make a second turn.
 * - `unconfirmed`: it may have reached the agent and nothing can prove which
 *   way. Never resent automatically; a check asks Station again.
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
  | 'held-on-device'
  | 'not-sent'
  | 'unconfirmed';

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
  if (signals.outbox === 'pending') return 'waiting-to-send';
  // A lookup that found nothing, with no request out and no row kept: the
  // message never reached Station and nothing here will send it.
  if (signals.lookup === 'not-received') return 'not-sent';
  return undefined;
}

/** The chat facts a bubble's delivery reads (a structural slice of the chat). */
export interface MessageDeliveryChatFacts {
  pendingClientTurnId?: string;
  sendAwaitingTurnStart?: boolean;
  deliveryChecks?: Readonly<Record<string, TurnDeliveryOutcome>>;
  outboundQueuedTurns?: ReadonlyArray<{
    clientTurnId: string;
    status: OutboxDeliveryStatus;
    deliveryCheck?: { outcome: TurnDeliveryOutcome };
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
  });
}

/** A row of the durable outbox, as the queued-messages list shows it. */
export function outboxTurnDeliveryState(row: {
  status: OutboxDeliveryStatus;
  deliveryCheck?: { outcome: TurnDeliveryOutcome };
}): MessageDeliveryState | undefined {
  return deriveMessageDeliveryState({
    outbox: row.status,
    lookup: row.deliveryCheck?.outcome,
  });
}

/**
 * A follow-up held in the chat's local queue. A steer this device sent into
 * the open turn is on its way (or unconfirmed); everything else is held here.
 */
export function heldMessageDeliveryState(metadata?: {
  delivery?: 'steering' | 'indeterminate';
}): MessageDeliveryState {
  if (metadata?.delivery === 'steering') return 'sending';
  if (metadata?.delivery === 'indeterminate') return 'unconfirmed';
  return 'held-on-device';
}
