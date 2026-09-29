import { activeChatsStore } from '../../contexts/active-chats-store';
import { navigationStore } from '../../contexts/navigation-store';
import type { WorkspacePaneFailureContext } from '../../workspace-panes/WorkspacePaneFailure';

/**
 * The Chat pane's side of a renderer crash: which conversation was open, a
 * way to close it, and a way to minimize the dock (the pane's own header, with
 * its collapse control, went down with the pane).
 *
 * The open conversation is the URL's `chat` parameter, and a remounted Chat
 * pane reopens it (`useChatDockActiveChatSync`). So when the crash is specific
 * to that conversation, a plain retry reopens the same conversation and
 * crashes again; closing it is the recovery a retry cannot give. The pane then
 * opens on its "No chat open" state (the chat list is one tap away in its
 * header), which is why the action is named for what it does.
 *
 * The host calls this once, when the pane fails, and keeps the result: the
 * conversation id is captured here, so if another chat is opened elsewhere
 * while the failure is on screen, Close only ever closes the one that failed.
 */
export function ambientChatPaneFailureContext():
  | WorkspacePaneFailureContext
  | undefined {
  const navigation = navigationStore.getSnapshot();
  const failedChat = navigation.activeChat;
  const dismiss = {
    label: 'Minimize',
    onDismiss: () => navigationStore.setDockState(false, false),
  };
  if (!failedChat) return { dismiss };
  const open = Object.entries(activeChatsStore.getSnapshot()).find(
    ([storeId, chat]) =>
      storeId === failedChat || chat.conversationId === failedChat,
  )?.[1];
  // Derived titles arrive as plain text (the server strips the markdown of
  // the first message they come from); the screen renders it as text.
  const title = open?.title?.trim();
  return {
    ...(title ? { subject: { label: 'Chat', name: title } } : {}),
    back: {
      label: 'Close this chat',
      onBack: () => {
        if (navigationStore.getSnapshot().activeChat === failedChat) {
          navigationStore.setActiveChat(null);
        }
      },
    },
    dismiss,
  };
}
