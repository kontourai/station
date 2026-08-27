import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useSyncExternalStore,
} from 'react';
import { usePruneActiveChats } from '../hooks/usePruneActiveChats';
import {
  type ActiveChatMetadata,
  type ActiveChatsMap,
  activeChatsStore,
  type ChatUIState,
} from './active-chats-store';
import { conversationsStore } from './ConversationsContext';
import { chatDraftsStore } from './chat-drafts-store';

type ActiveChatsContextType = {
  initChat: (sessionId: string, metadata?: ActiveChatMetadata) => void;
  updateChat: (sessionId: string, updates: Partial<ChatUIState>) => void;
  removeChat: (sessionId: string) => void;
  clearInput: (sessionId: string) => void;
  addEphemeralMessage: (
    sessionId: string,
    message: {
      role: 'user' | 'assistant' | 'system';
      content: string;
      attachments?: any[];
      action?: { label: string; handler: () => void };
    },
  ) => void;
  clearEphemeralMessages: (sessionId: string) => void;
  assignConversationId: (sessionId: string, conversationId: string) => void;
  removeQueuedMessage: (sessionId: string, index: number) => void;
  editQueuedMessage: (
    sessionId: string,
    index: number,
    newContent: string,
  ) => void;
  clearQueue: (sessionId: string) => void;
  reorderQueuedMessage: (
    sessionId: string,
    fromIndex: number,
    toIndex: number,
  ) => void;
  addToInputHistory: (sessionId: string, input: string) => void;
  setDraft: (sessionId: string, text: string) => void;
  getDraft: (sessionId: string) => string;
  clearDraft: (sessionId: string) => void;
  navigateHistoryUp: (sessionId: string) => void;
  navigateHistoryDown: (sessionId: string) => void;
  getAllChats: () => ActiveChatsMap;
};

const ActiveChatsContext = createContext<ActiveChatsContextType | undefined>(
  undefined,
);

activeChatsStore.setBackendMessagesResolver((agentSlug, conversationId) => {
  const snapshot = conversationsStore.getSnapshot();
  const messagesKey = `messages:${agentSlug}:${conversationId}`;
  return snapshot.messages[messagesKey] || [];
});

export function ActiveChatsProvider({ children }: { children: ReactNode }) {
  usePruneActiveChats();

  const initChat = useCallback(
    (sessionId: string, metadata?: ActiveChatMetadata) => {
      activeChatsStore.initChat(sessionId, metadata);
    },
    [],
  );

  const updateChat = useCallback(
    (sessionId: string, updates: Partial<ChatUIState>) => {
      activeChatsStore.updateChat(sessionId, updates);
    },
    [],
  );

  const removeChat = useCallback((sessionId: string) => {
    activeChatsStore.removeChat(sessionId);
  }, []);

  const clearInput = useCallback((sessionId: string) => {
    activeChatsStore.clearInput(sessionId);
  }, []);

  const addEphemeralMessage = useCallback(
    (
      sessionId: string,
      message: {
        role: 'user' | 'assistant' | 'system';
        content: string;
        attachments?: any[];
        action?: { label: string; handler: () => void };
      },
    ) => {
      activeChatsStore.addEphemeralMessage(sessionId, message);
    },
    [],
  );

  const clearEphemeralMessages = useCallback((sessionId: string) => {
    activeChatsStore.clearEphemeralMessages(sessionId);
  }, []);

  const assignConversationId = useCallback(
    (sessionId: string, conversationId: string) => {
      activeChatsStore.assignConversationId(sessionId, conversationId);
    },
    [],
  );

  const removeQueuedMessage = useCallback(
    (sessionId: string, index: number) => {
      activeChatsStore.removeQueuedMessage(sessionId, index);
    },
    [],
  );

  const editQueuedMessage = useCallback(
    (sessionId: string, index: number, newContent: string) => {
      activeChatsStore.editQueuedMessage(sessionId, index, newContent);
    },
    [],
  );

  const clearQueue = useCallback((sessionId: string) => {
    activeChatsStore.clearQueue(sessionId);
  }, []);

  const reorderQueuedMessage = useCallback(
    (sessionId: string, fromIndex: number, toIndex: number) => {
      activeChatsStore.reorderQueuedMessage(sessionId, fromIndex, toIndex);
    },
    [],
  );

  const addToInputHistory = useCallback((sessionId: string, input: string) => {
    activeChatsStore.addToInputHistory(sessionId, input);
  }, []);

  const setDraft = useCallback((sessionId: string, text: string) => {
    chatDraftsStore.set(sessionId, text);
  }, []);
  const getDraft = useCallback(
    (sessionId: string) => chatDraftsStore.get(sessionId),
    [],
  );
  const clearDraft = useCallback(
    (sessionId: string) => chatDraftsStore.clear(sessionId),
    [],
  );

  const navigateHistoryUp = useCallback((sessionId: string) => {
    activeChatsStore.navigateHistoryUp(sessionId);
  }, []);

  const navigateHistoryDown = useCallback((sessionId: string) => {
    activeChatsStore.navigateHistoryDown(sessionId);
  }, []);

  const getAllChats = useCallback(() => activeChatsStore.getSnapshot(), []);

  // station#3796: one memoised value per provider — a fresh object literal
  // here republishes the context to every consumer on any render of this
  // provider, whatever the render was actually about.
  const value = useMemo(
    () => ({
      initChat,
      updateChat,
      removeChat,
      clearInput,
      addEphemeralMessage,
      clearEphemeralMessages,
      assignConversationId,
      removeQueuedMessage,
      editQueuedMessage,
      clearQueue,
      reorderQueuedMessage,
      addToInputHistory,
      setDraft,
      getDraft,
      clearDraft,
      navigateHistoryUp,
      navigateHistoryDown,
      getAllChats,
    }),
    [
      initChat,
      updateChat,
      removeChat,
      clearInput,
      addEphemeralMessage,
      clearEphemeralMessages,
      assignConversationId,
      removeQueuedMessage,
      editQueuedMessage,
      clearQueue,
      reorderQueuedMessage,
      addToInputHistory,
      setDraft,
      getDraft,
      clearDraft,
      navigateHistoryUp,
      navigateHistoryDown,
      getAllChats,
    ],
  );

  return (
    <ActiveChatsContext.Provider value={value}>
      {children}
    </ActiveChatsContext.Provider>
  );
}

