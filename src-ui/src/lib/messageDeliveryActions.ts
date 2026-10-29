import { activeChatsStore } from '../contexts/active-chats-store';
import { outboundDispatch } from './outboundQueue';

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
export async function retryNotSentMessage(clientTurnId: string): Promise<void> {
  await outboundDispatch.retry(clientTurnId);
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
): Promise<'removed' | 'delivered'> {
  if (kind === 'unconfirmed')
    await outboundDispatch.dismissUnconfirmed(clientTurnId);
  else await outboundDispatch.discard(clientTurnId);
  // Its row may already be gone because Station started it (the delivery
  // lookup retires the key as accepted): then it was delivered, and its
  // bubble stays, recording that answer.
  if (await wasAccepted(clientTurnId)) {
    recordStarted(chatKey, clientTurnId);
    return 'delivered';
  }
  dropUnsentBubble(chatKey, clientTurnId);
  return 'removed';
}

async function wasAccepted(clientTurnId: string): Promise<boolean> {
  const { accepted } = await outboundDispatch.retiredKeys();
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
): Promise<'removed' | 'delivered'> {
  await outboundDispatch.discard(clientTurnId);
  if (await wasAccepted(clientTurnId)) {
    recordStarted(chatKey, clientTurnId);
    return 'delivered';
  }
  dropUnsentBubble(chatKey, clientTurnId);
  const draft = activeChatsStore.getSnapshot()[chatKey]?.input ?? '';
  activeChatsStore.updateChat(chatKey, {
    input: draft.trim() === '' ? text : `${draft}\n\n${text}`,
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
