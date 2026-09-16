// archive#1301 — the one hook the UI uses to read a chat's
// background-tasks Running/Finished view. Subscribes to both external
// stores it depends on (`backgroundTasksStore` for tool/delegate events,
// `activeChatsStore` for the existing provider-background-subagent
// registry) and recomputes the merged selector only when either snapshot
// actually changes.
import { useCallback, useRef, useSyncExternalStore } from 'react';
import { activeChatsStore } from '../contexts/active-chats-store';
import {
  backgroundTasksStore,
  type ChatBackgroundTasksView,
  selectChatBackgroundTasks,
} from '../contexts/background-tasks-store';

const EMPTY_VIEW: ChatBackgroundTasksView = { running: [], finished: [] };

function subscribeBoth(listener: () => void) {
  const unsubscribeTasks = backgroundTasksStore.subscribe(listener);
  const unsubscribeChats = activeChatsStore.subscribe(listener);
  return () => {
    unsubscribeTasks();
    unsubscribeChats();
  };
}

/**
 * This chat's background-tasks view (Running + Finished), or the empty view
 * for a null `chatThreadId` (no chat open) so callers never need a null
 * guard around the trigger badge / sheet content.
 */
export function useChatBackgroundTasks(
  chatThreadId: string | null,
): ChatBackgroundTasksView {
  const cacheRef = useRef<{
    tasksState: ReturnType<typeof backgroundTasksStore.getSnapshot>;
    providerTasks: ReturnType<
      typeof activeChatsStore.getSnapshot
    >[string]['backgroundTasks'];
    view: ChatBackgroundTasksView;
  } | null>(null);

  const getSnapshot = useCallback((): ChatBackgroundTasksView => {
    if (!chatThreadId) return EMPTY_VIEW;
    const tasksState = backgroundTasksStore.getSnapshot();
    const providerTasks =
      activeChatsStore.getSnapshot()[chatThreadId]?.backgroundTasks;
    const cached = cacheRef.current;
    if (
      cached &&
      cached.tasksState === tasksState &&
      cached.providerTasks === providerTasks
    ) {
      return cached.view;
    }
    const view = selectChatBackgroundTasks(
      tasksState,
      chatThreadId,
      providerTasks,
    );
    cacheRef.current = { tasksState, providerTasks, view };
    return view;
  }, [chatThreadId]);

  return useSyncExternalStore(subscribeBoth, getSnapshot, getSnapshot);
}

/**
 * The active-chats STORE KEY a chat id names, or null for no chat.
 *
 * Navigation carries a chat's DURABLE id (`activeChatDurableId` =
 * `conversationId ?? sessionId`), and the store is keyed by the SESSION key
 * a reopen mints (`useActiveChatSessionLifecycle`: `conversationId` when the
 * reopen carries a provider execution, `${agentSlug}:${Date.now()}` when it
 * does not). The two are the same string on one path only, so a reader that
 * hands `navigation.activeChat` straight to `useChatBackgroundTasks` finds
 * nothing for every conversation reopened without an execution — an empty
 * pane beside a badge counting three running tasks.
 *
 * The rule is the store's own (`getChatKeyForExecutionSession`, which
 * `updateChat` already resolves through and which the dock's
 * `useChatDockActiveChatSync` mirrors against the session inventory), not a
 * third copy. An id the store does not know falls through unchanged: a
 * thread that carries entries but no chat still reads its own.
 */
export function useChatStoreKey(chatId: string | null): string | null {
  const getSnapshot = useCallback(
    () =>
      chatId
        ? (activeChatsStore.getChatKeyForExecutionSession(chatId) ?? chatId)
        : null,
    [chatId],
  );
  return useSyncExternalStore(
    activeChatsStore.subscribe,
    getSnapshot,
    getSnapshot,
  );
}

/** Running-count only, for the entry-point badge. */
export function useChatBackgroundTasksRunningCount(
  chatThreadId: string | null,
): number {
  return useChatBackgroundTasks(chatThreadId).running.length;
}
