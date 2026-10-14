import { activeChatsStore } from '../contexts/active-chats-store';
import {
  currentOutboundStation,
  type OutboundDispatchTurn,
  rowBelongsToStation,
} from '../lib/outboundQueue';

export interface OutboundQueuedTurnProjection {
  clientTurnId: string;
  content: string;
  attachments?: OutboundDispatchTurn['attachments'];
  createdAt: number;
  status: 'pending' | 'invoking' | 'accepted' | 'failed' | 'may-have-started';
  lastError?: string;
  /** Station's newest delivery-lookup answer for this row's key. */
  deliveryCheck?: OutboundDispatchTurn['deliveryCheck'];
  /**
   * The row was written for another Station (its API base): it waits for
   * that Station and is never sent anywhere else.
   */
  waitingForStation?: string;
}

export function projectOutboundQueueEntries(
  entries: readonly OutboundDispatchTurn[],
): void {
  const groups = new Map<string, OutboundDispatchTurn[]>();
  for (const entry of entries) {
    // A live send this renderer is still waiting on is already on screen as
    // its own bubble, with the chat saying "Sending"; listing it here too
    // would show the message twice and call the chat queued.
    if (entry.liveInFlight) continue;
    // A follow-up held in a live chat's own queue is listed there; its row is
    // only the durable copy.
    if (entry.heldBy) continue;
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
        ...(first.projectSlug ? { projectSlug: first.projectSlug } : {}),
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
          deliveryCheck,
          station,
        }) => ({
          clientTurnId,
          content,
          attachments,
          createdAt,
          status,
          lastError,
          mergedTurns,
          ...(deliveryCheck ? { deliveryCheck } : {}),
          ...(station &&
          !rowBelongsToStation({ station }, currentOutboundStation())
            ? { waitingForStation: station.apiBase }
            : {}),
        }),
      ),
    });
  }
}
