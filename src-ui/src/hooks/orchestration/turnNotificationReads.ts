import {
  type Notification,
  TURN_COMPLETION_NOTIFICATION_SOURCE,
} from '@kontourai/station-contracts/notification';
import { markNotificationRead } from '@kontourai/station-sdk/notification-read';
import { readNotificationEnvelope } from '@kontourai/station-shared/notification-envelope';
import { activeChatsStore } from '../../contexts/active-chats-store';
import { navigationStore } from '../../contexts/NavigationContext';
import { CLIENT_DOCUMENT_SESSION_ID } from '../clientDocumentSession';
import { FOCUS_INPUT_RECENCY_MS } from '../focusReporter';
import { isChatInForeground } from './chatForeground';
import { startOpenedNotificationReads } from './openedNotificationRead';

/**
 * A turn-completion record is read once the person attends to its chat: the
 * chat is on screen in a focused window AND there was input in the last
 * `FOCUS_INPUT_RECENCY_MS`. Marking it read cancels the server's escalation
 * of a failure to the person's other surfaces and retracts alerts already
 * sent for it (the delivery router's read check), so focus alone is not
 * enough: the focus reporter keeps a window showing a running turn "present"
 * without input (so a finished turn does not buzz other devices), and a
 * person who walked away from it must still hear about a failure. Covers a
 * turn ending while its chat is attended, coming back to it (the first
 * input re-checks), and navigating to the chat with input (a click). A
 * deep link loaded without input reads nothing here; opening the record
 * marks it instead: from the inbox (`activateNotification`) or from an OS
 * alert (`openedNotificationRead.ts`).
 *
 * Accepted gap: attention is "input within the window", so input made just
 * before walking away still reads a failure that lands within
 * `FOCUS_INPUT_RECENCY_MS` of it.
 *
 * Known limit: read state is per record, not per person. A record whose
 * audience is the session's readers is marked read by whichever reader
 * attends first, which also cancels the escalation for every other reader.
 */

/** The server's turn-completion listener writes under this source. */
const TURN_COMPLETION_SOURCE = TURN_COMPLETION_NOTIFICATION_SOURCE;
/** Bounds the ids already asked for; the oldest is forgotten first. */
const REQUESTED_LIMIT = 500;
/** Input that also counts as attention (the focus reporter's set). */
const INPUT_EVENTS = [
  'pointerdown',
  'pointermove',
  'keydown',
  'wheel',
  'touchstart',
] as const;
/**
 * Input re-checks the list at most this often: at once on the first input,
 * then once more when the window closes if input arrived inside it.
 */
export const INPUT_RECHECK_MS = 1_000;

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

/**
 * Is the person attending to this session's chat: input within
 * `FOCUS_INPUT_RECENCY_MS` (`lastInputAt`, epoch ms), and the chat in front
 * of them in a focused window?
 */
export function isTurnSessionAttended(
  sessionId: string,
  lastInputAt: number,
  now: number,
): boolean {
  if (now - lastInputAt > FOCUS_INPUT_RECENCY_MS) return false;
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
  let lastInputAt = Number.NEGATIVE_INFINITY;
  let lastRecheckAt = Number.NEGATIVE_INFINITY;
  let trailing: ReturnType<typeof setTimeout> | undefined;
  const markRead = (id: string) =>
    markNotificationRead({ id, clientSessionId: CLIENT_DOCUMENT_SESSION_ID });
  const reader = createTurnNotificationReader({
    isWatched: (sessionId) =>
      isTurnSessionAttended(sessionId, lastInputAt, Date.now()),
    markRead,
  });
  const recheck = () => {
    lastRecheckAt = Date.now();
    reader.evaluate();
  };
  const onInput = () => {
    const now = Date.now();
    lastInputAt = now;
    if (now - lastRecheckAt >= INPUT_RECHECK_MS) {
      recheck();
      return;
    }
    // Inside the window: one trailing check when it closes, so the last
    // input of a burst is not lost.
    trailing ??= setTimeout(
      () => {
        trailing = undefined;
        recheck();
      },
      lastRecheckAt + INPUT_RECHECK_MS - now,
    );
  };
  const stopOpened = startOpenedNotificationReads(markRead);
  const unsubscribe = navigationStore.subscribe(reader.evaluate);
  window.addEventListener('focus', reader.evaluate);
  document.addEventListener('visibilitychange', reader.evaluate);
  for (const type of INPUT_EVENTS)
    window.addEventListener(type, onInput, { passive: true, capture: true });
  return {
    ...reader,
    stop() {
      if (trailing !== undefined) clearTimeout(trailing);
      stopOpened();
      unsubscribe();
      window.removeEventListener('focus', reader.evaluate);
      document.removeEventListener('visibilitychange', reader.evaluate);
      for (const type of INPUT_EVENTS)
        window.removeEventListener(type, onInput, { capture: true });
    },
  };
}
