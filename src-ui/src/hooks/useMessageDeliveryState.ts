import type { TurnDeliveryOutcome } from '@kontourai/station-contracts/orchestration';
import { useCallback } from 'react';
import {
  useActiveChatActions,
  useActiveChatSelector,
} from '../contexts/ActiveChatsContext';
import { activeChatsStore } from '../contexts/active-chats-store';
import {
  type MessageDeliveryState,
  messageDeliveryStateFor,
} from '../utils/messageDeliveryState';

/**
 * One transcript message's delivery state, kept current with its chat. The
 * render seam for a bubble: `useMessageDeliveryState(chatKey, message)`.
 */
export function useMessageDeliveryState(
  chatKey: string,
  message: { role: string; clientId?: string; turnId?: string },
): MessageDeliveryState | undefined {
  return useActiveChatSelector(
    chatKey,
    (chat) => messageDeliveryStateFor(chat, message),
    Object.is,
  );
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
  const { updateChat } = useActiveChatActions();
  return useCallback(
    async (clientTurnId: string) => {
      const { recheckOutboundTurn } = await import('../lib/deliveryLookup');
      const outcome = await recheckOutboundTurn(clientTurnId);
      if (outcome) {
        const chat = activeChatsStore.getSnapshot()[chatKey];
        updateChat(chatKey, {
          deliveryChecks: {
            ...(chat?.deliveryChecks ?? {}),
            [clientTurnId]: outcome,
          },
        });
      }
      return outcome;
    },
    [chatKey, updateChat],
  );
}
