import { useSyncExternalStore } from 'react';

/**
 * Whether the ambient dock is showing its New chat draft, as the dock
 * publishes it from its own state (`useChatDockState().showNewChatModal`).
 * The dock owns the fact; this only carries it to a surface outside the dock
 * (Home's start composer), the same way `publishReferenceableConversations`
 * carries the dock's referenceable conversations.
 */
let draftOpen = false;
const listeners = new Set<() => void>();

export function publishDockNewChatDraftOpen(open: boolean): void {
  if (draftOpen === open) return;
  draftOpen = open;
  for (const listener of listeners) listener();
}

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

export function useDockNewChatDraftOpen(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => draftOpen,
    () => false,
  );
}
