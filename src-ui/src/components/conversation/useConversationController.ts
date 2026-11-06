import { useMemo } from 'react';
import { isTurnInFlight } from '../../contexts/active-chats-state';
import { useActiveChatTranscript } from '../../hooks/orchestration/useActiveChatTranscript';
import { useChatStreamStatus } from '../../hooks/orchestration/useChatStreamStatus';
import type { ChatSession } from '../../types';
import { useConversationConnection } from './ConversationConnectionContext';
import { createConversationTransport } from './conversation-transport';

/** The live transcript and turn state are identical for every Station route. */
export function useConversationController(session: ChatSession) {
  const connection = useConversationConnection();
  const transcript = useActiveChatTranscript(connection.apiBase, session);
  const streamStatus = useChatStreamStatus(connection.apiBase, session.replay);
  const transport = useMemo(
    () =>
      connection.station
        ? createConversationTransport(connection.station)
        : undefined,
    [connection.station],
  );
  return {
    transport,
    transcript,
    streamStatus,
    turnInFlight: isTurnInFlight(session),
  };
}
