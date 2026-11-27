import type { HomeWorkItem } from './home-view-model';

/** Whether `item` is the dock's current chat (its live tab or thread). */
export function isCurrentInboxItem(
  item: Pick<HomeWorkItem, 'chatSessionId' | 'orchestrationThreadId'>,
  activeChatSessionId: string | null | undefined,
): boolean {
  if (!activeChatSessionId) return false;
  return (
    item.chatSessionId === activeChatSessionId ||
    item.orchestrationThreadId === activeChatSessionId
  );
}

/**
 * Whether a row reads as unread right now (#3075). The server's answer
 * (`HomeWorkItem.unread`, from the inventory's `readState`), except that the
 * conversation a person is looking at (the dock's current chat, in a focused
 * window) is never unread: output arriving while it is on screen is read as
 * it lands, and `useAcknowledgeVisibleConversation` tells the server so.
 */
export function rowReadsUnread(
  item: Pick<HomeWorkItem, 'unread'>,
  beingRead: boolean,
): boolean {
  return item.unread === true && !beingRead;
}

/**
 * #3075 review: whether a row reads as "read state unknown" right now: the
 * server could not read this person's read state. Never shown as read or
 * unread; the conversation on screen needs neither.
 */
export function rowReadStateUnknown(
  item: Pick<HomeWorkItem, 'readStateUnavailable'>,
  beingRead: boolean,
): boolean {
  return item.readStateUnavailable === true && !beingRead;
}
