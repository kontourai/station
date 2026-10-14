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
  /**
   * Held behind a turn by another window or by one that closed: nothing
   * sends it until the user does.
   */
  heldElsewhere?: true;
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
    // A follow-up this window's own queue holds is listed there; its row is
    // only the durable copy. One held anywhere else (another window, or a
    // window that closed) is listed here, never sent without the user.
    if (entry.heldHere) continue;
    const group = groups.get(entry.sessionId) ?? [];
    group.push(entry);
    groups.set(entry.sessionId, group);
  }

  // A refused queued follow-up the chat already shows as "Not sent" (same
  // key) is listed once, there; its durable row stays behind it.
  for (const [sessionId, queued] of [...groups]) {
    const unsent = new Set(
      (activeChatsStore.getSnapshot()[sessionId]?.unsentMessages ?? []).map(
        (record) => record.id,
      ),
    );
    if (unsent.size === 0) continue;
    const visible = queued.filter(
      (entry) => !(entry.status === 'failed' && unsent.has(entry.clientTurnId)),
    );
    if (visible.length) groups.set(sessionId, visible);
    else groups.delete(sessionId);
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
    // A copy held by another or a closed window is listed first: it was
    // written before anything queued after it, and it waits on the user.
    const ordered = [
      ...queued.filter((entry) => entry.heldBy),
      ...queued.filter((entry) => !entry.heldBy),
    ];
    activeChatsStore.updateChat(sessionId, {
      status: 'queued',
      outboundQueuedTurns: ordered.map(
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
          heldBy,
        }) => ({
          clientTurnId,
          content,
          attachments,
          createdAt,
          status,
          lastError,
          mergedTurns,
          ...(deliveryCheck ? { deliveryCheck } : {}),
          ...(heldBy ? { heldElsewhere: true as const } : {}),
          ...(station &&
          !rowBelongsToStation({ station }, currentOutboundStation())
            ? { waitingForStation: station.apiBase }
            : {}),
        }),
      ),
    });
  }
}
