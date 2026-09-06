import type { OrchestrationSessionSummary } from '@kontourai/station-sdk';
import { useMemo, useSyncExternalStore } from 'react';
import type { AgentSummary } from '../types';
import type { HomeWorkItem } from '../views/home/home-view-model';
import {
  buildActiveChatTaskItems,
  type ResolveModelLabel,
} from '../views/home/home-view-model';
import { activeChatsStore } from './active-chats-store';

export interface ChatFocusTarget {
  sessionId?: string;
  conversationId?: string;
  agentSlug?: string;
  projectSlug?: string;
  projectName?: string;
  model?: string;
  conversationUpdatedAt?: string;
  /** Stable runtime transcript message id to reveal after opening. */
  messageId?: string;
  threadId?: string;
  /**
   * Remote message-search targets are never eligible for local transcript
   * focus. Their source identity selects the explicit remote-aware route.
   */
  sourceInstanceId?: string;
  sourceInstanceName?: string;
}

export interface OpenChatsNavigation {
  focus: (target: ChatFocusTarget) => void | Promise<void>;
  focusRemote?: (
    target: Required<
      Pick<ChatFocusTarget, 'sourceInstanceId' | 'sourceInstanceName'>
    > &
      ChatFocusTarget,
  ) => void | Promise<void>;
  openCollection: () => void;
}

class OpenChatsStore {
  private navigation: OpenChatsNavigation | null = null;
  private pending: ChatFocusTarget | null = null;

  subscribe = activeChatsStore.subscribe;
  getSnapshot = activeChatsStore.getSnapshot;

  select(
    agents: AgentSummary[],
    sessions: OrchestrationSessionSummary[] = [],
  ): HomeWorkItem[] {
    return buildActiveChatTaskItems({
      chats: this.getSnapshot(),
      agents,
      sessions,
    });
  }

  focus(target: ChatFocusTarget) {
    if (target.sourceInstanceId && target.sourceInstanceName) {
      // A remote ID may collide with a local conversation ID. Never queue it
      // for the local navigator; a missing remote handler is intentionally a
      // no-op rather than a silently wrong local open.
      void this.navigation?.focusRemote?.(
        target as Required<
          Pick<ChatFocusTarget, 'sourceInstanceId' | 'sourceInstanceName'>
        > &
          ChatFocusTarget,
      );
      return;
    }
    if (!this.navigation) {
      this.pending = target;
      return;
    }
    void this.navigation.focus(target);
  }

  openCollection() {
    this.navigation?.openCollection();
  }

  registerNavigation(navigation: OpenChatsNavigation) {
    this.navigation = navigation;
    const pending = this.pending;
    this.pending = null;
    if (pending && this.hasTarget(pending)) void navigation.focus(pending);
    return () => {
      if (this.navigation === navigation) this.navigation = null;
    };
  }

  private hasTarget(target: ChatFocusTarget): boolean {
    const targetId =
      target.sessionId ?? target.conversationId ?? target.threadId;
    return Boolean(
      targetId &&
        Object.entries(this.getSnapshot()).some(
          ([sessionId, chat]) =>
            sessionId === targetId || chat.conversationId === targetId,
        ),
    );
  }
}

export const openChatsStore = new OpenChatsStore();

/**
 * The identity of an open chat and nothing else — what a navigation surface
 * needs to offer a row and open it.
 */
export interface OpenChatIdentity {
  sessionId: string;
  /** What a list renders. Derived here so every consumer names a chat alike. */
  label: string;
  agentSlug?: string;
  projectSlug?: string;
}

const EMPTY_IDENTITIES: readonly OpenChatIdentity[] = Object.freeze([]);
let identitiesCache: readonly OpenChatIdentity[] = EMPTY_IDENTITIES;
let identitiesSignature: string | null = null;

