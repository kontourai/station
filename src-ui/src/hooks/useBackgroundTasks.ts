// station#1301 slice 1 — the one hook the UI uses to read a chat's
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

/** Running-count only, for the entry-point badge. */
export function useChatBackgroundTasksRunningCount(
  chatThreadId: string | null,
): number {
  return useChatBackgroundTasks(chatThreadId).running.length;
}
