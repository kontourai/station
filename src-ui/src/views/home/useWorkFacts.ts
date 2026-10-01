import {
  acknowledgeConversation,
  conversationQueries,
  type OrchestrationSessionSummary,
} from '@kontourai/station-sdk';
import { useQueryClient } from '@tanstack/react-query';
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useSyncExternalStore,
} from 'react';
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

function subscribeToVisibility(onChange: () => void): () => void {
  document.addEventListener('visibilitychange', onChange);
  return () => document.removeEventListener('visibilitychange', onChange);
}

/** The page is actually being shown (not a background tab or hidden app). */
function usePageVisible(): boolean {
  return useSyncExternalStore(
    subscribeToVisibility,
    () => document.visibilityState === 'visible',
    () => true,
  );
}

/**
 * Acknowledges the conversation that is ON SCREEN, at the version on screen.
 *
 * Acknowledgement used to be written only when a row was activated, so a
 * chat read and replied to in the dock was "unread" the moment the user
 * switched away, and again after every reply: the version had moved on and
 * nothing recorded that they had watched it happen. A conversation that is
 * displayed, on a visible page, has been seen.
 *
 * WHEN IT WRITES. Only while all of these hold:
 * - a conversation is displayed (`displayedChatSessionId`; the host passes
 *   `null` while the dock is closed or something covers the chat);
 * - the page is visible. A completion landing in a background tab is not
 *   seen; it is acknowledged when the page comes back.
 * - no turn is running in it. A session's `updatedAt` moves on EVERY event
 *   (`orchestration-session-state.ts` stamps `event.createdAt` for any
 *   method), so a streaming turn is a new version many times a second.
 *   Acknowledging each would be a write per event; the settled version is
 *   acknowledged once, when the turn ends. That also covers the user's own
 *   send, which is the start of such a turn.
 *
 * Each version is attempted once. A failed write is not retried for that
 * version; the next version is a fresh attempt.
 */
export function useAcknowledgeDisplayedConversation({
  items,
  displayedChatSessionId,
  acknowledge,
}: {
  items: readonly HomeWorkItem[];
  displayedChatSessionId: string | null;
  acknowledge: (item: HomeWorkItem) => void | Promise<void>;
}): void {
  const pageVisible = usePageVisible();
  const displayed =
    displayedChatSessionId && pageVisible
      ? items.find(
          (item) =>
            item.chatSessionId === displayedChatSessionId ||
            item.orchestrationThreadId === displayedChatSessionId,
        )
      : undefined;
  const pending =
    displayed &&
    displayed.lifecycleLabel !== 'Running' &&
    changedSinceAcknowledged(displayed)
      ? displayed
      : undefined;
  const version = pending
    ? `${pending.id}\u0000${pending.conversationUpdatedAt}`
    : null;
  const lastAttempted = useRef<string | null>(null);
  const latest = useRef({ pending, acknowledge });
  latest.current = { pending, acknowledge };
  useEffect(() => {
    if (version === null || lastAttempted.current === version) return;
    lastAttempted.current = version;
    const { pending: item, acknowledge: write } = latest.current;
    if (!item) return;
    // A refused or failed write leaves the row unread, which is true.
    try {
      void Promise.resolve(write(item)).catch(() => {});
    } catch {
      // Same as a rejected write.
    }
  }, [version]);
}

type InventoryCache =
  | {
      pages: {
        items: { id: string; acknowledgedAt?: string }[];
      }[];
    }
  | undefined;

/**
 * The write `useAcknowledgeDisplayedConversation` makes for the dock: the
 * acknowledgement request, then the acknowledged version patched into the
 * cached conversation inventory.
 *
 * Patched, not invalidated. `useAcknowledgeConversationMutation` invalidates
 * the whole inventory, which is right for one deliberate row click and wrong
 * here: a re-read can return a newer version, which would be acknowledged,
 * which would re-read. The server stores exactly the version sent, so the
 * cache can be told the same thing without asking.
 */
export function useInventoryAcknowledgeWriter(): (
  item: HomeWorkItem,
) => Promise<void> {
  const queryClient = useQueryClient();
  return useCallback(
    async (item: HomeWorkItem) => {
      const updatedAt = item.conversationUpdatedAt;
      if (!updatedAt) return;
      await acknowledgeConversation(item.id, updatedAt);
      queryClient.setQueryData(
        conversationQueries.inventory().queryKey,
        (cached: InventoryCache) =>
          cached && {
            ...cached,
            pages: cached.pages.map((page) => ({
              ...page,
              items: page.items.map((conversation) =>
                conversation.id === item.id
                  ? { ...conversation, acknowledgedAt: updatedAt }
                  : conversation,
              ),
            })),
          },
      );
    },
    [queryClient],
  );
}
