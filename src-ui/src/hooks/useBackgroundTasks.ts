// archive#1301 — the one hook the UI uses to read a chat's
// background-tasks Running/Finished view. Subscribes to both external
// stores it depends on (`backgroundTasksStore` for tool/delegate events,
// `activeChatsStore` for the existing provider-background-subagent
// registry) and recomputes the merged selector only when either snapshot
// actually changes.
import { useCallback, useRef, useSyncExternalStore } from 'react';
import { activeChatsStore } from '../contexts/active-chats-store';
import {
  type BackgroundTaskEntry,
  backgroundTasksStore,
  type ChatBackgroundTasksView,
  selectChatBackgroundTasks,
  selectStationProviderItems,
  stationProviderTasks,
} from '../contexts/background-tasks-store';
import { childWorkGlobalStore } from '../contexts/child-work-global-store';

const EMPTY_VIEW: ChatBackgroundTasksView = { running: [], finished: [] };

function subscribeBoth(listener: () => void, apiBase?: string) {
  const unsubscribeTasks = backgroundTasksStore.subscribe(listener);
  const unsubscribeChats = activeChatsStore.subscribe(listener);
  const unsubscribeChildren = childWorkGlobalStore.subscribe(listener);
  const releaseTasks =
    apiBase === undefined
      ? () => {}
      : backgroundTasksStore.retainPartition(apiBase);
  const releaseChildren =
    apiBase === undefined
      ? () => {}
      : childWorkGlobalStore.retainPartition(apiBase);
  return () => {
    unsubscribeTasks();
    unsubscribeChats();
    unsubscribeChildren();
    releaseTasks();
    releaseChildren();
  };
}

/**
 * This chat's background-tasks view (Running + Finished), or the empty view
 * for a null `chatThreadId` (no chat open) so callers never need a null
 * guard around the trigger badge / sheet content.
 */
export function useChatBackgroundTasks(
  chatThreadId: string | null,
  apiBase?: string,
): ChatBackgroundTasksView {
  const cacheRef = useRef<{
    chatThreadId: string;
    apiBase: string | undefined;
    tasksState: ReturnType<typeof backgroundTasksStore.getSnapshot>;
    providerRegistry:
      | ReturnType<typeof childWorkGlobalStore.getPartition>['registry']
      | undefined;
    providerReporters: ReturnType<
      typeof backgroundTasksStore.getSnapshot
    >['providerReporters'];
    providerItems: ReturnType<typeof selectStationProviderItems> | undefined;
    entries: BackgroundTaskEntry[];
    providerTasks: ReturnType<
      typeof activeChatsStore.getSnapshot
    >[string]['backgroundTasks'];
    view: ChatBackgroundTasksView;
  } | null>(null);

  const getSnapshot = useCallback((): ChatBackgroundTasksView => {
    if (!chatThreadId) return EMPTY_VIEW;
    const tasksState = backgroundTasksStore.getSnapshot(apiBase);
    const providerRegistry =
      apiBase === undefined
        ? undefined
        : childWorkGlobalStore.getPartition(apiBase).registry;
    const cached = cacheRef.current;
    const providerItems = providerRegistry
      ? selectStationProviderItems(tasksState, providerRegistry, chatThreadId)
      : undefined;
    const sameProviderItems =
      cached?.chatThreadId === chatThreadId &&
      cached.apiBase === apiBase &&
      cached.providerItems?.length === providerItems?.length &&
      cached.providerItems?.every(
        (item, index) => item === providerItems?.[index],
      );
    const providerTasks =
      apiBase === undefined
        ? activeChatsStore.getSnapshot()[chatThreadId]?.backgroundTasks
        : sameProviderItems
          ? cached?.providerTasks
          : stationProviderTasks(providerItems ?? []);
    if (
      cached &&
      cached.chatThreadId === chatThreadId &&
      cached.apiBase === apiBase &&
      cached.tasksState === tasksState &&
      cached.providerTasks === providerTasks
    ) {
      return cached.view;
    }
    // Provider cards also read their spawning tool's start time.
    const providerToolCallIds = new Set(
      providerTasks?.map((task) => task.toolCallId),
    );
    const entries = Object.values(tasksState.entries).filter(
      (entry) =>
        entry.chatThreadId === chatThreadId ||
        providerToolCallIds.has(entry.id),
    );
    if (
      cached &&
      cached.chatThreadId === chatThreadId &&
      cached.apiBase === apiBase &&
      cached.providerTasks === providerTasks &&
      cached.view.toolHistoryLimited ===
        tasksState.limitedToolChats?.[chatThreadId] &&
      cached.entries.length === entries.length &&
      cached.entries.every((entry, index) => entry === entries[index])
    ) {
      cacheRef.current = {
        ...cached,
        tasksState,
        providerRegistry,
        providerReporters: tasksState.providerReporters,
        providerItems,
      };
      return cached.view;
    }
    const view = selectChatBackgroundTasks(
      tasksState,
      chatThreadId,
      providerTasks,
    );
    cacheRef.current = {
      chatThreadId,
      apiBase,
      tasksState,
      providerRegistry,
      providerReporters: tasksState.providerReporters,
      providerItems,
      entries,
      providerTasks,
      view,
    };
    return view;
  }, [chatThreadId, apiBase]);

  const subscribe = useCallback(
    (listener: () => void) => subscribeBoth(listener, apiBase),
    [apiBase],
  );
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
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
  apiBase?: string,
): number {
  const getSnapshot = useCallback(() => {
    if (!chatThreadId) return 0;
    return selectChatBackgroundTasks(
      backgroundTasksStore.getSnapshot(apiBase),
      chatThreadId,
      apiBase === undefined
        ? activeChatsStore.getSnapshot()[chatThreadId]?.backgroundTasks
        : stationProviderTasks(
            selectStationProviderItems(
              backgroundTasksStore.getSnapshot(apiBase),
              childWorkGlobalStore.getPartition(apiBase).registry,
              chatThreadId,
            ),
          ),
    ).running.length;
  }, [chatThreadId, apiBase]);
  return useSyncExternalStore(subscribeBoth, getSnapshot, getSnapshot);
}

export function useChatBackgroundTasksLimited(
  chatThreadId: string | null,
  apiBase?: string,
): boolean {
  const getSnapshot = useCallback(
    () =>
      !!chatThreadId &&
      backgroundTasksStore.getSnapshot(apiBase).limitedToolChats?.[
        chatThreadId
      ] === true,
    [chatThreadId, apiBase],
  );
  const subscribe = useCallback(
    (listener: () => void) => subscribeBoth(listener, apiBase),
    [apiBase],
  );
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
