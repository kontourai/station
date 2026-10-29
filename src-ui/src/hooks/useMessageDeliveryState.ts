import type { TurnDeliveryOutcome } from '@kontourai/station-contracts/orchestration';
import { useCallback, useSyncExternalStore } from 'react';
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
  return useCallback(
    async (clientTurnId: string) => {
      const { recheckOutboundTurn } = await import('../lib/deliveryLookup');
      const outcome = await recheckOutboundTurn(clientTurnId);
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
    },
    [chatKey],
  );
}
