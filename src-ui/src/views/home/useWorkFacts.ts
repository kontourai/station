import type { OrchestrationSessionSummary } from '@kontourai/station-sdk';
import { useEffect, useMemo, useRef, useSyncExternalStore } from 'react';
import { activeChatsStore } from '../../contexts/active-chats-store';
import type { HomeWorkItem } from './home-view-model';
import { buildWorkFacts, type WorkFactsById } from './work-facts';
import { changedSinceAcknowledged } from './work-status';

const NO_EXTRA_SOURCES = {};

/**
 * The status facts for a host that holds session summaries and reads its
 * chats from the active-chats store (the dock, the sidebar). Home also passes the
 * wider records it holds (Tasks, remote environments).
 */
export function useWorkFacts(
  items: readonly HomeWorkItem[],
  sessions: readonly OrchestrationSessionSummary[],
  extra: Pick<
    Parameters<typeof buildWorkFacts>[0],
    'tasks' | 'remoteEnvironments'
  > = NO_EXTRA_SOURCES,
): WorkFactsById {
  const chats = useSyncExternalStore(
    activeChatsStore.subscribe,
    activeChatsStore.getSnapshot,
    activeChatsStore.getSnapshot,
  );
  return useMemo(
    () => buildWorkFacts({ items, chats, sessions, ...extra }),
    [chats, items, sessions, extra],
  );
}

/**
 * Acknowledges the conversation that is ON SCREEN, at the version on screen.
 *
 * Acknowledgement used to be written only when a row was activated, so a
 * chat read and replied to in the dock was "unread" the moment the user
 * switched away, and again after every reply: the version had moved on and
 * nothing recorded that they had watched it happen. A displayed conversation
 * has been seen. This writes the acknowledgement whenever the displayed
 * conversation has a version newer than the acknowledged one, which covers
 * opening it, a reply arriving while it is open, and the user's own send.
 *
 * `displayedChatSessionId` is `null` while nothing is displayed (the dock is
 * closed): a conversation that changes then stays unread until it is shown.
 * Each version is written once; the inventory re-read then carries it.
 */
export function useAcknowledgeDisplayedConversation({
  items,
  displayedChatSessionId,
  acknowledge,
}: {
  items: readonly HomeWorkItem[];
  displayedChatSessionId: string | null;
  acknowledge: (item: HomeWorkItem) => void;
}): void {
  const displayed = displayedChatSessionId
    ? items.find(
        (item) =>
          item.chatSessionId === displayedChatSessionId ||
          item.orchestrationThreadId === displayedChatSessionId,
      )
    : undefined;
  const pending =
    displayed && changedSinceAcknowledged(displayed) ? displayed : undefined;
  const version = pending
    ? `${pending.id}\u0000${pending.conversationUpdatedAt}`
    : null;
  const lastWritten = useRef<string | null>(null);
  const latest = useRef({ pending, acknowledge });
  latest.current = { pending, acknowledge };
  useEffect(() => {
    if (version === null || lastWritten.current === version) return;
    lastWritten.current = version;
    const { pending: item, acknowledge: write } = latest.current;
    if (item) write(item);
  }, [version]);
}
