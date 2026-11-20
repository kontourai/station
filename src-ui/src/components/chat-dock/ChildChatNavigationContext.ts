import type { ChildWorkItem } from '@kontourai/station-contracts/child-work';
import { createContext, type ReactNode, useContext } from 'react';
import type { ConversationConnection } from '../conversation/ConversationConnectionContext';
export interface ChildChatTarget {
  title: string;
  threadId: string;
  childId?: string;
  engineId?: string;
  running?: boolean;
  revision?: string;
  connection: ConversationConnection;
  returnFocus?: HTMLElement;
}

export function childChatTarget(
  item: ChildWorkItem,
  connection: ConversationConnection,
): ChildChatTarget {
  const handle = item.result?.handle;
  const sessionId =
    handle?.kind === 'session'
      ? handle.threadId
      : item.producer === 'station-delegate'
        ? item.childId
        : undefined;
  return {
    title: item.title || (sessionId ? 'Delegate' : 'Subagent'),
    threadId: sessionId ?? item.reporterThreadId,
    ...(sessionId ? {} : { childId: item.childId }),
    engineId:
      item.transcript?.kind === 'codex-thread'
        ? 'codex'
        : item.transcript?.kind === 'claude-subagent'
          ? 'claude'
          : undefined,
    running: item.status === 'running',
    revision: JSON.stringify([item.status, item.progress, item.usage]),
    connection,
  };
}

export const ChildChatContext = createContext<
  ((target: ChildChatTarget) => void) | null
>(null);
export function useChildChatNavigation() {
  return useContext(ChildChatContext);
}

export const ChildChatCoveredContext = createContext(false);
export function useIsChildChatCovered() {
  return useContext(ChildChatCoveredContext);
}

export interface ChildChatController {
  open: (target: ChildChatTarget) => void;
  reset: () => void;
}

export const ChildChatPresentationContext = createContext<{
  trail: ReactNode;
  pane: ReactNode;
} | null>(null);
export function useChildChatTrail() {
  return useContext(ChildChatPresentationContext)?.trail;
}
export function ChildChatOutlet() {
  return useContext(ChildChatPresentationContext)?.pane;
}
