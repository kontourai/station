import type {
  ConversationListItem,
  OrchestrationSessionSummary,
} from '@kontourai/station-contracts/orchestration';
import { useEffect } from 'react';
import { activeChatsStore } from '../../contexts/active-chats-store';

/**
 * #2309: feed the two list reads the dock already holds into the store's
 * per-conversation activity record.
 *
 * The sessions list is how a watchdog observation reaches this client: the
 * server announces a projection change (no event, so no stream binding), the
 * client re-reads the list, and each summary carries its conversation's
 * `progressSilence`. The conversation list covers conversations no chat is
 * streaming yet.
 *
 * Only reads made after this mount feed it. A list restored from a persisted
 * query cache can be a previous page load's copy, and a record with an open
 * turn from then would read as live until a fresher carrier arrived.
 */
export function useConversationActivityFeed(input: {
  sessions: readonly OrchestrationSessionSummary[];
  sessionsFetchedAfterMount: boolean;
  conversations: readonly ConversationListItem[] | undefined;
  conversationsFetchedAfterMount: boolean;
}): void {
  const {
    sessions,
    sessionsFetchedAfterMount,
    conversations,
    conversationsFetchedAfterMount,
  } = input;
  useEffect(() => {
    if (!sessionsFetchedAfterMount) return;
    for (const session of sessions) {
      activeChatsStore.applyConversationActivity(session.conversationActivity);
    }
  }, [sessions, sessionsFetchedAfterMount]);
  useEffect(() => {
    if (!conversationsFetchedAfterMount) return;
    for (const conversation of conversations ?? []) {
      activeChatsStore.applyConversationActivity(conversation.activity);
    }
  }, [conversations, conversationsFetchedAfterMount]);
}
