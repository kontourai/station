import type { Notification } from '@kontourai/station-contracts/notification';
import { markNotificationRead } from '@kontourai/station-sdk/notification-read';
import { readNotificationEnvelope } from '@kontourai/station-shared/notification-envelope';
import { activeChatsStore } from '../../contexts/active-chats-store';
import { navigationStore } from '../../contexts/NavigationContext';
import { CLIENT_DOCUMENT_SESSION_ID } from '../clientDocumentSession';
import { isChatInForeground } from './chatForeground';

/**
 * A turn-completion record is read once its chat is on screen in a focused
 * window: the person has seen the ending it announces. Marking it read is
 * what cancels the server's escalation of a failure to the person's other
 * surfaces and retracts alerts already sent for it (the delivery router's
 * read check). Covers both a turn ending while its chat is watched and
 * opening the chat later; opening the record itself marks it too
 * (`activateNotification`).
 */

/** The server's turn-completion listener writes under this source. */
const TURN_COMPLETION_SOURCE = 'turn-completion';
/** Bounds the ids already asked for; the oldest is forgotten first. */
const REQUESTED_LIMIT = 500;

/** Unread, undismissed turn-completion records whose session is watched. */
export function watchedTurnNotificationIds(
  notifications: readonly Pick<
    Notification,
    'id' | 'source' | 'status' | 'metadata'
  >[],
  isWatched: (sessionId: string) => boolean,
): string[] {
  const ids: string[] = [];
  for (const notification of notifications) {
    if (notification.source !== TURN_COMPLETION_SOURCE) continue;
    if (notification.status !== 'delivered') continue;
    const envelope = readNotificationEnvelope(notification);
    if (!envelope || envelope.readAt || envelope.dismissedAt) continue;
    if (envelope.audience.kind !== 'session-readers') continue;
    if (isWatched(envelope.audience.sessionId)) ids.push(notification.id);
  }
  return ids;
}

/** Is this session's chat in front of the user in a focused window? */
export function isTurnSessionWatched(sessionId: string): boolean {
  if (typeof document === 'undefined' || !document.hasFocus()) return false;
  const chatKey =
    activeChatsStore.getChatKeyForExecutionSession(sessionId) ?? sessionId;
  const chat = activeChatsStore.getSnapshot()[chatKey];
  return isChatInForeground({
    chatKey,
    threadId: sessionId,
    conversationId: chat?.conversationId,
  });
}

export interface TurnNotificationReader {
  /** The latest live notification list. */
  update(notifications: readonly Notification[]): void;
  /** Re-checks the latest list (focus or navigation changed). */
  evaluate(): void;
}

export function createTurnNotificationReader(deps: {
  isWatched(sessionId: string): boolean;
  markRead(id: string): Promise<unknown>;
}): TurnNotificationReader {
  let latest: readonly Notification[] = [];
  const requested = new Set<string>();
  const evaluate = () => {
    for (const id of watchedTurnNotificationIds(latest, deps.isWatched)) {
      if (requested.has(id)) continue;
      requested.add(id);
      if (requested.size > REQUESTED_LIMIT) {
        const oldest = requested.values().next().value;
        if (oldest !== undefined) requested.delete(oldest);
      }
      // A failed mark leaves the record unread; the next change retries.
      void deps.markRead(id).catch(() => requested.delete(id));
    }
  };
  return {
    update(notifications) {
      latest = notifications;
      evaluate();
    },
    evaluate,
  };
}

/** Starts marking watched turn records read; returns the reader and a stop. */
export function startTurnNotificationReads(): TurnNotificationReader & {
  stop(): void;
} {
  const reader = createTurnNotificationReader({
    isWatched: isTurnSessionWatched,
    markRead: (id) =>
      markNotificationRead({ id, clientSessionId: CLIENT_DOCUMENT_SESSION_ID }),
  });
  const unsubscribe = navigationStore.subscribe(reader.evaluate);
  window.addEventListener('focus', reader.evaluate);
  document.addEventListener('visibilitychange', reader.evaluate);
  return {
    ...reader,
    stop() {
      unsubscribe();
      window.removeEventListener('focus', reader.evaluate);
      document.removeEventListener('visibilitychange', reader.evaluate);
    },
  };
}
