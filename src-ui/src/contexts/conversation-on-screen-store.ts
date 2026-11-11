import { useEffect, useSyncExternalStore } from 'react';
import { isCurrentInboxItem } from '../views/home/conversation-read-state';
import type { HomeWorkItem } from '../views/home/home-view-model';

/**
 * #3075: the conversation a person is looking at right now, the dock's
 * current chat while its pane is open and not covered, so every surface that
 * draws a work row (the dock inbox, the phone inbox, Home) agrees on which
 * row is being read. Published by the dock, the one owner of that answer;
 * window focus is checked by the reader. `null` when none is on screen.
 */
let onScreen: { owner: symbol; chatId: string } | null = null;
const listeners = new Set<() => void>();

function notify() {
  for (const listener of listeners) listener();
}

export const conversationOnScreenStore = {
  /** The owner's answer replaces any other; `null` withdraws it. */
  publish(owner: symbol, chatId: string | null) {
    const next = chatId ? { owner, chatId } : null;
    if (onScreen?.owner === next?.owner && onScreen?.chatId === next?.chatId)
      return;
    if (!next && onScreen && onScreen.owner !== owner) return;
    onScreen = next;
    notify();
  },
  /** Withdraws the owner's answer, and only the owner's. */
  release(owner: symbol) {
    if (onScreen?.owner !== owner) return;
    onScreen = null;
    notify();
  },
  current(): string | null {
    return onScreen?.chatId ?? null;
  },
  subscribe(listener: () => void) {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },
};

/** Publishes `chatId` as on screen for the lifetime of the calling host. */
export function usePublishConversationOnScreen(chatId: string | null): void {
  useEffect(() => {
    const owner = Symbol('conversation-on-screen');
    conversationOnScreenStore.publish(owner, chatId);
    return () => conversationOnScreenStore.release(owner);
  }, [chatId]);
}

/** Whether `item` is the conversation on screen (focus not considered). */
export function useConversationOnScreen(
  item: Pick<HomeWorkItem, 'chatSessionId' | 'orchestrationThreadId'>,
): boolean {
  const chatId = useSyncExternalStore(
    conversationOnScreenStore.subscribe,
    conversationOnScreenStore.current,
    () => null,
  );
  return isCurrentInboxItem(item, chatId);
}
