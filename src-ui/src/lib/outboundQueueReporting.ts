import type { StationConnection } from '../connections/station-connection';
import { chatBelongsToStation } from '../connections/station-state';
import {
  type ChatUIState,
  isTurnInFlight,
} from '../contexts/active-chats-state';
import { activeChatsStore } from '../contexts/active-chats-store';

const UNAVAILABLE_PREFIX = 'Offline queue delivery status is unavailable:';

/**
 * Lazy UI projection for a durable queue uncertainty. Kept beside the queue
 * Implementation so the app shell does not pay for an offline-only path.
 *
 * Only a chat that holds an outbox message has a delivery status to lose, so
 * only those are marked: a chat with nothing in the outbox keeps its own
 * state, as does one with a turn in flight (the error would read as that
 * turn having failed). The next successful read of the queue clears the mark
 * (`outboundQueueUnavailableReported`).
 */
export function reportOutboundQueueUnavailable(
  reason: string,
  connection?: StationConnection,
): void {
  for (const [sessionId, chat] of Object.entries(
    activeChatsStore.getSnapshot(),
  )) {
    if (
      !chat.outboundQueuedTurns?.length ||
      isTurnInFlight(chat) ||
      !chatBelongsToStation(chat, connection)
    )
      continue;
    activeChatsStore.updateChat(sessionId, {
      status: 'error',
      error: `${UNAVAILABLE_PREFIX} ${reason}`,
    });
  }
}

/** Whether the chat's error is the one `reportOutboundQueueUnavailable` wrote. */
export function outboundQueueUnavailableReported(
  chat: Pick<ChatUIState, 'error'> | undefined,
): boolean {
  return !!chat?.error?.startsWith(UNAVAILABLE_PREFIX);
}
