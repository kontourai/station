import type { OrchestrationSessionSummary } from '@kontourai/station-sdk';
import { useMemo } from 'react';
import { useOpenChatInbox } from '../../contexts/open-chats-store';
import type { AgentSummary } from '../../types';
import {
  buildHomeWorkItems,
  type HomeWorkItem,
  type ResolveModelLabel,
} from './home-view-model';

/**
 * THE inbox's items: every chat open in this tab merged with the server
 * session it correlates with, plus every other local session, by the one
 * derivation Home's work list also runs (`buildHomeWorkItems`).
 *
 * The dock inbox, the mobile task switcher and the sidebar's Open-chats
 * mini-inbox all read their rows from here. Before this hook the sidebar
 * built its rows from `useOpenChats` alone, which labels a chat from the
 * chat store and borrows only Running/Failed/Draft from the session; a
 * session awaiting an approval therefore read "Needs approval" in the dock
 * and "Idle" in the sidebar for the same chat. One item, one ladder
 * (`workStatus`), so two surfaces cannot disagree.
 *
 * A chat open in this tab always has exactly one item here: chat items are
 * the base of the merge, and the only path that folds a chat away (a durable
 * Task that owns it) takes `tasks`, which the inbox does not pass. The second
 * tab of one conversation folds into its newest child, as it always did.
 */
export function useInboxWorkItems(
  agents: AgentSummary[],
  sessions: OrchestrationSessionSummary[],
  resolveModelLabel?: ResolveModelLabel,
): HomeWorkItem[] {
  const { items: openChatItems, currentSessionIdByConversation } =
    useOpenChatInbox(agents, sessions, resolveModelLabel);
  return useMemo(
    () =>
      buildHomeWorkItems({
        chats: {},
        sessions,
        agents,
        chatItems: openChatItems,
        currentSessionIdByConversation,
        ...(resolveModelLabel ? { resolveModelLabel } : {}),
      }),
    [
      agents,
      currentSessionIdByConversation,
      openChatItems,
      resolveModelLabel,
      sessions,
    ],
  );
}

/**
 * The inbox items that are chats open in this tab, in inbox order: the
 * sidebar's mini-inbox is this slice of the dock's list, never a list of its
 * own. A merged row keeps its chat's `chatSessionId`, which is the lookup.
 */
export function openChatInboxRows(
  items: readonly HomeWorkItem[],
): HomeWorkItem[] {
  return items.filter((item) => item.chatSessionId !== undefined);
}
