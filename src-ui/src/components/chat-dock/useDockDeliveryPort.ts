import { useEffect, useState, useSyncExternalStore } from 'react';
import { outboundStationIdentity } from '../../connections/station-state';
import { activeChatsStore } from '../../contexts/active-chats-store';
import { useRecheckMessageDelivery } from '../../hooks/useMessageDeliveryState';
import type { MessageDeliveryState } from '../../utils/messageDeliveryState';
import { useOptionalConversationConnection } from '../conversation/ConversationConnectionContext';
import type { DeliveryPort } from '../conversation/DeliveryPort';

/** The dock adapts its durable outbox to the shared delivery control. */
export function useDockDeliveryPort(
  chatKey: string,
  clientTurnId: string,
  text: string,
  state?: MessageDeliveryState,
  knownDiscardable?: boolean,
): DeliveryPort {
  const target = useOptionalConversationConnection();
  const station = target?.station;
  const owner = station ? outboundStationIdentity(station) : undefined;
  const conversationId = useSyncExternalStore(
    activeChatsStore.subscribe,
    () => activeChatsStore.getSnapshot()[chatKey]?.conversationId,
  );
  const savedOnDevice = useSyncExternalStore(activeChatsStore.subscribe, () => {
    const chat = activeChatsStore.getSnapshot()[chatKey];
    return (
      chat?.durableClientTurnId === clientTurnId &&
      chat?.pendingClientTurnId === clientTurnId
    );
  });
  const check = useRecheckMessageDelivery(chatKey);
  const [discardable, setDiscardable] = useState(false);
  useEffect(() => {
    if (knownDiscardable !== undefined) return;
    if (state !== 'unconfirmed') {
      setDiscardable(false);
      return;
    }
    let active = true;
    let unsubscribe = () => {};
    void import('../../lib/outboundQueue').then(({ outboundDispatch }) => {
      if (!active) return;
      const read = () =>
        void (
          station
            ? outboundDispatch.rowStatus(
                clientTurnId,
                outboundStationIdentity(station),
                conversationId,
              )
            : outboundDispatch.rowStatus(clientTurnId)
        )
          .then((status) => {
            if (active)
              setDiscardable(
                status === undefined || status === 'may-have-started',
              );
          })
          .catch(() => {
            if (active) setDiscardable(false);
          });
      read();
      unsubscribe = outboundDispatch.subscribe(read);
    });
    return () => {
      active = false;
      unsubscribe();
    };
  }, [state, clientTurnId, station, conversationId, knownDiscardable]);
  const current = () => {
    if (station && !station.isCurrent())
      throw new Error('Reconnect to this chat’s Station.');
  };
  return {
    savedOnDevice,
    canDiscardUnconfirmed: knownDiscardable ?? discardable,
    check: () => {
      current();
      return check(clientTurnId);
    },
    retry: async () => {
      current();
      const { retryNotSentMessage } = await import(
        '../../lib/messageDeliveryActions'
      );
      await retryNotSentMessage(clientTurnId, owner, conversationId);
    },
    edit: async () => {
      current();
      if (state === 'unconfirmed') {
        const draft = activeChatsStore.getSnapshot()[chatKey]?.input ?? '';
        activeChatsStore.updateChat(chatKey, {
          input: draft.trim() ? `${draft}\n\n${text}` : text,
        });
        return 'The original may have reached the agent.';
      }
      const { editMessageInComposer, ALREADY_DELIVERED } = await import(
        '../../lib/messageDeliveryActions'
      );
      return (await editMessageInComposer(
        chatKey,
        clientTurnId,
        text,
        owner,
        conversationId,
      )) === 'delivered'
        ? ALREADY_DELIVERED
        : null;
    },
    discard: async (kind = 'unconfirmed') => {
      current();
      const { discardMessage, ALREADY_DELIVERED } = await import(
        '../../lib/messageDeliveryActions'
      );
      return (await discardMessage(
        chatKey,
        clientTurnId,
        kind,
        owner,
        conversationId,
      )) === 'delivered'
        ? ALREADY_DELIVERED
        : null;
    },
  };
}
