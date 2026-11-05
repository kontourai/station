import { activeChatsStore } from '../../contexts/active-chats-store';
import type { ConversationDeliveryNotice as Notice } from '../../utils/messageDeliveryState';
import { ConversationDeliveryNotice } from '../conversation/ConversationDeliveryNotice';
import { useDockDeliveryPort } from './useDockDeliveryPort';

export function DockDeliveryNotice({
  chatKey,
  notice,
  retry,
}: {
  chatKey: string;
  notice: Notice;
  retry?: () => void;
}) {
  const port = useDockDeliveryPort(
    chatKey,
    notice.clientTurnId,
    notice.text,
    notice.state,
  );
  const dismiss = () => {
    const chat = activeChatsStore.getSnapshot()[chatKey];
    if (chat)
      activeChatsStore.updateChat(chatKey, {
        ephemeralMessages: chat.ephemeralMessages?.filter(
          (message) =>
            message.deliveryNotice?.clientTurnId !== notice.clientTurnId,
        ),
      });
  };
  return (
    <ConversationDeliveryNotice
      notice={notice}
      port={{
        ...port,
        canRetry: Boolean(retry),
        retry: async () => retry?.(),
        edit: async () => {
          const result = await port.edit();
          dismiss();
          return result;
        },
        discard: async (kind) => {
          const result = await port.discard(kind);
          dismiss();
          return result;
        },
      }}
    />
  );
}
