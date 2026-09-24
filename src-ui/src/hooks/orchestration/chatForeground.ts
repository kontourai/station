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
 * Is this chat the one on screen: a Chat surface is showing, and the chat it
 * shows is this one (by chat key, execution session, or conversation).
 */
export function isChatInForeground(ids: {
  chatKey?: string;
  threadId: string;
  conversationId?: string;
}): boolean {
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
