import { activeChatsStore } from '../contexts/active-chats-store';

/**
 * Lazy UI projection for a durable queue uncertainty. Kept beside the queue
 * Implementation so the app shell does not pay for an offline-only path.
 */
export function reportOutboundQueueUnavailable(reason: string): void {
  for (const sessionId of Object.keys(activeChatsStore.getSnapshot())) {
    activeChatsStore.updateChat(sessionId, {
      status: 'error',
      error: `Offline queue delivery status is unavailable: ${reason}`,
    });
  }
}
