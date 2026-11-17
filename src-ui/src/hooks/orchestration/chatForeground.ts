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

/**
 * Listeners for the counts below. Fullscreen placements and reader covers
 * live outside the navigation and chat stores, so a change to either must
 * say so itself, or the focus report keeps naming a chat no longer on screen.
 */
const surfaceListeners = new Set<() => void>();
function surfacesChanged(): void {
  for (const listener of [...surfaceListeners]) {
    try {
      listener();
    } catch {
      // One listener's failure must not hide the change from the others.
    }
  }
}

/** Called by a full-screen Chat placement for as long as it is mounted. */
export function registerFullscreenChatSurface(): () => void {
  fullscreenChatSurfaces += 1;
  surfacesChanged();
  let released = false;
  return () => {
    if (released) return;
    released = true;
    fullscreenChatSurfaces -= 1;
    surfacesChanged();
  };
}

/**
 * Opaque readers, including Inbox and New chat, cover the retained chat.
 * A covered transcript is not being read, even while its dock stays open.
 */
let chatReaderCovers = 0;

/** Register only while an opaque reader visibly covers this chat. */
export function registerChatReaderCover(): () => void {
  chatReaderCovers += 1;
  surfacesChanged();
  let released = false;
  return () => {
    if (released) return;
    released = true;
    chatReaderCovers -= 1;
    surfacesChanged();
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
  if (chatReaderCovers > 0) return false;
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

/** Bound and grammar of what the focus report may say is on screen. */
const VIEWING_IDS_MAX = 4;
const VIEWING_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

/**
 * The ids of the chat on screen, for the focus report's `viewingSessionIds`
 * (notification delivery quiets a finished-turn alert only for the session
 * being watched): the active chat key and conversation, and that chat's
 * current execution session. Empty when no chat is on screen (dock closed
 * with no full-screen Chat, or covered by an opaque reader). Visibility is
 * the report's own `state`, so it is not checked here.
 */
export function foregroundChatSessionIds(): string[] {
  const navigation = navigationStore.getSnapshot();
  if (!navigation.isDockOpen && fullscreenChatSurfaces === 0) return [];
  if (chatReaderCovers > 0) return [];
  const ids = new Set<string>();
  const add = (id: string | undefined) => {
    if (id && VIEWING_ID_PATTERN.test(id)) ids.add(id);
  };
  // The execution session first: it is what a turn's notification names,
  // and the bound below must not cut it.
  for (const [chatKey, chat] of Object.entries(
    activeChatsStore.getSnapshot(),
  )) {
    const matches = [chatKey, chat.currentSessionId, chat.conversationId].some(
      (id) =>
        id !== undefined &&
        id !== null &&
        (navigation.activeChat === id || navigation.activeConversation === id),
    );
    if (!matches) continue;
    add(chat.currentSessionId ?? undefined);
    add(chat.conversationId ?? undefined);
    add(chatKey);
  }
  add(navigation.activeChat ?? undefined);
  add(navigation.activeConversation ?? undefined);
  return [...ids].slice(0, VIEWING_IDS_MAX);
}

/** Calls `listener` whenever what {@link foregroundChatSessionIds} reads may have changed. */
export function subscribeForegroundChat(listener: () => void): () => void {
  const offNavigation = navigationStore.subscribe(listener);
  const offChats = activeChatsStore.subscribe(listener);
  const surface = () => listener();
  surfaceListeners.add(surface);
  return () => {
    offNavigation();
    offChats();
    surfaceListeners.delete(surface);
  };
}
