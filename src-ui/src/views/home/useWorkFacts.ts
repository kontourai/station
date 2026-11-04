import type { OrchestrationSessionSummary } from '@kontourai/station-sdk';
import { useMemo } from 'react';
import { useOpenChatStatus } from '../../contexts/open-chat-status';
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
  const chats = useOpenChatStatus();
  return useMemo(
    () => buildWorkFacts({ items, chats, sessions, ...extra }),
    [chats, items, sessions, extra],
  );
}
