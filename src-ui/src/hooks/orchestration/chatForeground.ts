import { isTurnInFlight } from '../../contexts/active-chats-state';
import { activeChatsStore } from '../../contexts/active-chats-store';
import { navigationStore } from '../../contexts/NavigationContext';

/**
 * How many full-screen Chat placements are mounted. A full-screen Chat never
 * sets `isDockOpen` (it is a workspace pane, not the ambient dock), so without
 * this the chat a user is reading there would count as background and get
 * its own end-of-turn toast.
 */
let fullscreenChatSurfaces = 0;

/** Called by a full-screen Chat placement for as long as it is mounted. */
export function registerFullscreenChatSurface(): () => void {
  fullscreenChatSurfaces += 1;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    fullscreenChatSurfaces -= 1;
  };
}

/**
 * Is this chat the one on screen: the page is visible, a Chat surface is
 * showing, and the chat it shows is this one (by chat key, execution session,
 * or conversation).
 */
export function isChatInForeground(ids: {
  chatKey?: string;
  threadId: string;
  conversationId?: string;
}): boolean {
  if (
    typeof document !== 'undefined' &&
    document.visibilityState === 'hidden'
  ) {
    return false;
  }
  const navigation = navigationStore.getSnapshot();
  if (!navigation.isDockOpen && fullscreenChatSurfaces === 0) return false;
  const candidates = [ids.chatKey, ids.threadId, ids.conversationId].filter(
    (value): value is string => Boolean(value),
  );
  return candidates.some(
    (id) =>
      navigation.activeChat === id || navigation.activeConversation === id,
  );
}

/**
 * Does this page show a chat whose turn is still running? The focus reporter
 * keeps a focused window present without input while this holds (a person
 * watching a turn finish is not typing), and lets it lapse once the turn
 * ends.
 */
export function isWatchingRunningTurn(): boolean {
  for (const [chatKey, chat] of Object.entries(
    activeChatsStore.getSnapshot(),
  )) {
    if (!isTurnInFlight(chat)) continue;
    if (
      isChatInForeground({
        chatKey,
        threadId: chat.currentSessionId ?? chatKey,
        conversationId: chat.conversationId,
      })
    )
      return true;
  }
  return false;
}