export function useActiveChatState(sessionId: string): ChatUIState | null {
  const context = useContext(ActiveChatsContext);
  if (!context) {
    throw new Error(
      'useActiveChatState must be used within ActiveChatsProvider',
    );
  }

  const chats = useSyncExternalStore(
    activeChatsStore.subscribe,
    activeChatsStore.getSnapshot,
    activeChatsStore.getSnapshot,
  );

  return chats[sessionId] || null;
}

function isShallowEqual<T>(a: T, b: T): boolean {
  if (Object.is(a, b)) return true;
  if (
    typeof a !== 'object' ||
    a === null ||
    typeof b !== 'object' ||
    b === null
  ) {
    return false;
  }
  const aRecord = a as Record<string, unknown>;
  const bRecord = b as Record<string, unknown>;
  const aKeys = Object.keys(aRecord);
  const bKeys = Object.keys(bRecord);
  if (aKeys.length !== bKeys.length) return false;
  for (const key of aKeys) {
    if (!Object.is(aRecord[key], bRecord[key])) {
      return false;
    }
  }
  return true;
}

/**
 * Selector-granular read of a single chat session.
 *
 * useActiveChatState (above) returns the *entire* ChatUIState and re-renders
 * on any field change — including every composer keystroke, which writes
 * `{ input }` via updateChat(). active-chats-store.updateChat() replaces the
 * session's whole object on every call (mergeChatUpdates spreads
 * `{...current, ...updates}`), but fields the update didn't touch keep their
 * prior reference. That means a selector comparing only the fields a
 * consumer actually reads can reliably skip re-notifying it when an
 * unrelated field (like `input`) changes — this is what stops composer
 * keystrokes from re-rendering the transcript.
 *
 * `isEqual` defaults to a shallow (one-level) comparison, which is enough
 * for selectors that return a flat object of primitives/array references.
 */
export function useActiveChatSelector<T>(
  sessionId: string,
  selector: (state: ChatUIState | null) => T,
  isEqual: (a: T, b: T) => boolean = isShallowEqual,
): T {
  const context = useContext(ActiveChatsContext);
  if (!context) {
    throw new Error(
      'useActiveChatSelector must be used within ActiveChatsProvider',
    );
  }

  // Always read the latest selector/isEqual via refs rather than as
  // useSyncExternalStore dependencies — this mirrors React's own
  // use-sync-external-store-with-selector shim and lets callers pass
  // inline selector functions without needing to memoize them themselves.
  const selectorRef = useRef(selector);
  selectorRef.current = selector;
  const isEqualRef = useRef(isEqual);
  isEqualRef.current = isEqual;

  const cacheRef = useRef<{ raw: ChatUIState | null; selected: T } | null>(
    null,
  );

  const getSnapshot = useCallback((): T => {
    const raw = activeChatsStore.getSnapshot()[sessionId] || null;
    const cached = cacheRef.current;
    if (cached && cached.raw === raw) {
      return cached.selected;
    }
    const nextSelected = selectorRef.current(raw);
    if (cached && isEqualRef.current(cached.selected, nextSelected)) {
      // Selected slice is equal by value — keep the old reference so
      // useSyncExternalStore (and any memoized consumer downstream) sees
      // no change.
      cacheRef.current = { raw, selected: cached.selected };
      return cached.selected;
    }
    cacheRef.current = { raw, selected: nextSelected };
    return nextSelected;
  }, [sessionId]);

  return useSyncExternalStore(
    activeChatsStore.subscribe,
    getSnapshot,
    getSnapshot,
  );
}

export function useActiveChatActions() {
  const context = useContext(ActiveChatsContext);
  if (!context) {
    throw new Error(
      'useActiveChatActions must be used within ActiveChatsProvider',
    );
  }
  return context;
}

export function useAllActiveChats(): ActiveChatsMap {
  return useSyncExternalStore(
    activeChatsStore.subscribe,
    activeChatsStore.getSnapshot,
    activeChatsStore.getSnapshot,
  );
}

export type { ChatUIState };
export { activeChatsStore };