/**
 * Identity-only projection of the open-chat map, returning the SAME array
 * reference until an id, label, agent or project actually changes.
 *
 * The reference stability is the point, not a nicety. `activeChatsStore`
 * notifies on every store mutation, and streaming updates it once per token
 * (`streamHandlers.ts`). A consumer subscribed to the raw snapshot therefore
 * gets a new object per token and rebuilds whatever it derived — for the
 * command palette that was its entire command index, reranked and regrouped,
 * on every token of every streaming chat, including while the palette was
 * closed and about to return `null`. Message text is not part of a chat's
 * identity, so this projection does not change when it arrives.
 */
export function openChatIdentitiesSnapshot(): readonly OpenChatIdentity[] {
  const chats = openChatsStore.getSnapshot();
  const next: OpenChatIdentity[] = [];
  let signature = '';
  for (const [sessionId, chat] of Object.entries(chats)) {
    const label = chat.title || chat.agentSlug || 'Untitled chat';
    next.push({
      sessionId,
      label,
      ...(chat.agentSlug ? { agentSlug: chat.agentSlug } : {}),
      ...(chat.projectSlug ? { projectSlug: chat.projectSlug } : {}),
    });
    // \u0000/\u0001 cannot appear in these values, so the join is unambiguous
    // — two different chat lists cannot produce one signature.
    signature += `${sessionId}\u0000${label}\u0000${chat.agentSlug ?? ''}\u0000${chat.projectSlug ?? ''}\u0001`;
  }
  if (signature === identitiesSignature) return identitiesCache;
  identitiesSignature = signature;
  identitiesCache = Object.freeze(next);
  return identitiesCache;
}

/** Test seam: the projection cache is module state. */
export function resetOpenChatIdentitiesCacheForTests() {
  identitiesSignature = null;
  identitiesCache = EMPTY_IDENTITIES;
}

export function countOpenChatAttention(
  chats: ReadonlyArray<{ hasUnread?: boolean }>,
): number {
  return chats.reduce((count, chat) => count + (chat.hasUnread ? 1 : 0), 0);
}

/**
 * #1582 B9: the chats that are WORK — what "Continue most recent work" and
 * Home's Recent work may name. A chat created and never typed into produced a
 * "Continue most recent work → New chat" card that a reload erased; the store
 * never writes such a chat, so it was never work.
 *
 * Deliberately a second hook rather than a filter inside `useOpenChats`: the
 * dock inbox and the sidebar's mini-inbox list the chats OPEN IN THIS TAB, and
 * a chat the user is looking at belongs in both whatever its contents. Two
 * questions, two selectors, one shared predicate.
 */
export function useOpenWorkChats(
  agents: AgentSummary[],
  sessions: OrchestrationSessionSummary[] = [],
  resolveModelLabel?: ResolveModelLabel,
): HomeWorkItem[] {
  const chats = useSyncExternalStore(
    openChatsStore.subscribe,
    openChatsStore.getSnapshot,
    openChatsStore.getSnapshot,
  );
  return useMemo(
    () =>
      buildActiveChatTaskItems({
        chats,
        agents,
        sessions,
        onlyWork: true,
        ...(resolveModelLabel ? { resolveModelLabel } : {}),
      }),
    [agents, chats, sessions, resolveModelLabel],
  );
}

export function useOpenChats(
  agents: AgentSummary[],
  sessions: OrchestrationSessionSummary[] = [],
  /**
   * archive#3391: supplied by a caller that holds the model catalog, so the
   * rows it renders name a model the same way the New Chat surfaces do.
   * Omitted by callers with no catalog (the store's own `select`), which then
   * take `buildActiveChatTaskItems`'s catalog-free default.
   */
  resolveModelLabel?: ResolveModelLabel,
): HomeWorkItem[] {
  const chats = useSyncExternalStore(
    openChatsStore.subscribe,
    openChatsStore.getSnapshot,
    openChatsStore.getSnapshot,
  );
  return useMemo(
    () =>
      buildActiveChatTaskItems({
        chats,
        agents,
        sessions,
        ...(resolveModelLabel ? { resolveModelLabel } : {}),
      }),
    [agents, chats, sessions, resolveModelLabel],
  );
}
