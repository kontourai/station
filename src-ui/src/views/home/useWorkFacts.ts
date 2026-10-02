import type { OrchestrationSessionSummary } from '@kontourai/station-sdk';
import { useMemo, useSyncExternalStore } from 'react';
import { activeChatsStore } from '../../contexts/active-chats-store';
import type { HomeWorkItem } from './home-view-model';
import { buildWorkFacts, type WorkFactsById } from './work-facts';

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
