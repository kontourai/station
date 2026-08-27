import { activeChatsStore } from '../contexts/active-chats-store';
import type { OutboundDispatchTurn } from '../lib/outboundQueue';

export interface OutboundQueuedTurnProjection {
  clientTurnId: string;
  content: string;
  attachments?: OutboundDispatchTurn['attachments'];
  createdAt: number;
  status: 'pending' | 'invoking' | 'accepted' | 'failed' | 'may-have-started';
  lastError?: string;
}

export function projectOutboundQueueEntries(
  entries: readonly OutboundDispatchTurn[],
): void {
  const groups = new Map<string, OutboundDispatchTurn[]>();
  for (const entry of entries) {
    const group = groups.get(entry.sessionId) ?? [];
    group.push(entry);
    groups.set(entry.sessionId, group);
  }

  for (const [sessionId, chat] of Object.entries(
    activeChatsStore.getSnapshot(),
  )) {
    if (!chat.outboundQueuedTurns?.length || groups.has(sessionId)) continue;
    activeChatsStore.updateChat(sessionId, {
      outboundQueuedTurns: [],
      ...(chat.status === 'queued' ? { status: 'idle' } : {}),
    });
  }

  for (const [sessionId, queued] of groups) {
    if (!activeChatsStore.getSnapshot()[sessionId]) {
      const first = queued[0]!;
      activeChatsStore.initChat(sessionId, {
        agentSlug: first.agentSlug,
        agentName: first.agentSlug,
        title: 'Queued message',
        conversationId: first.conversationId,
      });
    }
    activeChatsStore.updateChat(sessionId, {
      status: 'queued',
      outboundQueuedTurns: queued.map(
        ({
          clientTurnId,
          content,
          attachments,
          createdAt,
          status,
          lastError,
          mergedTurns,
        }) => ({
          clientTurnId,
          content,
          attachments,
          createdAt,
          status,
          lastError,
          mergedTurns,
        }),
      ),
    });
  }
}
