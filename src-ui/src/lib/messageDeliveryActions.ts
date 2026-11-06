import { activeChatsStore } from '../contexts/active-chats-store';
import {
  type OutboundStationIdentity,
  outboundDispatch,
} from './outboundQueue';

/**
 * What a user can do with one of their own messages that has not reached the
 * agent, from its bubble or the outbox list. Each action acts on the durable
 * outbox row first and changes the chat only once that write succeeded, so a
 * failed write leaves the message exactly where it was.
 */

/** Shown when an action finds the message was delivered after all. */
export const ALREADY_DELIVERED =
  'Station had already started this message, so it was kept.';

/** Sends a not-sent message again under its own key (`outboundDispatch.retry`). */
export async function retryNotSentMessage(
  clientTurnId: string,
  station?: OutboundStationIdentity,
  conversationId?: string,
): Promise<void> {
  if (station)
    await outboundDispatch.retry(clientTurnId, station, conversationId);
  else await outboundDispatch.retry(clientTurnId);
}

/**
 * Takes a message out of this device: its row goes (its key retired, so it is
 * never sent again from any window) and its unsent bubble leaves the chat.
 * `unconfirmed` is the user's "I checked, discard it" for a message that may
 * have reached the agent: if it did, its turn still arrives and the
 * transcript shows it from Station's own record.
 */
export async function discardMessage(
  chatKey: string,
  clientTurnId: string,
  kind: 'not-sent' | 'unconfirmed',
  station?: OutboundStationIdentity,
  conversationId?: string,
): Promise<'removed' | 'delivered'> {
  if (kind === 'unconfirmed') {
    if (station)
      await outboundDispatch.dismissUnconfirmed(
        clientTurnId,
        station,
        conversationId,
      );
    else await outboundDispatch.dismissUnconfirmed(clientTurnId);
  } else {
    if (station)
      await outboundDispatch.discard(clientTurnId, station, conversationId);
    else await outboundDispatch.discard(clientTurnId);
  }
  // Its row may already be gone because Station started it (the delivery
  // lookup retires the key as accepted): then it was delivered, and its
  // bubble stays, recording that answer.
  if (await wasAccepted(clientTurnId, station, conversationId)) {
    recordStarted(chatKey, clientTurnId);
    return 'delivered';
  }
  dropUnsentBubble(chatKey, clientTurnId);
  return 'removed';
}

async function wasAccepted(
  clientTurnId: string,
  station?: OutboundStationIdentity,
  conversationId?: string,
): Promise<boolean> {
  const { accepted } = station
    ? await outboundDispatch.retiredKeys(station, { conversationId })
    : await outboundDispatch.retiredKeys();
  return accepted.includes(clientTurnId);
}

function recordStarted(chatKey: string, clientTurnId: string): void {
  const chat = activeChatsStore.getSnapshot()[chatKey];
  if (!chat) return;
  activeChatsStore.updateChat(chatKey, {
    deliveryChecks: {
      ...(chat.deliveryChecks ?? {}),
      [clientTurnId]: 'started',
    },
    localSendKeys: chat.localSendKeys?.filter((key) => key !== clientTurnId),
  });
}

/**
 * Edit a not-sent message: its text goes back to the composer (after any draft
 * already there, never over it), and its row and bubble go. Sending it again
 * is a new message.
 */
export async function editMessageInComposer(
  chatKey: string,
  clientTurnId: string,
  text: string,
  station?: OutboundStationIdentity,
  conversationId?: string,
): Promise<'removed' | 'delivered'> {
  if (station)
    await outboundDispatch.discard(clientTurnId, station, conversationId);
  else await outboundDispatch.discard(clientTurnId);
  if (await wasAccepted(clientTurnId, station, conversationId)) {
    recordStarted(chatKey, clientTurnId);
    return 'delivered';
  }
  dropUnsentBubble(chatKey, clientTurnId);
  const draft = activeChatsStore.getSnapshot()[chatKey]?.input ?? '';
  activeChatsStore.updateChat(chatKey, {
    input:
      draft.trim() === '' || draft.trim() === text.trim()
        ? text
        : `${draft}\n\n${text}`,
  });
  return 'removed';
}

/** The user's bubble for this key that no turn claimed, and its lookup answer. */
function dropUnsentBubble(chatKey: string, clientTurnId: string): void {
  const chat = activeChatsStore.getSnapshot()[chatKey];
  if (!chat) return;
  const { [clientTurnId]: _dropped, ...deliveryChecks } =
    chat.deliveryChecks ?? {};
  activeChatsStore.updateChat(chatKey, {
    messages: chat.messages?.filter(
      (message) =>
        !(
          message.role === 'user' &&
          message.clientId === clientTurnId &&
          message.turnId === undefined
        ),
    ),
    deliveryChecks,
    localSendKeys: chat.localSendKeys?.filter((key) => key !== clientTurnId),
  });
}
