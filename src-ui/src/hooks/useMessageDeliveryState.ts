import { useActiveChatSelector } from '../contexts/ActiveChatsContext';
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
