import type { TurnDeliveryOutcome } from '@kontourai/station-contracts/orchestration';
import { useCallback, useSyncExternalStore } from 'react';
import { useOptionalConversationConnection } from '../components/conversation/ConversationConnectionContext';
import { outboundStationIdentity } from '../connections/station-state';
import { activeChatsStore } from '../contexts/active-chats-store';
import {
  type MessageDeliveryState,
  messageDeliveryStateFor,
} from '../utils/messageDeliveryState';

/**
 * One transcript message's delivery state, kept current with its chat. The
 * render seam for a bubble: `useMessageDeliveryState(chatKey, message)`.
 *
 * Reads the chat store directly rather than through `ActiveChatsProvider`:
 * a bubble renders on surfaces (and in tests) without that provider, and a
 * chat the store does not hold simply has no delivery facts. The selected
 * value is a string, so a store update that leaves it unchanged re-renders
 * nothing.
 */
export function useMessageDeliveryState(
  chatKey: string,
  message: { role: string; clientId?: string; turnId?: string },
): MessageDeliveryState | undefined {
  const { role, clientId, turnId } = message;
  const select = () =>
    role === 'user'
      ? messageDeliveryStateFor(activeChatsStore.getSnapshot()[chatKey], {
          role,
          clientId,
          turnId,
        })
      : undefined;
  return useSyncExternalStore(activeChatsStore.subscribe, select, select);
}

/**
 * The user's path out of `unconfirmed`: ask Station again about one
 * message's key. Applies the answer to the message's outbox row and to the
 * chat's record for its bubble; never resends (a message Station never
 * received becomes not sent, retried with the same key by the user).
 */
export function useRecheckMessageDelivery(
  chatKey: string,
): (clientTurnId: string) => Promise<TurnDeliveryOutcome | undefined> {
  const connection = useOptionalConversationConnection()?.station;
  return useCallback(
    (clientTurnId: string) =>
      recheckChatMessageDelivery(chatKey, clientTurnId, connection),
    [chatKey, connection],
  );
}

/**
 * `useRecheckMessageDelivery`'s work for a caller that checks messages of
 * several chats at once (an inbox row whose conversation two chats hold).
 */
export async function recheckChatMessageDelivery(
  chatKey: string,
  clientTurnId: string,
  connection?: NonNullable<
    ReturnType<typeof useOptionalConversationConnection>
  >['station'],
): Promise<TurnDeliveryOutcome | undefined> {
  const { recheckOutboundTurn } = await import('../lib/deliveryLookup');
  const chatOwner = activeChatsStore.getSnapshot()[chatKey];
  if (connection && !connection.isCurrent()) return;
  const outcome = connection
    ? await recheckOutboundTurn(clientTurnId, {
        station: outboundStationIdentity(connection),
        requestScope: connection.requestScope,
        conversationId: chatOwner?.conversationId,
      })
    : await recheckOutboundTurn(clientTurnId);
  if (connection && !connection.isCurrent()) return;
  if (outcome) {
    const chat = activeChatsStore.getSnapshot()[chatKey];
    activeChatsStore.updateChat(chatKey, {
      deliveryChecks: {
        ...(chat?.deliveryChecks ?? {}),
        [clientTurnId]: outcome,
      },
      ...(outcome === 'started'
        ? {
            localSendKeys: chat?.localSendKeys?.filter(
              (key) => key !== clientTurnId,
            ),
          }
        : {}),
    });
  }
  return outcome;
}
