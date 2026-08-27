import {
  fetchAgentConversationPage,
  fetchOrchestrationSessions,
} from '@kontourai/station-sdk';
import { useEffect } from 'react';
import { activeChatsStore } from '../contexts/active-chats-store';

type PersistedChats = ReturnType<typeof activeChatsStore.getSnapshot>;
type PersistedChatEntry = [string, PersistedChats[string]];

function isCanonicalProviderEntry([
  sessionId,
  chat,
]: PersistedChatEntry): boolean {
  return Boolean(
    chat.provider &&
      chat.provider !== 'bedrock' &&
      chat.conversationId === sessionId,
  );
}

function removeMissing(entries: PersistedChatEntry[], durableIds: Set<string>) {
  for (const [sessionId, chat] of entries) {
    if (chat.conversationId && !durableIds.has(chat.conversationId)) {
      activeChatsStore.removeChat(sessionId);
    }
  }
}

async function reconcileCanonicalProviderEntries(
  entries: PersistedChatEntry[],
) {
  if (entries.length === 0) return;
  try {
    const ids = new Set(
      (await fetchOrchestrationSessions()).map((session) => session.threadId),
    );
    removeMissing(entries, ids);
  } catch {
    // Keep sessions if the owning catalog is unavailable.
  }
}

async function reconcileEntries(entries: PersistedChatEntry[]) {
  const byAgent = new Map<string, PersistedChatEntry[]>();
  for (const entry of entries) {
    const slug = entry[1].agentSlug!;
    byAgent.set(slug, [...(byAgent.get(slug) ?? []), entry]);
  }
  for (const [slug, sessions] of byAgent) {
    try {
      const page = await fetchAgentConversationPage(slug, { limit: 100 });
      if (page.hasMore) continue;
      const ids = new Set(
        page.items.map((conversation) => (conversation as { id: string }).id),
      );
      removeMissing(sessions, ids);
    } catch {
      // Keep sessions if the backend is unavailable.
    }
  }
}

/**
 * Reconciles persisted chat tabs against durable conversations without
 * depending on the ActiveChats React context. Keeping this as a leaf hook lets
 * the context initialize pruning without importing its own public hook barrel.
 */
export function usePruneActiveChats() {
  useEffect(() => {
    const chats = activeChatsStore.getSnapshot();
    const entries = Object.entries(chats).filter(
      ([, chat]) => chat.conversationId && chat.agentSlug,
    );
    if (entries.length === 0) {
      return;
    }

    const canonicalProviderEntries = entries.filter(isCanonicalProviderEntry);
    void Promise.all([
      reconcileCanonicalProviderEntries(canonicalProviderEntries),
      reconcileEntries(
        entries.filter((entry) => !isCanonicalProviderEntry(entry)),
      ),
    ]);
  }, []);
}
